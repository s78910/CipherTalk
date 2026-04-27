import { aiDatabase } from '../ai/aiDatabase'
import type { AnalysisMemoryBlockRow, AnalysisMemoryFactRow } from '../ai/aiDatabase'
import { chatSearchIndexService, type ChatSearchMemoryMessage } from '../search/chatSearchIndexService'
import { hashMemoryContent, memoryDatabase } from './memoryDatabase'
import type {
  MemoryEvidenceRef,
  MemoryItemInput,
  SessionMemoryBuildProgressEvent,
  SessionMemoryBuildProgressStage,
  SessionMemoryBuildResult,
  SessionMemoryBuildState
} from './memorySchema'

type MemoryBuildTask = {
  promise: Promise<SessionMemoryBuildState>
  state: SessionMemoryBuildState
}

type StandardizedBlockMessage = {
  localId?: number
  createTime?: number
  sortSeq?: number
  senderUsername?: string
  content?: string
}

const MEMORY_PROGRESS_BATCH_SIZE = 50
const MEMORY_PROGRESS_MIN_INTERVAL_MS = 250
const MEMORY_TEXT_LIMIT = 8000

function compactText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function isGroupSession(sessionId: string): boolean {
  return sessionId.includes('@chatroom')
}

function messageMemoryUid(sessionId: string, message: Pick<ChatSearchMemoryMessage, 'localId' | 'createTime' | 'sortSeq'>): string {
  return `message:${sessionId}:${message.localId}:${message.createTime}:${message.sortSeq}`
}

function blockMemoryUid(block: AnalysisMemoryBlockRow): string {
  return `conversation_block:${block.sessionId}:${block.runId}:${block.blockId || block.blockIndex}:${block.id}`
}

function factMemoryUid(fact: AnalysisMemoryFactRow): string {
  return `fact:${fact.sessionId}:${fact.runId}:${fact.factType}:${fact.factKey || fact.id}:${fact.id}`
}

function shouldReportProgress(processed: number, total: number, lastReportAt: number): boolean {
  if (processed >= total) return true
  if (processed % MEMORY_PROGRESS_BATCH_SIZE === 0) return true
  return Date.now() - lastReportAt >= MEMORY_PROGRESS_MIN_INTERVAL_MS
}

function buildSessionRefs(sessionId: string): Pick<MemoryItemInput, 'sessionId' | 'contactId' | 'groupId'> {
  return {
    sessionId,
    contactId: isGroupSession(sessionId) ? null : sessionId,
    groupId: isGroupSession(sessionId) ? sessionId : null
  }
}

function toMessageEvidenceRef(message: ChatSearchMemoryMessage): MemoryEvidenceRef {
  return {
    sessionId: message.sessionId,
    localId: message.localId,
    createTime: message.createTime,
    sortSeq: message.sortSeq,
    ...(message.senderUsername ? { senderUsername: message.senderUsername } : {}),
    excerpt: compactText(message.parsedContent || message.searchText || message.rawContent, 160)
  }
}

function parseBlockEvidenceRefs(block: AnalysisMemoryBlockRow): MemoryEvidenceRef[] {
  try {
    const parsed = JSON.parse(block.messagesJson || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item: StandardizedBlockMessage): MemoryEvidenceRef | null => {
        const localId = Number(item.localId)
        const createTime = Number(item.createTime)
        const sortSeq = Number(item.sortSeq)
        if (!Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) return null
        return {
          sessionId: block.sessionId,
          localId,
          createTime,
          sortSeq,
          ...(item.senderUsername ? { senderUsername: item.senderUsername } : {}),
          excerpt: compactText(String(item.content || ''), 160)
        }
      })
      .filter((item): item is MemoryEvidenceRef => Boolean(item))
  } catch {
    return []
  }
}

function toFactEvidenceRefs(fact: AnalysisMemoryFactRow): MemoryEvidenceRef[] {
  return fact.evidenceRefs
    .map((ref): MemoryEvidenceRef | null => {
      const sessionId = String(ref.sessionId || fact.sessionId || '').trim()
      const localId = Number(ref.localId)
      const createTime = Number(ref.createTime)
      const sortSeq = Number(ref.sortSeq)
      if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) return null
      return {
        sessionId,
        localId,
        createTime,
        sortSeq,
        ...(ref.senderUsername ? { senderUsername: ref.senderUsername } : {}),
        excerpt: compactText(ref.previewText || '', 160)
      }
    })
    .filter((item): item is MemoryEvidenceRef => Boolean(item))
}

function buildMessageMemoryInput(message: ChatSearchMemoryMessage): MemoryItemInput {
  const content = compactText(message.parsedContent || message.rawContent || message.searchText, MEMORY_TEXT_LIMIT)
  const title = `${message.senderUsername || (message.isSend ? 'self' : 'unknown')} · ${message.createTime || ''}`
  return {
    memoryUid: messageMemoryUid(message.sessionId, message),
    sourceType: 'message',
    ...buildSessionRefs(message.sessionId),
    title,
    content,
    contentHash: hashMemoryContent(title, content),
    tags: ['message'],
    importance: 0,
    confidence: 1,
    timeStart: message.createTime,
    timeEnd: message.createTime,
    sourceRefs: [toMessageEvidenceRef(message)]
  }
}

function buildBlockMemoryInput(block: AnalysisMemoryBlockRow): MemoryItemInput {
  const content = compactText(block.renderedText, MEMORY_TEXT_LIMIT)
  const title = `对话片段 ${block.blockIndex + 1}`
  return {
    memoryUid: blockMemoryUid(block),
    sourceType: 'conversation_block',
    ...buildSessionRefs(block.sessionId),
    title,
    content,
    contentHash: hashMemoryContent(title, content),
    tags: ['conversation_block', `summary:${block.summaryId}`],
    importance: 0.4,
    confidence: 1,
    timeStart: block.startTime || null,
    timeEnd: block.endTime || null,
    sourceRefs: parseBlockEvidenceRefs(block)
  }
}

function buildFactMemoryInput(fact: AnalysisMemoryFactRow): MemoryItemInput {
  const details = [
    fact.owner ? `负责人: ${fact.owner}` : '',
    fact.deadline ? `截止: ${fact.deadline}` : '',
    fact.status ? `状态: ${fact.status}` : '',
    fact.severity ? `级别: ${fact.severity}` : '',
    fact.eventDate ? `日期: ${fact.eventDate}` : ''
  ].filter(Boolean)
  const content = compactText([fact.displayText, ...details].join('\n'), MEMORY_TEXT_LIMIT)
  const title = fact.displayText || fact.factKey || fact.factType
  const tags = [
    'fact',
    fact.factType,
    fact.status || '',
    fact.severity || ''
  ].filter(Boolean)

  return {
    memoryUid: factMemoryUid(fact),
    sourceType: 'fact',
    ...buildSessionRefs(fact.sessionId),
    title,
    content,
    contentHash: hashMemoryContent(title, content),
    entities: [fact.owner || ''].filter(Boolean),
    tags,
    importance: Number(fact.importance ?? 0.6),
    confidence: Number(fact.confidence ?? 0.8),
    timeStart: fact.timeRangeStart || null,
    timeEnd: fact.timeRangeEnd || null,
    sourceRefs: toFactEvidenceRefs(fact)
  }
}

export class MemoryBuildService {
  private tasks = new Map<string, MemoryBuildTask>()

  getSessionState(sessionId: string): SessionMemoryBuildState {
    const running = this.tasks.get(sessionId)?.state
    if (running) return { ...running }

    const messageCount = memoryDatabase.countMemoryItems({ sessionId, sourceType: 'message' })
    const blockCount = memoryDatabase.countMemoryItems({ sessionId, sourceType: 'conversation_block' })
    const factCount = memoryDatabase.countMemoryItems({ sessionId, sourceType: 'fact' })
    const totalCount = messageCount + blockCount + factCount
    return {
      sessionId,
      messageCount,
      blockCount,
      factCount,
      totalCount,
      processedCount: totalCount,
      isRunning: false,
      updatedAt: Date.now()
    }
  }

  async prepareSessionMemory(
    sessionId: string,
    onProgress?: (event: SessionMemoryBuildProgressEvent) => void | Promise<void>
  ): Promise<SessionMemoryBuildState> {
    const existing = this.tasks.get(sessionId)
    if (existing) {
      await onProgress?.(this.toProgress(existing.state, 'preparing', 'running', '当前会话记忆正在构建，复用已有任务'))
      return existing.promise
    }

    const state: SessionMemoryBuildState = {
      sessionId,
      messageCount: 0,
      blockCount: 0,
      factCount: 0,
      totalCount: 0,
      processedCount: 0,
      isRunning: true,
      updatedAt: Date.now()
    }

    const task: MemoryBuildTask = {
      state,
      promise: this.runPrepareSessionMemory(sessionId, state, onProgress)
    }
    this.tasks.set(sessionId, task)
    try {
      return await task.promise
    } finally {
      this.tasks.delete(sessionId)
    }
  }

  private async runPrepareSessionMemory(
    sessionId: string,
    state: SessionMemoryBuildState,
    onProgress?: (event: SessionMemoryBuildProgressEvent) => void | Promise<void>
  ): Promise<SessionMemoryBuildState> {
    try {
      await this.report(state, 'preparing', 'running', '正在准备当前会话记忆构建', onProgress)

      const messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, async (progress) => {
        await this.report(state, 'indexing_messages', 'running', progress.message, onProgress)
      })
      const blocks = this.safeListBlocks(sessionId)
      const facts = this.safeListFacts(sessionId)

      state.totalCount = messages.length + blocks.length + facts.length
      await this.report(state, 'building_messages', 'running', `正在写入 ${messages.length} 条消息记忆`, onProgress)

      state.messageCount = await this.buildMessageMemories(messages, state, onProgress)
      state.blockCount = await this.buildBlockMemories(blocks, state, onProgress)
      state.factCount = await this.buildFactMemories(facts, state, onProgress)

      state.isRunning = false
      state.completedAt = Date.now()
      state.updatedAt = state.completedAt
      state.processedCount = state.messageCount + state.blockCount + state.factCount
      await this.report(state, 'completed', 'completed', `会话记忆已构建：消息 ${state.messageCount}，片段 ${state.blockCount}，事实 ${state.factCount}`, onProgress)
      return { ...state }
    } catch (error) {
      state.isRunning = false
      state.lastError = String(error)
      state.updatedAt = Date.now()
      await this.report(state, 'completed', 'failed', `会话记忆构建失败：${String(error)}`, onProgress)
      throw error
    }
  }

  private safeListBlocks(sessionId: string): AnalysisMemoryBlockRow[] {
    try {
      return aiDatabase.listAnalysisMemoryBlocks(sessionId)
    } catch (error) {
      console.warn('[MemoryBuildService] 读取 analysis_blocks 失败，跳过 block memory:', error)
      return []
    }
  }

  private safeListFacts(sessionId: string): AnalysisMemoryFactRow[] {
    try {
      return aiDatabase.listAnalysisMemoryFacts(sessionId)
    } catch (error) {
      console.warn('[MemoryBuildService] 读取 extracted_facts 失败，跳过 fact memory:', error)
      return []
    }
  }

  private async buildMessageMemories(
    messages: ChatSearchMemoryMessage[],
    state: SessionMemoryBuildState,
    onProgress?: (event: SessionMemoryBuildProgressEvent) => void | Promise<void>
  ): Promise<number> {
    let count = 0
    let lastReportAt = Date.now()
    for (let index = 0; index < messages.length; index += 1) {
      memoryDatabase.upsertMemoryItem(buildMessageMemoryInput(messages[index]))
      count += 1
      state.processedCount += 1
      state.messageCount = count

      if (shouldReportProgress(count, messages.length, lastReportAt)) {
        lastReportAt = Date.now()
        await this.report(state, 'building_messages', 'running', `已写入 ${count}/${messages.length} 条消息记忆`, onProgress)
      }
    }
    return count
  }

  private async buildBlockMemories(
    blocks: AnalysisMemoryBlockRow[],
    state: SessionMemoryBuildState,
    onProgress?: (event: SessionMemoryBuildProgressEvent) => void | Promise<void>
  ): Promise<number> {
    await this.report(state, 'building_blocks', 'running', `正在写入 ${blocks.length} 个对话片段记忆`, onProgress)
    let count = 0
    let lastReportAt = Date.now()
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (block.renderedText.trim()) {
        memoryDatabase.upsertMemoryItem(buildBlockMemoryInput(block))
        count += 1
      }
      state.processedCount += 1
      state.blockCount = count

      const processed = index + 1
      if (shouldReportProgress(processed, blocks.length, lastReportAt)) {
        lastReportAt = Date.now()
        await this.report(state, 'building_blocks', 'running', `已处理 ${processed}/${blocks.length} 个对话片段，写入 ${count} 个`, onProgress)
      }
    }
    await this.report(state, 'building_blocks', 'running', `已写入 ${count}/${blocks.length} 个对话片段记忆`, onProgress)
    return count
  }

  private async buildFactMemories(
    facts: AnalysisMemoryFactRow[],
    state: SessionMemoryBuildState,
    onProgress?: (event: SessionMemoryBuildProgressEvent) => void | Promise<void>
  ): Promise<number> {
    await this.report(state, 'building_facts', 'running', `正在写入 ${facts.length} 条事实记忆`, onProgress)
    let count = 0
    let lastReportAt = Date.now()
    for (let index = 0; index < facts.length; index += 1) {
      const fact = facts[index]
      if (fact.displayText.trim()) {
        memoryDatabase.upsertMemoryItem(buildFactMemoryInput(fact))
        count += 1
      }
      state.processedCount += 1
      state.factCount = count

      const processed = index + 1
      if (shouldReportProgress(processed, facts.length, lastReportAt)) {
        lastReportAt = Date.now()
        await this.report(state, 'building_facts', 'running', `已处理 ${processed}/${facts.length} 条事实，写入 ${count} 条`, onProgress)
      }
    }
    await this.report(state, 'building_facts', 'running', `已写入 ${count}/${facts.length} 条事实记忆`, onProgress)
    return count
  }

  private async report(
    state: SessionMemoryBuildState,
    stage: SessionMemoryBuildProgressStage,
    status: SessionMemoryBuildProgressEvent['status'],
    message: string,
    onProgress?: (event: SessionMemoryBuildProgressEvent) => void | Promise<void>
  ): Promise<void> {
    state.updatedAt = Date.now()
    await onProgress?.(this.toProgress(state, stage, status, message))
  }

  private toProgress(
    state: SessionMemoryBuildState,
    stage: SessionMemoryBuildProgressStage,
    status: SessionMemoryBuildProgressEvent['status'],
    message: string
  ): SessionMemoryBuildProgressEvent {
    return {
      sessionId: state.sessionId,
      stage,
      status,
      processedCount: state.processedCount,
      totalCount: state.totalCount,
      message,
      messageCount: state.messageCount,
      blockCount: state.blockCount,
      factCount: state.factCount
    }
  }
}

export const memoryBuildService = new MemoryBuildService()

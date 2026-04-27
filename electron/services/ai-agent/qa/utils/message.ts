/**
 * Agent 消息格式化、去重、转换工具。
 */
import type { AgentCursor, AgentMemoryRef, AgentMessage, AgentMessageKind, AgentSourceMessage } from '../data/models'
import type { SummaryEvidenceRef } from '../../types/analysis'
import { agentDataRepository } from '../data/repository'
import { detectAgentMessageKind } from '../data/textParser'
import { MAX_MESSAGE_TEXT } from '../types'
import { compactText } from './text'
import { formatTime } from './time'

export function detectQaMessageKind(message: Pick<AgentSourceMessage, 'localType' | 'rawContent' | 'parsedContent'>): AgentMessageKind {
  return detectAgentMessageKind(message)
}

export function sourceMessageToAgentMessage(sessionId: string, message: AgentSourceMessage, contactMap?: Map<string, string>): AgentMessage {
  return agentDataRepository.sourceToAgentMessage(sessionId, message, contactMap)
}

export function evidenceRefToAgentMessage(ref: SummaryEvidenceRef | AgentMemoryRef, contactMap?: Map<string, string>): AgentMessage {
  return agentDataRepository.evidenceRefToMessage({
    sessionId: ref.sessionId,
    localId: ref.localId,
    createTime: ref.createTime,
    sortSeq: ref.sortSeq,
    senderUsername: 'senderUsername' in ref ? ref.senderUsername : undefined,
    excerpt: 'previewText' in ref ? ref.previewText : ref.excerpt
  }, contactMap)
}

export function describeSender(message: AgentMessage): string {
  if (message.sender.isSelf) return '我'
  return message.sender.displayName || message.sender.username || '对方'
}

export function formatMessageLine(message: AgentMessage): string {
  const text = compactText(message.text, MAX_MESSAGE_TEXT) || `[${message.kind}]`
  return `- ${formatTime(message.timestampMs)} | ${describeSender(message)} | ${text}`
}

export function toEvidenceRef(sessionId: string, message: AgentMessage, preview?: string): SummaryEvidenceRef | null {
  if (!message.cursor) return null
  return {
    sessionId,
    localId: message.cursor.localId,
    createTime: message.cursor.createTime,
    sortSeq: message.cursor.sortSeq,
    senderUsername: message.sender.username || undefined,
    senderDisplayName: describeSender(message),
    previewText: compactText(preview || message.text, 180) || `[${message.kind}]`
  }
}

export function dedupeEvidenceRefs(items: SummaryEvidenceRef[]): SummaryEvidenceRef[] {
  const seen = new Set<string>()
  const result: SummaryEvidenceRef[] = []
  for (const item of items) {
    const key = `${item.localId}:${item.createTime}:${item.sortSeq}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= 8) break
  }
  return result
}

export function getMessageCursorKey(message: AgentMessage): string {
  return `${message.cursor.localId}:${message.cursor.createTime}:${message.cursor.sortSeq}`
}

export function dedupeMessagesByCursor(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Set<string>()
  const result: AgentMessage[] = []
  for (const message of messages) {
    const key = getMessageCursorKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(message)
  }
  return result.sort((a, b) => {
    if (a.cursor.sortSeq !== b.cursor.sortSeq) return a.cursor.sortSeq - b.cursor.sortSeq
    if (a.cursor.createTime !== b.cursor.createTime) return a.cursor.createTime - b.cursor.createTime
    return a.cursor.localId - b.cursor.localId
  })
}

export function formatCursor(cursor: AgentCursor): string {
  return `{"localId":${cursor.localId},"createTime":${cursor.createTime},"sortSeq":${cursor.sortSeq}}`
}

export function participantMatches(query: string, message: AgentMessage): boolean {
  const normalized = query.toLowerCase()
  if (!normalized) return false
  return [
    message.sender.displayName || '',
    message.sender.username || '',
    message.sender.isSelf ? '我' : ''
  ].some((value) => {
    const candidate = value.toLowerCase()
    return Boolean(candidate) && (candidate.includes(normalized) || normalized.includes(candidate))
  })
}

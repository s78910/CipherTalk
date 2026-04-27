import type OpenAI from 'openai'
import type { AIProvider } from '../../ai/providers/base'
import { executeMcpTool } from '../../mcp/dispatcher'
import type {
  McpContactsPayload,
  McpCursor,
  McpKeywordStatisticsPayload,
  McpMessageKind,
  McpMessageItem,
  McpMessagesPayload,
  McpSearchHit,
  McpSearchMessagesPayload,
  McpSessionContextPayload,
  McpSessionStatisticsPayload
} from '../../mcp/types'
import type { Message } from '../../chatService'
import { retrievalEngine } from '../../retrieval/retrievalEngine'
import type { RetrievalEngineResult, RetrievalExpandedEvidence, RetrievalHit } from '../../retrieval/retrievalTypes'
import type { StructuredAnalysis, SummaryEvidenceRef } from '../types/analysis'

export interface SessionQAHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionQAToolCall {
  toolName: SessionQAToolName
  args: Record<string, unknown>
  summary: string
  status?: 'running' | 'completed' | 'failed' | 'cancelled'
  durationMs?: number
  evidenceCount?: number
}

export type SessionQAToolName =
  | 'read_summary_facts'
  | 'read_latest'
  | 'read_by_time_range'
  | 'resolve_participant'
  | 'search_messages'
  | 'read_context'
  | 'aggregate_messages'
  | 'get_session_statistics'
  | 'get_keyword_statistics'
  | 'answer'
  | 'get_session_context'
  | 'prepare_vector_index'

export type SessionQAProgressStage = 'intent' | 'tool' | 'context' | 'answer'
export type SessionQAProgressStatus = 'running' | 'completed' | 'failed'
export type SessionQAProgressSource = 'summary' | 'chat' | 'search_index' | 'vector' | 'aggregate' | 'model'

export interface SessionQAProgressEvent {
  id: string
  stage: SessionQAProgressStage
  status: SessionQAProgressStatus
  title: string
  detail?: string
  toolName?: SessionQAToolCall['toolName']
  query?: string
  count?: number
  createdAt: number
  requestId?: string
  source?: SessionQAProgressSource
  elapsedMs?: number
  diagnostics?: string[]
}

export interface SessionQAAgentOptions {
  sessionId: string
  sessionName?: string
  question: string
  summaryText?: string
  structuredAnalysis?: StructuredAnalysis
  history?: SessionQAHistoryMessage[]
  provider: AIProvider
  model: string
  enableThinking?: boolean
  agentDecisionMaxTokens?: number
  agentAnswerMaxTokens?: number
  onChunk: (chunk: string) => void
  onProgress?: (event: SessionQAProgressEvent) => void
}

export interface SessionQAAgentResult {
  answerText: string
  evidenceRefs: SummaryEvidenceRef[]
  toolCalls: SessionQAToolCall[]
  promptText: string
}

const MAX_CONTEXT_MESSAGES = 40
const MAX_SEARCH_QUERIES = 6
const MAX_SEARCH_HITS = 8
const MAX_CONTEXT_WINDOWS = 4
const SEARCH_CONTEXT_BEFORE = 6
const SEARCH_CONTEXT_AFTER = 6
const MAX_TOOL_CALLS = 10
const MAX_TOOL_DECISION_ATTEMPTS = 14
const MAX_SEARCH_RETRIES = 2
const MAX_HISTORY_MESSAGES = 8
const MAX_SUMMARY_CHARS = 3000
const MAX_STRUCTURED_CHARS = 4000
const MAX_MESSAGE_TEXT = 220
const MAX_REWRITE_INPUT_CHARS = 800
const MAX_REWRITE_KEYWORD_QUERIES = 4
const MAX_REWRITE_SEMANTIC_QUERIES = 3
const MAX_RETRIEVAL_EXPLAIN_TOP_K = 5
const DEFAULT_AGENT_DECISION_MAX_TOKENS = 2048
const DEFAULT_AGENT_ANSWER_MAX_TOKENS = 8192
const MAX_AGENT_DECISION_MAX_TOKENS = 32768
const MAX_AGENT_ANSWER_MAX_TOKENS = 65536

type SearchPayloadWithQuery = { query: string; payload: McpSearchMessagesPayload }
type SearchHitWithQuery = McpSearchMessagesPayload['hits'][number] & { query: string }
type KnownSearchHit = SearchHitWithQuery & { hitId: string }
type ContextWindow = {
  source: 'search' | 'latest' | 'time_range'
  query?: string
  label?: string
  anchor?: McpMessageItem
  messages: McpMessageItem[]
}
type ToolObservation = {
  title: string
  detail: string
}
type SearchFailureReason =
  | 'content_not_found'
  | 'vector_unavailable'
  | 'keyword_miss_only'
type QueryRewriteResult = {
  applied: boolean
  semanticQuery?: string
  keywordQueries: string[]
  semanticQueries: string[]
  reason?: string
  diagnostics: string[]
}
type SessionQAIntentType =
  | 'direct_answer'
  | 'summary_answerable'
  | 'recent_status'
  | 'time_range'
  | 'participant_focus'
  | 'exact_evidence'
  | 'media_or_file'
  | 'broad_summary'
  | 'stats_or_count'
  | 'unclear'
type TimeRangeHint = {
  startTime?: number
  endTime?: number
  label?: string
}
type ParticipantResolution = {
  query: string
  senderUsername?: string
  displayName?: string
  confidence: 'high' | 'medium' | 'low'
  source: 'observed' | 'contacts' | 'fallback'
}
type IntentRoute = {
  intent: SessionQAIntentType
  confidence: 'high' | 'medium' | 'low'
  reason?: string
  timeRange?: TimeRangeHint
  participantHints: string[]
  searchQueries: string[]
  needsSearch: boolean
  preferredPlan: ToolLoopAction['action'][]
}
type ToolLoopAction =
  | { action: 'read_summary_facts'; reason?: string }
  | { action: 'search_messages'; query: string; reason?: string }
  | { action: 'read_context'; hitId?: string; cursor?: McpCursor; beforeLimit?: number; afterLimit?: number; reason?: string }
  | { action: 'read_latest'; limit?: number; reason?: string }
  | { action: 'read_by_time_range'; startTime?: number; endTime?: number; label?: string; limit?: number; keyword?: string; senderUsername?: string; participantName?: string; reason?: string }
  | { action: 'resolve_participant'; name?: string; reason?: string }
  | { action: 'aggregate_messages'; metric?: 'speaker_count' | 'message_count' | 'kind_count' | 'timeline' | 'summary'; reason?: string }
  | { action: 'get_session_statistics'; startTime?: number; endTime?: number; label?: string; participantLimit?: number; includeSamples?: boolean; reason?: string }
  | { action: 'get_keyword_statistics'; keywords: string[]; startTime?: number; endTime?: number; label?: string; matchMode?: 'substring' | 'exact'; participantLimit?: number; reason?: string }
  | { action: 'answer'; reason?: string }

function compactText(value?: string, limit = MAX_MESSAGE_TEXT): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function buildProgressEvent(
  event: Omit<SessionQAProgressEvent, 'createdAt'>
): SessionQAProgressEvent {
  return {
    ...event,
    createdAt: Date.now(),
    source: event.source || inferProgressSource(event)
  }
}

function inferProgressSource(event: Omit<SessionQAProgressEvent, 'createdAt'>): SessionQAProgressSource {
  if (event.stage === 'answer') return 'model'
  switch (event.toolName) {
    case 'read_summary_facts':
      return 'summary'
    case 'search_messages':
    case 'read_context':
      return 'search_index'
    case 'prepare_vector_index':
      return 'vector'
    case 'aggregate_messages':
    case 'get_session_statistics':
    case 'get_keyword_statistics':
      return 'aggregate'
    default:
      return 'chat'
  }
}

function emitProgress(
  options: SessionQAAgentOptions,
  event: Omit<SessionQAProgressEvent, 'createdAt'>
) {
  options.onProgress?.(buildProgressEvent(event))
}

function filterThinkChunk(chunk: string, state: { isThinking: boolean }): string {
  let remaining = chunk
  let visible = ''

  while (remaining.length > 0) {
    if (state.isThinking) {
      const closeIndex = remaining.indexOf('</think>')
      if (closeIndex < 0) {
        break
      }

      state.isThinking = false
      remaining = remaining.slice(closeIndex + '</think>'.length)
      continue
    }

    const openIndex = remaining.indexOf('<think>')
    if (openIndex < 0) {
      visible += remaining
      break
    }

    visible += remaining.slice(0, openIndex)
    state.isThinking = true
    remaining = remaining.slice(openIndex + '<think>'.length)
  }

  return visible
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function formatTime(timestampMs: number): string {
  if (!timestampMs) return 'unknown'
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function toTimestampMs(timestamp: number): number {
  if (!timestamp) return 0
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000
}

function detectQaMessageKind(message: Pick<Message, 'localType' | 'rawContent' | 'parsedContent'>): McpMessageKind {
  const localType = Number(message.localType || 0)
  const raw = String(message.rawContent || message.parsedContent || '')
  const appTypeMatch = raw.match(/<type>(\d+)<\/type>/)
  const appMsgType = appTypeMatch?.[1]

  if (localType === 1) return 'text'
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 42) return 'contact_card'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 48) return 'location'
  if (localType === 50) return 'voip'
  if (localType === 10000 || localType === 10002) return 'system'
  if (localType === 244813135921) return 'quote'

  if (localType === 49 || appMsgType) {
    switch (appMsgType) {
      case '3':
        return 'app_music'
      case '5':
      case '49':
        return 'app_link'
      case '6':
        return 'app_file'
      case '19':
        return 'app_chat_record'
      case '33':
      case '36':
        return 'app_mini_program'
      case '57':
        return 'app_quote'
      case '62':
        return 'app_pat'
      case '87':
        return 'app_announcement'
      case '115':
        return 'app_gift'
      case '2000':
        return 'app_transfer'
      case '2001':
        return 'app_red_packet'
      default:
        return 'app'
    }
  }

  return 'unknown'
}

function messageToMcpItem(sessionId: string, message: Message): McpMessageItem {
  const direction = Number(message.isSend) === 1 ? 'out' : 'in'
  return {
    messageId: Number(message.localId || message.serverId || 0),
    timestamp: Number(message.createTime || 0),
    timestampMs: toTimestampMs(Number(message.createTime || 0)),
    direction,
    kind: detectQaMessageKind(message),
    text: String(message.parsedContent || message.rawContent || ''),
    sender: {
      username: message.senderUsername ?? null,
      displayName: direction === 'out' ? '我' : (message.senderUsername || (sessionId.includes('@chatroom') ? null : sessionId)),
      isSelf: direction === 'out'
    },
    cursor: {
      localId: Number(message.localId || 0),
      createTime: Number(message.createTime || 0),
      sortSeq: Number(message.sortSeq || 0)
    }
  }
}

function evidenceRefToMcpItem(ref: SummaryEvidenceRef | RetrievalExpandedEvidence['ref']): McpMessageItem {
  const createTime = Number(ref.createTime || 0)
  const senderUsername = 'senderUsername' in ref ? ref.senderUsername : undefined
  const previewText = 'previewText' in ref ? ref.previewText : ('excerpt' in ref ? ref.excerpt : '')
  return {
    messageId: Number(ref.localId || 0),
    timestamp: createTime,
    timestampMs: toTimestampMs(createTime),
    direction: 'in',
    kind: 'text',
    text: String(previewText || ''),
    sender: {
      username: senderUsername || null,
      displayName: senderUsername || null,
      isSelf: false
    },
    cursor: {
      localId: Number(ref.localId || 0),
      createTime,
      sortSeq: Number(ref.sortSeq || 0)
    }
  }
}

function describeSender(message: McpMessageItem): string {
  if (message.sender.isSelf) return '我'
  return message.sender.displayName || message.sender.username || '对方'
}

function formatMessageLine(message: McpMessageItem): string {
  const text = compactText(message.text, MAX_MESSAGE_TEXT) || `[${message.kind}]`
  return `- ${formatTime(message.timestampMs)} | ${describeSender(message)} | ${text}`
}

function toEvidenceRef(sessionId: string, message: McpMessageItem, preview?: string): SummaryEvidenceRef | null {
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

function dedupeEvidenceRefs(items: SummaryEvidenceRef[]): SummaryEvidenceRef[] {
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

function getMessageCursorKey(message: McpMessageItem): string {
  return `${message.cursor.localId}:${message.cursor.createTime}:${message.cursor.sortSeq}`
}

function dedupeMessagesByCursor(messages: McpMessageItem[]): McpMessageItem[] {
  const seen = new Set<string>()
  const result: McpMessageItem[] = []

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

function dedupeSearchHits(hits: SearchHitWithQuery[]): SearchHitWithQuery[] {
  const seen = new Set<string>()
  const result: SearchHitWithQuery[] = []

  for (const hit of hits) {
    const key = getMessageCursorKey(hit.message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(hit)
  }

  return result.sort((a, b) => b.score - a.score || b.message.timestampMs - a.message.timestampMs)
}

function normalizeSearchQuery(value: string, limit = 32): string {
  return compactText(value, limit)
    .replace(/[？?！!。，,；;：:"“”‘’()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCompactQuestion(value: string): string {
  return normalizeSearchQuery(value, 120).replace(/\s+/g, '')
}

function isGenericSearchQuery(value: string): boolean {
  const normalized = normalizeSearchQuery(value).replace(/\s+/g, '')
  if (!normalized) return true
  return /^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|刚刚|刚才|我们|他们|对方|是否|有没有|是不是|可以|看到|知道|消息|聊天|内容|问题|回复|回答)$/.test(normalized)
}

function isQuestionLikeSearchQuery(value: string): boolean {
  const normalized = normalizeCompactQuestion(value)
  if (!normalized) return true
  return /^(谁|哪个人|哪位|有没有人|有没有谁|有没有|是否|是否有人|我们|他们|大家|群里|这个聊天|这段聊天|当前|现在|最近)/.test(normalized)
    || /(吗|么|呢|啊|呀|吧|没有|没|是什么|怎么回事|多少|几次|哪条)$/.test(normalized)
}

function stripSearchTermNoise(value: string): string {
  let text = normalizeSearchQuery(value, 48).replace(/\s+/g, '')
  text = text
    .replace(/^(关于|有关|围绕|那个|这个|一下|下|用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)/, '')
    .replace(/(的人|的情况|的消息|这件事|这事|相关内容|相关消息|吗|么|呢|啊|呀|吧|了|没有|没)$/g, '')
    .replace(/(谁|哪个人|哪位|什么时候|多少|几次|次数|频率|排行|最多|最少).*$/g, '')
  return normalizeSearchQuery(text, 48)
}

function pushSearchTerm(target: string[], value: string) {
  const term = stripSearchTermNoise(value)
  if (!term || isGenericSearchQuery(term) || isQuestionLikeSearchQuery(term)) return
  target.push(term)
}

function extractConcreteSearchTerms(question: string): string[] {
  const normalized = normalizeSearchQuery(question, 160)
  const terms: string[] = []

  const quotedPattern = /["“'‘]([^"”'’]{2,48})["”'’]/g
  let quotedMatch: RegExpExecArray | null
  while ((quotedMatch = quotedPattern.exec(question))) {
    pushSearchTerm(terms, quotedMatch[1])
  }

  const latinPattern = /[A-Za-z][A-Za-z0-9._+#-]{1,}/g
  let latinMatch: RegExpExecArray | null
  while ((latinMatch = latinPattern.exec(normalized))) {
    const token = latinMatch[0]
    if (/^(http|https|www)$/i.test(token)) continue
    pushSearchTerm(terms, token)
  }

  const compact = normalizeCompactQuestion(question)
  const verbPattern = /(用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)(.{2,32})/g
  let verbMatch: RegExpExecArray | null
  while ((verbMatch = verbPattern.exec(compact))) {
    pushSearchTerm(terms, verbMatch[2])
  }

  const aboutPattern = /(关于|有关|围绕)(.{2,32})/g
  let aboutMatch: RegExpExecArray | null
  while ((aboutMatch = aboutPattern.exec(compact))) {
    pushSearchTerm(terms, aboutMatch[2])
  }

  const seen = new Set<string>()
  return terms.filter((term) => {
    const key = term.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_SEARCH_QUERIES)
}

function scoreSearchQuery(query: string, question: string): number {
  const normalized = normalizeCompactQuestion(query)
  const normalizedQuestion = normalizeCompactQuestion(question)
  if (!normalized || isGenericSearchQuery(query)) return -100

  let score = 0
  if (/[A-Za-z0-9]/.test(normalized)) score += 8
  if (/^[\u4e00-\u9fa5A-Za-z0-9._+#-]{2,20}$/.test(normalized)) score += 4
  if (normalizedQuestion.includes(normalized)) score += 2
  if (normalized.length >= 2 && normalized.length <= 16) score += 2
  if (isQuestionLikeSearchQuery(query)) score -= 8
  if (normalized === normalizedQuestion) score -= 10
  return score
}

function expandSearchQueries(question: string, modelQueries: string[]): string[] {
  const candidates: string[] = []
  const push = (value: string) => {
    const query = normalizeSearchQuery(value)
    if (!query || isGenericSearchQuery(query)) return
    candidates.push(query)
  }

  for (const query of modelQueries) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  for (const query of extractConcreteSearchTerms(question)) {
    push(query)
  }

  for (const query of extractHeuristicQueries(question)) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const query of candidates) {
    const normalized = query.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(query)
    if (unique.length >= MAX_SEARCH_QUERIES) break
  }

  return unique
    .sort((a, b) => scoreSearchQuery(b, question) - scoreSearchQuery(a, question))
    .slice(0, MAX_SEARCH_QUERIES)
}

function mergeSearchQueriesForQuestion(question: string, ...groups: string[][]): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const group of groups) {
    for (const query of expandSearchQueries(question, group)) {
      const key = query.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      queries.push(query)
    }
  }
  return queries
    .sort((a, b) => scoreSearchQuery(b, question) - scoreSearchQuery(a, question))
    .slice(0, MAX_SEARCH_QUERIES)
}

function isConcreteEvidenceQuestion(question: string, queries: string[]): boolean {
  if (!queries.some((query) => !isGenericSearchQuery(query) && !isQuestionLikeSearchQuery(query))) return false
  const compact = normalizeCompactQuestion(question)
  return /(谁|哪个人|哪位|有没有人|有没有谁|有没有|是否|是否有人|哪条|原文)/.test(compact)
    || /(用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)/.test(compact)
}

function getFirstConcreteQuery(question: string, queries: string[]): string {
  return mergeSearchQueriesForQuestion(question, queries).find((query) => !isGenericSearchQuery(query) && !isQuestionLikeSearchQuery(query)) || ''
}

function isKeywordEvidenceStatisticsQuestion(question: string, firstQuery: string): boolean {
  if (!firstQuery) return false
  const compact = normalizeCompactQuestion(question)
  if (/(图片|照片|语音|视频|表情|文件|链接|红包|转账|说话最多|发言最多|谁.*最多|谁.*最少|活跃|几点|什么时候|多少条|总共|总量|类型)/.test(compact)) {
    return false
  }
  return /(关键词|这个词|这个短语|出现|提到|提及|说过|包含|几次|次数|频率|谁.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|哪个人.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|哪位.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|有没有.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|是否.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过))/.test(compact)
}

function extractHeuristicQueries(question: string): string[] {
  const normalized = question
    .replace(/[？?！!。，,；;：:"“”‘’()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const concreteTerms = extractConcreteSearchTerms(question)
  if (concreteTerms.length > 0) {
    return concreteTerms
  }

  const words = normalized
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|我们|他们|对方|是否|有没有|是不是)$/.test(item))

  if (words.length > 0) {
    return words.slice(0, MAX_SEARCH_QUERIES)
  }

  const compact = normalized.replace(/\s+/g, '')
  if (compact.length >= 4) {
    return [compact.slice(0, Math.min(8, compact.length))]
  }

  return []
}

function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000)
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function endOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function applyDayPart(range: TimeRangeHint, question: string): TimeRangeHint {
  if (!range.startTime || !range.endTime) return range
  const start = new Date(range.startTime * 1000)
  const end = new Date(range.startTime * 1000)
  let matched = false

  if (/(凌晨|半夜)/.test(question)) {
    start.setHours(0, 0, 0, 0)
    end.setHours(5, 59, 59, 999)
    matched = true
  } else if (/早上|上午/.test(question)) {
    start.setHours(6, 0, 0, 0)
    end.setHours(11, 59, 59, 999)
    matched = true
  } else if (/中午/.test(question)) {
    start.setHours(11, 0, 0, 0)
    end.setHours(13, 59, 59, 999)
    matched = true
  } else if (/下午/.test(question)) {
    start.setHours(12, 0, 0, 0)
    end.setHours(17, 59, 59, 999)
    matched = true
  } else if (/晚上|夜里/.test(question)) {
    start.setHours(18, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    matched = true
  }

  if (!matched) return range
  return {
    ...range,
    startTime: toUnixSeconds(start),
    endTime: toUnixSeconds(end),
    label: `${range.label || '指定日期'}${question.match(/凌晨|半夜|早上|上午|中午|下午|晚上|夜里/)?.[0] || ''}`
  }
}

function inferTimeRangeFromQuestion(question: string, now = new Date()): TimeRangeHint | undefined {
  const normalized = question.replace(/\s+/g, '')
  let range: TimeRangeHint | undefined

  if (/前天/.test(normalized)) {
    const date = shiftDays(now, -2)
    range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: '前天' }
  } else if (/昨天|昨日/.test(normalized)) {
    const date = shiftDays(now, -1)
    range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: '昨天' }
  } else if (/今天|今日/.test(normalized)) {
    range = { startTime: toUnixSeconds(startOfDay(now)), endTime: toUnixSeconds(endOfDay(now)), label: '今天' }
  } else if (/上周/.test(normalized)) {
    const day = now.getDay() || 7
    const thisMonday = shiftDays(startOfDay(now), 1 - day)
    const lastMonday = shiftDays(thisMonday, -7)
    const lastSunday = shiftDays(lastMonday, 6)
    range = { startTime: toUnixSeconds(lastMonday), endTime: toUnixSeconds(endOfDay(lastSunday)), label: '上周' }
  } else if (/本周|这周/.test(normalized)) {
    const day = now.getDay() || 7
    const thisMonday = shiftDays(startOfDay(now), 1 - day)
    range = { startTime: toUnixSeconds(thisMonday), endTime: toUnixSeconds(endOfDay(now)), label: '本周' }
  } else if (/上个月|上月/.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    range = { startTime: toUnixSeconds(start), endTime: toUnixSeconds(end), label: '上个月' }
  } else if (/这个月|本月/.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    range = { startTime: toUnixSeconds(start), endTime: toUnixSeconds(endOfDay(now)), label: '本月' }
  }

  const dateMatch = normalized.match(/(\d{1,2})[月/-](\d{1,2})[日号]?/)
  if (!range && dateMatch) {
    const month = Number(dateMatch[1])
    const day = Number(dateMatch[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(now.getFullYear(), month - 1, day)
      range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: `${month}月${day}日` }
    }
  }

  return range ? applyDayPart(range, question) : undefined
}

function normalizeStringArray(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = compactText(String(item || ''), 48)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function buildDefaultPreferredPlan(intent: SessionQAIntentType): ToolLoopAction['action'][] {
  switch (intent) {
    case 'direct_answer':
      return ['answer']
    case 'summary_answerable':
      return ['read_summary_facts', 'answer']
    case 'recent_status':
      return ['read_summary_facts', 'get_session_statistics', 'read_latest', 'answer']
    case 'time_range':
      return ['read_by_time_range', 'aggregate_messages', 'answer']
    case 'participant_focus':
      return ['resolve_participant', 'read_by_time_range', 'answer']
    case 'exact_evidence':
      return ['search_messages', 'read_context', 'answer']
    case 'media_or_file':
      return ['search_messages', 'read_context', 'answer']
    case 'broad_summary':
      return ['read_summary_facts', 'get_session_statistics', 'read_latest', 'aggregate_messages', 'answer']
    case 'stats_or_count':
      return ['get_session_statistics', 'answer']
    default:
      return ['read_summary_facts', 'get_session_statistics', 'read_latest', 'answer']
  }
}

function routeFromHeuristics(question: string, summaryText?: string): IntentRoute {
  const timeRange = inferTimeRangeFromQuestion(question)
  const hasSummary = Boolean(stripThinkBlocks(summaryText || '').trim())
  const queries = mergeSearchQueriesForQuestion(question, extractHeuristicQueries(question))
  const firstQuery = getFirstConcreteQuery(question, queries)
  const concreteEvidenceQuestion = isConcreteEvidenceQuestion(question, queries)
  const keywordEvidenceStats = isKeywordEvidenceStatisticsQuestion(question, firstQuery)
  const participantHints = extractHeuristicQueries(question)
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(0, 2)

  let intent: SessionQAIntentType = 'unclear'
  if (keywordEvidenceStats) {
    intent = 'stats_or_count'
  } else if (/(谁.*(最多|最少|发言|说话|次数)|多少条|几条|统计|次数|频率|排行)/.test(question)) {
    intent = 'stats_or_count'
  } else if (concreteEvidenceQuestion) {
    intent = 'exact_evidence'
  } else if (timeRange) {
    intent = 'time_range'
  } else if (/(总结|概括|关系|变化|趋势|梳理|复盘)/.test(question)) {
    intent = hasSummary ? 'summary_answerable' : 'broad_summary'
  } else if (/(文件|链接|图片|照片|视频|语音|表情|附件|http|www\.)/i.test(question)) {
    intent = 'media_or_file'
  } else if (/(有没有|是否|说过|提到|原文|哪条|React|Markdown)/i.test(question)) {
    intent = 'exact_evidence'
  } else if (/(谁|哪个人|他说|她说|发了什么|说了什么)/.test(question)) {
    intent = 'participant_focus'
  } else if (!firstQuery && /(最近|刚刚|刚才|最新|现在|当前|前面|上面|最后)/.test(question)) {
    intent = 'recent_status'
  } else if (firstQuery) {
    intent = 'exact_evidence'
  } else if (!firstQuery && !timeRange && question.length <= 16) {
    intent = 'direct_answer'
  } else if (hasSummary) {
    intent = 'summary_answerable'
  }

  return {
    intent,
    confidence: 'medium',
    reason: '本地启发式路由',
    timeRange,
    participantHints,
    searchQueries: queries,
    needsSearch: intent === 'exact_evidence' || keywordEvidenceStats,
    preferredPlan: keywordEvidenceStats
      ? ['get_keyword_statistics', 'search_messages', 'read_context', 'answer']
      : buildDefaultPreferredPlan(intent)
  }
}

function enforceConcreteEvidenceRoute(route: IntentRoute, question: string): IntentRoute {
  if (route.intent === 'direct_answer') {
    return {
      ...route,
      searchQueries: [],
      needsSearch: false,
      preferredPlan: ['answer']
    }
  }

  const searchQueries = mergeSearchQueriesForQuestion(question, route.searchQueries, extractHeuristicQueries(question))
  const firstQuery = getFirstConcreteQuery(question, searchQueries)
  const concreteEvidenceQuestion = isConcreteEvidenceQuestion(question, searchQueries)
  const keywordEvidenceStats = isKeywordEvidenceStatisticsQuestion(question, firstQuery)

  if (!concreteEvidenceQuestion && !keywordEvidenceStats) {
    return {
      ...route,
      searchQueries
    }
  }

  const preferredPlan: ToolLoopAction['action'][] = keywordEvidenceStats
    ? ['get_keyword_statistics', 'search_messages', 'read_context', 'answer']
    : ['search_messages', 'read_context', 'answer']
  const intent: SessionQAIntentType = keywordEvidenceStats
    ? 'stats_or_count'
    : route.intent === 'media_or_file'
      ? 'media_or_file'
      : 'exact_evidence'

  return {
    ...route,
    intent,
    reason: route.intent === intent
      ? route.reason
      : `${route.reason || '模型路由'}；检测到具体关键词/实体问题，强制检索证据`,
    searchQueries,
    needsSearch: true,
    preferredPlan
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clampToolLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(Math.floor(parsed), max))
}

function clampTokenBudget(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(Math.floor(parsed), max))
}

function normalizeToolAction(raw: unknown): ToolLoopAction | null {
  if (!isRecord(raw)) return null

  const actionName = String(raw.action || raw.tool || '').trim()
  const reason = compactText(String(raw.reason || ''), 120) || undefined

  if (actionName === 'read_summary_facts') {
    return { action: 'read_summary_facts', reason }
  }

  if (actionName === 'search_messages') {
    const query = normalizeSearchQuery(String(raw.query || raw.keyword || ''), 48)
    if (!query) return null
    return { action: 'search_messages', query, reason }
  }

  if (actionName === 'read_context') {
    const cursor = isRecord(raw.cursor)
      ? {
        localId: Number(raw.cursor.localId || 0),
        createTime: Number(raw.cursor.createTime || 0),
        sortSeq: Number(raw.cursor.sortSeq || 0)
      }
      : undefined

    return {
      action: 'read_context',
      hitId: compactText(String(raw.hitId || raw.hit_id || ''), 16) || undefined,
      cursor: cursor && cursor.localId && cursor.createTime ? cursor : undefined,
      beforeLimit: clampToolLimit(raw.beforeLimit ?? raw.before_limit, SEARCH_CONTEXT_BEFORE, 12),
      afterLimit: clampToolLimit(raw.afterLimit ?? raw.after_limit, SEARCH_CONTEXT_AFTER, 12),
      reason
    }
  }

  if (actionName === 'read_latest') {
    return {
      action: 'read_latest',
      limit: clampToolLimit(raw.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES),
      reason
    }
  }

  if (actionName === 'read_by_time_range') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    return {
      action: 'read_by_time_range',
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      limit: clampToolLimit(raw.limit, MAX_CONTEXT_MESSAGES, 100),
      keyword: normalizeSearchQuery(String(raw.keyword || ''), 48) || undefined,
      senderUsername: compactText(String(raw.senderUsername || raw.sender_username || ''), 80) || undefined,
      participantName: compactText(String(raw.participantName || raw.participant_name || raw.name || ''), 48) || undefined,
      reason
    }
  }

  if (actionName === 'resolve_participant') {
    return {
      action: 'resolve_participant',
      name: compactText(String(raw.name || raw.query || raw.participantName || raw.participant_name || ''), 48) || undefined,
      reason
    }
  }

  if (actionName === 'aggregate_messages') {
    const metric = String(raw.metric || '').trim()
    return {
      action: 'aggregate_messages',
      metric: ['speaker_count', 'message_count', 'kind_count', 'timeline', 'summary'].includes(metric)
        ? metric as Extract<ToolLoopAction, { action: 'aggregate_messages' }>['metric']
        : 'summary',
      reason
    }
  }

  if (actionName === 'get_session_statistics') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    return {
      action: 'get_session_statistics',
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      participantLimit: clampToolLimit(raw.participantLimit ?? raw.participant_limit, 20, 50),
      includeSamples: Boolean(raw.includeSamples ?? raw.include_samples),
      reason
    }
  }

  if (actionName === 'get_keyword_statistics') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    const keywords = normalizeStringArray(raw.keywords || raw.queries || raw.query ? raw.keywords || raw.queries || [raw.query] : [], 6)
      .map((item) => normalizeSearchQuery(item, 48))
      .filter(Boolean)
    const matchMode = String(raw.matchMode || raw.match_mode || '').trim()
    if (keywords.length === 0) return null
    return {
      action: 'get_keyword_statistics',
      keywords,
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      matchMode: matchMode === 'exact' ? 'exact' : 'substring',
      participantLimit: clampToolLimit(raw.participantLimit ?? raw.participant_limit, 20, 50),
      reason
    }
  }

  if (actionName === 'answer') {
    return { action: 'answer', reason }
  }

  return null
}

function formatCursor(cursor: McpCursor): string {
  return `{"localId":${cursor.localId},"createTime":${cursor.createTime},"sortSeq":${cursor.sortSeq}}`
}

function formatKnownHit(hit: KnownSearchHit): string {
  const source = hit.retrievalSource ? ` | source=${hit.retrievalSource}` : ''
  return `${hit.hitId} | ${formatMessageLine(hit.message)} | score=${Math.round(hit.score)}${source} | cursor=${formatCursor(hit.message.cursor)}`
}

function buildObservationText(observations: ToolObservation[]): string {
  if (observations.length === 0) return '暂无工具观察。'

  return observations
    .slice(-10)
    .map((item, index) => `${index + 1}. ${item.title}\n${item.detail}`)
    .join('\n\n')
}

function buildKnownHitsText(hits: KnownSearchHit[]): string {
  if (hits.length === 0) return '暂无命中。'
  return hits.slice(0, 16).map(formatKnownHit).join('\n')
}

type AutonomousAgentAction =
  | { action: 'assistant_text'; content: string }
  | { action: 'tool_call'; tool: ToolLoopAction; reason?: string }
  | { action: 'final_answer'; content?: string; reason?: string }

function buildAvailableToolSchemaText(): string {
  return `可调用工具：
1. read_summary_facts args={}
   读取当前摘要和结构化摘要。适合先判断摘要是否已经覆盖问题。
2. read_latest args={"limit":40}
   读取最近消息。只适合最近进展或其它工具无法提供线索时兜底。
3. read_by_time_range args={"startTime":秒级时间戳,"endTime":秒级时间戳,"label":"昨天晚上","limit":80,"keyword":"可选关键词","participantName":"可选昵称"}
   按时间/关键词/参与者读取消息。
4. resolve_participant args={"name":"张三"}
   把昵称、备注或问题中的人名解析为 senderUsername。
5. search_messages args={"query":"关键词或短语"}
   混合检索消息、对话块和记忆证据。适合具体词、原话、实体、产品名、技术名、是否提到过等问题。
6. read_context args={"hitId":"h1","beforeLimit":6,"afterLimit":6}
   围绕 search_messages 命中读取前后文。必须已有命中 h1/h2 后再用。
7. get_session_statistics args={"startTime":秒级时间戳,"endTime":秒级时间戳,"participantLimit":20,"includeSamples":true}
   统计当前会话消息量、发送者、类型和样例。
8. get_keyword_statistics args={"keywords":["关键词"],"matchMode":"substring","startTime":秒级时间戳,"endTime":秒级时间戳}
   统计某些词/短语出现次数、发送者分布和样例。
9. aggregate_messages args={"metric":"speaker_count|message_count|kind_count|timeline|summary"}
   对已读取消息做聚合整理。`
}

function buildAutonomousAgentPrompt(input: {
  sessionName: string
  question: string
  route: IntentRoute
  summaryText?: string
  structuredContext?: string
  historyText: string
  observations: ToolObservation[]
  knownHits: KnownSearchHit[]
  resolvedParticipants: ParticipantResolution[]
  aggregateText?: string
  summaryFactsRead: boolean
  toolCallsUsed: number
  evidenceQuality: EvidenceQuality
  searchRetries: number
  searchPayloads: SearchPayloadWithQuery[]
  contextWindows: ContextWindow[]
}): string {
  const totalSearchHits = input.searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)
  const totalContextMessages = input.contextWindows.reduce((sum, window) => sum + window.messages.length, 0)
  const searchedKeywords = input.searchPayloads.map((item) => item.query).join('、') || '无'
  const inferredRange = input.route.timeRange
    ? `${input.route.timeRange.label || '时间范围'} ${input.route.timeRange.startTime || ''}-${input.route.timeRange.endTime || ''}`
    : '无'
  const searchHints = input.route.searchQueries.join('、') || '无'

  return `你是 CipherTalk 的本地聊天记录问答 Agent。你要自主决定下一步：输出一小段文字、调用一个本地工具，或给出最终答案。

当前时间：${formatTime(Date.now())}
会话：${input.sessionName}

用户问题：
${input.question}

多轮上下文：
${input.historyText || '无'}

当前摘要预览：
${compactText(stripThinkBlocks(input.summaryText || ''), MAX_SUMMARY_CHARS) || '无'}

结构化摘要 JSON：
${input.structuredContext || '无'}

内部线索（仅作参考，不是固定路线）：
- 启发式问题类型：${input.route.intent}
- 时间线索：${inferredRange}
- 检索关键词线索：${searchHints}
- 参与者线索：${input.route.participantHints.join('、') || '无'}

已读状态：
- 已读摘要事实：${input.summaryFactsRead ? '是' : '否'}
- 工具预算：${input.toolCallsUsed}/${MAX_TOOL_CALLS}
- 证据质量：${input.evidenceQuality}
- 搜索命中总数：${totalSearchHits}
- 已读取上下文消息数：${totalContextMessages}
- 已搜索关键词：${searchedKeywords}
- 搜索 0 命中重试次数：${input.searchRetries}/${MAX_SEARCH_RETRIES}

已解析参与者：
${input.resolvedParticipants.length > 0
    ? input.resolvedParticipants.map((item) => `${item.displayName || item.query} => ${item.senderUsername || '未解析'} (${item.confidence})`).join('\n')
    : '无'}

聚合/统计结果：
${input.aggregateText || '无'}

已知搜索命中：
${buildKnownHitsText(input.knownHits)}

工具观察：
${buildObservationText(input.observations)}

${buildAvailableToolSchemaText()}

输出格式必须是严格 JSON，只能三选一：
1. {"action":"assistant_text","content":"我先查一下相关记录。"}
2. {"action":"tool_call","toolName":"search_messages","args":{"query":"关键词"},"reason":"为什么调用"}
3. {"action":"final_answer","content":"最终回答文本","reason":"为什么现在可以回答"}

决策规则：
- 可以先用 assistant_text 给用户一句自然的进度文字，然后继续调用工具。
- 寒暄、感谢、能力询问等不需要聊天记录的问题，可以直接 final_answer，不要调用工具。
- 事实类、证据类、原话类、是否提到某词、统计类问题，必须先有证据再 final_answer。
- 证据质量为 none 时，不要 final_answer；优先 search_messages、get_session_statistics、get_keyword_statistics、read_by_time_range 或 read_summary_facts。例外：工具观察明确为 content_not_found 时，应 final_answer 说明证据不足。
- 搜索 0 命中时先看工具观察里的失败原因：content_not_found 表示关键词和语义检索都无证据，应回答证据不足；vector_unavailable 或 keyword_miss_only 才换更核心/同义关键词或按时间读取。
- read_context 只能在已有搜索命中 h1/h2 后调用。
- 工具预算接近用完时，若仍无证据，可以调用 read_latest 兜底。
- final_answer.content 是给用户看的最终答案，可以在 JSON 字符串内使用 Markdown 标题、列表、表格和引用；但整个响应本身仍必须是可解析 JSON。
- 不要输出 Markdown 代码块，不要解释 JSON 之外的内容。`
}

function parseAutonomousAgentAction(value: string, finalAnswerContentCharLimit = 4000): AutonomousAgentAction | null {
  try {
    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(value))) as Record<string, unknown>
    const action = String(parsed.action || '').trim()
    const compactPreservingLines = (content: unknown, limit = finalAnswerContentCharLimit): string | undefined => {
      const text = String(content || '').trim()
      if (!text) return undefined
      return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
    }

    if (action === 'assistant_text') {
      const content = compactText(String(parsed.content || ''), 500)
      return content ? { action: 'assistant_text', content } : null
    }

    if (action === 'final_answer') {
      return {
        action: 'final_answer',
        content: compactPreservingLines(parsed.content),
        reason: compactText(String(parsed.reason || ''), 160) || undefined
      }
    }

    if (action === 'tool_call') {
      const toolName = String(parsed.toolName || parsed.tool || parsed.name || '').trim()
      if (!toolName || toolName === 'answer') {
        return {
          action: 'final_answer',
          reason: compactText(String(parsed.reason || ''), 160) || undefined
        }
      }

      const args = isRecord(parsed.args) ? parsed.args : {}
      const tool = normalizeToolAction({
        ...args,
        action: toolName,
        reason: parsed.reason || args.reason
      })
      return tool ? {
        action: 'tool_call',
        tool,
        reason: compactText(String(parsed.reason || ''), 160) || undefined
      } : null
    }

    return null
  } catch {
    return null
  }
}

async function chooseNextAutonomousAgentAction(
  provider: AIProvider,
  model: string,
  input: Parameters<typeof buildAutonomousAgentPrompt>[0],
  options: {
    decisionMaxTokens: number
    finalAnswerContentCharLimit: number
  }
): Promise<{ action: AutonomousAgentAction; prompt: string }> {
  const prompt = buildAutonomousAgentPrompt(input)

  try {
    const response = await provider.chat([
      {
        role: 'system',
        content: '你是自主工具编排 Agent。你只能输出一个严格 JSON 对象，不能输出 Markdown。'
      },
      {
        role: 'user',
        content: prompt
      }
    ], {
      model,
      temperature: 0.2,
      maxTokens: options.decisionMaxTokens,
      enableThinking: false
    })

    const parsed = parseAutonomousAgentAction(response, options.finalAnswerContentCharLimit)
    if (parsed) return { action: parsed, prompt }
  } catch {
    // 失败时走本地兜底，避免问答卡死。
  }

  if (input.route.intent === 'direct_answer') {
    return {
      action: {
        action: 'final_answer',
        content: '我在。你可以问我这段聊天里的内容、统计互动，或者让我帮你总结。'
      },
      prompt
    }
  }

  if (input.evidenceQuality === 'none') {
    const firstQuery = getFirstConcreteQuery(input.question, input.route.searchQueries)
    return {
      action: firstQuery
        ? { action: 'tool_call', tool: { action: 'search_messages', query: firstQuery, reason: '模型动作解析失败，使用关键词检索兜底' } }
        : { action: 'tool_call', tool: { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '模型动作解析失败，读取最近上下文兜底' } },
      prompt
    }
  }

  return {
    action: { action: 'final_answer', reason: '模型动作解析失败，但已有可用证据，进入最终回答' },
    prompt
  }
}

type EvidenceQuality = 'none' | 'weak' | 'sufficient'

function assessEvidenceQuality(input: {
  searchPayloads: SearchPayloadWithQuery[]
  contextWindows: ContextWindow[]
  summaryFactsRead: boolean
  aggregateText?: string
  intent: SessionQAIntentType
}): EvidenceQuality {
  const summaryHasFacts = input.summaryFactsRead
  const aggregateText = compactText(input.aggregateText || '', 120)
  const aggregateHasFacts = Boolean(aggregateText) && !/^没有可聚合的消息/.test(aggregateText)
  const totalSearchHits = input.searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)
  const totalContextMessages = input.contextWindows.reduce((sum, window) => sum + window.messages.length, 0)
  const hasSearchHits = totalSearchHits > 0
  const hasContext = totalContextMessages > 0

  if (!summaryHasFacts && !aggregateHasFacts && !hasSearchHits && !hasContext) {
    return 'none'
  }

  const needsSearchEvidence = input.intent === 'exact_evidence'
    || input.intent === 'media_or_file'
    || input.intent === 'stats_or_count'

  if (needsSearchEvidence) {
    if (hasSearchHits && totalSearchHits >= 2) return 'sufficient'
    if (hasSearchHits || aggregateHasFacts) return 'weak'
    if (summaryHasFacts && !hasSearchHits) return 'weak'
    return hasContext ? 'weak' : 'none'
  }

  if (summaryHasFacts || aggregateHasFacts) return 'sufficient'
  if (hasSearchHits) return 'sufficient'
  if (hasContext) return 'weak'
  return 'none'
}

function hasConclusiveSearchFailure(searchPayloads: SearchPayloadWithQuery[]): boolean {
  return searchPayloads.length > 0
    && searchPayloads.every((item) =>
      item.payload.hits.length === 0
      && interpretSearchFailure(item.payload).reason === 'content_not_found'
    )
}

function findKnownHitForAction(action: Extract<ToolLoopAction, { action: 'read_context' }>, knownHits: KnownSearchHit[]): KnownSearchHit | null {
  if (action.hitId) {
    const exact = knownHits.find((hit) => hit.hitId.toLowerCase() === action.hitId!.toLowerCase())
    if (exact) return exact
  }

  if (action.cursor) {
    return knownHits.find((hit) =>
      hit.message.cursor.localId === action.cursor!.localId
      && hit.message.cursor.createTime === action.cursor!.createTime
      && hit.message.cursor.sortSeq === action.cursor!.sortSeq
    ) || null
  }

  return knownHits[0] || null
}

function describeVectorSkipReason(reason?: string): string {
  if (!reason) return '原因未知'

  const labels: Record<string, string> = {
    exact_match_mode: '精确匹配模式',
    empty_semantic_query: '语义查询为空',
    vector_provider_unavailable: '向量能力不可用',
    vector_index_incomplete: '向量索引未完成',
    indexed_search_unavailable: '本地索引不可用，已回退扫描',
    search_index_not_ready: '搜索索引未就绪，已回退扫描'
  }

  return reason
    .split(',')
    .map((item) => labels[item] || item)
    .join('、')
}

function interpretSearchFailure(payload?: McpSearchMessagesPayload): {
  reason: SearchFailureReason
  suggestion: string
} {
  if (!payload) {
    return {
      reason: 'keyword_miss_only',
      suggestion: '换更短的关键词重试'
    }
  }

  const vector = payload.vectorSearch

  if (vector?.attempted) {
    if (vector.error) {
      return {
        reason: 'vector_unavailable',
        suggestion: `向量检索执行异常（${compactText(vector.error, 80)}），建议换关键词或改用按时间范围读取`
      }
    }

    if (vector.hitCount === 0) {
      return {
        reason: 'content_not_found',
        suggestion: '关键词和语义检索均无命中，内容可能确实不存在，建议直接回答证据不足'
      }
    }
  }

  if (!vector?.attempted && vector?.skippedReason) {
    return {
      reason: 'vector_unavailable',
      suggestion: `向量索引未可用（${describeVectorSkipReason(vector.skippedReason)}），建议换关键词或改用按时间范围读取`
    }
  }

  return {
    reason: 'keyword_miss_only',
    suggestion: '仅关键词未命中，可尝试更短或同义词'
  }
}

function formatVectorSearchLine(payload?: McpSearchMessagesPayload): string {
  const vector = payload?.vectorSearch
  if (!vector) return '向量索引：无诊断信息'

  const progress = vector.indexedMessages > 0
    ? `，向量化 ${vector.vectorizedMessages}/${vector.indexedMessages} 条`
    : ''
  const model = vector.model ? `，模型 ${vector.model}` : ''
  if (vector.attempted) {
    const error = vector.error ? `，错误：${compactText(vector.error, 80)}` : ''
    return `向量索引：已调用，语义命中 ${vector.hitCount} 条${progress}${model}${error}`
  }

  if (vector.requested) {
    return `向量索引：未调用，${describeVectorSkipReason(vector.skippedReason)}${progress}${model}`
  }

  return '向量索引：未请求'
}

function getSearchDiagnostics(payload?: McpSearchMessagesPayload): string[] {
  if (!payload) return []

  const lines = [
    `检索来源：${payload.source || 'unknown'}`,
    formatVectorSearchLine(payload)
  ]

  if (payload.indexStatus) {
    lines.push(`关键词索引：${payload.indexStatus.ready ? '已使用' : '未使用'}，已索引 ${payload.indexStatus.indexedMessages} 条`)
  }

  return lines
}

function summarizeSearchObservation(query: string, payload?: McpSearchMessagesPayload, knownHits: KnownSearchHit[] = []): string {
  const hits = payload?.hits || []
  const diagnostics = getSearchDiagnostics(payload)
  if (hits.length === 0) {
    const failure = interpretSearchFailure(payload)
    return [
      `关键词：${query}，命中 0 条。`,
      `失败原因：${failure.reason}`,
      `建议：${failure.suggestion}`,
      diagnostics.length ? diagnostics.join('\n') : ''
    ].filter(Boolean).join('\n')
  }

  const latestKnown = knownHits.slice(-Math.min(hits.length, MAX_SEARCH_HITS))
  const lines = latestKnown.map(formatKnownHit).join('\n')
  return `关键词：${query}，命中 ${hits.length} 条。${diagnostics.length ? `\n${diagnostics.join('\n')}` : ''}\n${lines}`
}

async function loadLatestContext(sessionId: string, limit = MAX_CONTEXT_MESSAGES): Promise<{
  payload?: McpSessionContextPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    mode: 'latest',
    beforeLimit: limit,
    includeRaw: false
  }
  const result = await executeMcpTool('get_session_context', args)
  return {
    payload: result.payload as McpSessionContextPayload,
    toolCall: {
      toolName: 'read_latest',
      args,
      summary: result.summary
    }
  }
}

function retrievalSourceLabel(hit: RetrievalHit): McpSearchHit['retrievalSource'] {
  return hit.sources.includes('message_ann') ? 'vector_index' : 'keyword_index'
}

function retrievalHitToMcpSearchHit(sessionId: string, sessionName: string, hit: RetrievalHit): McpSearchHit {
  const expanded = hit.evidence[0]
  const anchor = expanded?.anchor
    ? messageToMcpItem(sessionId, expanded.anchor)
    : expanded?.ref
      ? evidenceRefToMcpItem(expanded.ref)
      : hit.memory.sourceRefs[0]
        ? evidenceRefToMcpItem(hit.memory.sourceRefs[0])
        : {
            messageId: hit.memory.id,
            timestamp: Number(hit.memory.timeStart || hit.memory.timeEnd || 0),
            timestampMs: toTimestampMs(Number(hit.memory.timeStart || hit.memory.timeEnd || 0)),
            direction: 'in' as const,
            kind: 'text' as const,
            text: hit.memory.content,
            sender: {
              username: null,
              displayName: null,
              isSelf: false
            },
            cursor: {
              localId: hit.memory.id,
              createTime: Number(hit.memory.timeStart || hit.memory.timeEnd || 0),
              sortSeq: hit.memory.id
            }
          }

  return {
    session: {
      sessionId,
      displayName: sessionName || sessionId,
      kind: sessionId.includes('@chatroom') ? 'group' : 'friend'
    },
    message: anchor,
    excerpt: compactText(hit.memory.content || hit.memory.title, 240),
    matchedField: 'text',
    score: Number((hit.score * 1000).toFixed(2)),
    retrievalSource: retrievalSourceLabel(hit)
  }
}

function retrievalEvidenceToContextWindow(sessionId: string, query: string, hit: RetrievalHit): ContextWindow | null {
  const messages: McpMessageItem[] = []
  let anchor: McpMessageItem | undefined

  for (const evidence of hit.evidence.slice(0, 2)) {
    messages.push(...evidence.before.map((message) => messageToMcpItem(sessionId, message)))
    if (evidence.anchor) {
      const anchorItem = messageToMcpItem(sessionId, evidence.anchor)
      anchor = anchor || anchorItem
      messages.push(anchorItem)
    } else {
      const fallbackAnchor = evidenceRefToMcpItem(evidence.ref)
      anchor = anchor || fallbackAnchor
      messages.push(fallbackAnchor)
    }
    messages.push(...evidence.after.map((message) => messageToMcpItem(sessionId, message)))
  }

  const deduped = dedupeMessagesByCursor(messages)
  if (deduped.length === 0) return null

  return {
    source: 'search',
    query,
    label: `${hit.memory.sourceType}:${hit.memory.id}`,
    anchor,
    messages: deduped
  }
}

function buildRetrievalDiagnostics(result: RetrievalEngineResult): string[] {
  const sourceLines = result.sourceStats
    .map((stat) => {
      if (!stat.attempted) return `${stat.name}: skipped=${stat.skippedReason || 'unknown'}`
      const error = stat.error ? `, error=${compactText(stat.error, 80)}` : ''
      return `${stat.name}: hits=${stat.hitCount}${error}`
    })
  const rerank = result.rerank.applied
    ? 'rerank: applied'
    : result.rerank.attempted
      ? `rerank: attempted${result.rerank.error ? `, error=${compactText(result.rerank.error, 80)}` : ''}`
      : `rerank: skipped=${result.rerank.skippedReason || 'unknown'}`
  return [
    `memory retrieval: hits=${result.hits.length}, latency=${result.latencyMs}ms`,
    ...sourceLines,
    rerank
  ]
}

function formatQueryListForDiagnostics(queries: string[], limit = 4): string {
  const items = queries.slice(0, limit).map((query) => `"${compactText(query, 48)}"`)
  const rest = queries.length > limit ? `,+${queries.length - limit}` : ''
  return `[${items.join(',')}${rest}]`
}

function formatSourceStatsForDiagnostics(result: RetrievalEngineResult): string {
  return result.sourceStats.map((stat) => {
    if (!stat.attempted) return `${stat.name} skipped=${stat.skippedReason || 'unknown'}`
    const error = stat.error ? ` error=${compactText(stat.error, 60)}` : ''
    return `${stat.name} hits=${stat.hitCount}${error}`
  }).join('; ')
}

function formatSourceRankMapForDiagnostics(hit: RetrievalHit): string {
  return hit.sources
    .map((source) => {
      const rank = hit.sourceRanks[source]
      const score = hit.sourceScores[source]
      const scoreText = typeof score === 'number' ? `/${Number(score).toFixed(3)}` : ''
      return `${source}:${rank ?? '?'}${scoreText}`
    })
    .join(',')
}

function buildRetrievalExplainDiagnostics(input: {
  result: RetrievalEngineResult
  keywordQueries: string[]
  semanticQueries: string[]
  topK?: number
}): string[] {
  const { result, keywordQueries, semanticQueries } = input
  const topK = Math.max(1, Math.min(input.topK || MAX_RETRIEVAL_EXPLAIN_TOP_K, MAX_RETRIEVAL_EXPLAIN_TOP_K))
  const lines: string[] = [
    `retrieval_plan: query="${compactText(result.query, 80)}" semantic="${compactText(result.semanticQuery, 80)}" keywords=${formatQueryListForDiagnostics(keywordQueries)} semantics=${formatQueryListForDiagnostics(semanticQueries, 3)}`,
    `retrieval_sources: ${formatSourceStatsForDiagnostics(result) || 'none'}`,
    `retrieval_ranking: rerank=${result.rerank.applied ? 'applied' : result.rerank.attempted ? 'attempted' : `skipped=${result.rerank.skippedReason || 'unknown'}`} top=${Math.min(topK, result.hits.length)}`
  ]

  for (const hit of result.hits.slice(0, topK)) {
    const memory = hit.memory
    const preview = compactText(memory.title || memory.content || '', 120)
    const rerank = typeof hit.rerankScore === 'number' ? ` rerank=${hit.rerankScore.toFixed(4)}` : ''
    lines.push(
      `top${hit.rank}: ${memory.sourceType}#${memory.id} sources=${hit.sources.join('/')} ranks=${formatSourceRankMapForDiagnostics(hit)} score=${hit.score.toFixed(4)}${rerank} text="${preview}"`
    )
  }

  return lines
}

function uniqueCompactQueries(values: Array<string | undefined>, limit: number, maxLength: number): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const value of values) {
    const query = compactText(String(value || ''), maxLength)
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
    if (queries.length >= limit) break
  }
  return queries
}

function normalizeRewriteArray(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return uniqueCompactQueries(value.map((item) => String(item || '')), limit, maxLength)
}

async function rewriteRetrievalQuery(
  provider: AIProvider | undefined,
  model: string | undefined,
  input: {
    question: string
    searchQuery: string
    sessionName?: string
    senderUsername?: string
    startTime?: number
    endTime?: number
  }
): Promise<QueryRewriteResult> {
  if (!provider || !model) {
    return {
      applied: false,
      keywordQueries: [],
      semanticQueries: [],
      diagnostics: ['query_rewrite: skipped, reason=missing_provider_or_model']
    }
  }

  try {
    const question = compactText(input.question, MAX_REWRITE_INPUT_CHARS)
    const response = await provider.chat([
      {
        role: 'system',
        content: '你是 CipherTalk 会话问答的检索查询改写器。只输出严格 JSON，不要解释，不要 Markdown。'
      },
      {
        role: 'user',
        content: `请把用户关于单个微信会话的问题改写为更适合混合检索的查询。必须保留人名、时间、地点、产品名、技术名、专有名词；不要编造事实；统计、计数、时间范围类问题不要改写成摘要型问题。输出 JSON 字段：semanticQuery, keywordQueries, semanticQueries, reason。

会话：${input.sessionName || '当前会话'}
用户原问题：${question}
当前工具关键词：${input.searchQuery || '无'}
senderUsername 过滤：${input.senderUsername || '无'}
开始时间秒：${input.startTime || '无'}
结束时间秒：${input.endTime || '无'}

约束：
- semanticQuery 必须是 1 个适合语义检索的完整短句。
- keywordQueries 最多 4 个，适合 substring/FTS 检索，避免泛词和完整长问句。
- semanticQueries 最多 3 个，可包含同义表达或补充语义问法。
- reason 一句话说明改写原因。

JSON 示例：
{"semanticQuery":"查找大家是否讨论过 Qwen3 Embedding 的使用和效果","keywordQueries":["Qwen3","Embedding","向量"],"semanticQueries":["谁提到过 Qwen3 Embedding","关于向量模型的讨论"],"reason":"保留技术实体并补充语义表达"}`
      }
    ], {
      model,
      temperature: 0.1,
      maxTokens: 500,
      enableThinking: false
    })

    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(response))) as Record<string, unknown>
    const semanticQuery = compactText(String(parsed.semanticQuery || ''), 180)
    const keywordQueries = normalizeRewriteArray(parsed.keywordQueries, MAX_REWRITE_KEYWORD_QUERIES, 48)
    const semanticQueries = normalizeRewriteArray(parsed.semanticQueries, MAX_REWRITE_SEMANTIC_QUERIES, 160)
    const reason = compactText(String(parsed.reason || ''), 160)

    if (!semanticQuery && keywordQueries.length === 0 && semanticQueries.length === 0) {
      return {
        applied: false,
        keywordQueries: [],
        semanticQueries: [],
        reason,
        diagnostics: ['query_rewrite: failed, reason=empty_rewrite_result']
      }
    }

    return {
      applied: true,
      semanticQuery: semanticQuery || semanticQueries[0],
      keywordQueries,
      semanticQueries,
      reason,
      diagnostics: [
        `query_rewrite: applied, semanticQuery=${compactText(semanticQuery || semanticQueries[0] || '', 120)}`
      ]
    }
  } catch (error) {
    return {
      applied: false,
      keywordQueries: [],
      semanticQueries: [],
      diagnostics: [`query_rewrite: failed, reason=${compactText(String(error), 120)}`]
    }
  }
}

function retrievalResultToSearchPayload(
  sessionId: string,
  sessionName: string,
  result: RetrievalEngineResult,
  limit: number
): McpSearchMessagesPayload {
  const hits = result.hits.slice(0, limit).map((hit) => retrievalHitToMcpSearchHit(sessionId, sessionName, hit))
  const vectorStat = result.sourceStats.find((stat) => stat.name === 'message_ann')

  return {
    hits,
    limit,
    sessionsScanned: 1,
    messagesScanned: result.hits.length,
    truncated: result.hits.length > limit,
    source: 'index',
    vectorSearch: {
      requested: true,
      attempted: Boolean(vectorStat?.attempted),
      providerAvailable: vectorStat?.skippedReason !== 'vector_provider_unavailable',
      indexComplete: vectorStat?.skippedReason !== 'vector_index_incomplete',
      hitCount: vectorStat?.hitCount || 0,
      indexedMessages: result.hits.length,
      vectorizedMessages: vectorStat?.hitCount || 0,
      skippedReason: vectorStat && !vectorStat.attempted ? vectorStat.skippedReason : undefined,
      error: vectorStat?.error
    },
    rerank: {
      requested: true,
      attempted: result.rerank.attempted,
      enabled: result.rerank.skippedReason !== 'config_disabled' && result.rerank.skippedReason !== 'disabled',
      modelAvailable: !result.rerank.error,
      candidateCount: result.hits.length,
      rerankedCount: result.rerank.applied ? result.hits.length : 0,
      skippedReason: result.rerank.skippedReason,
      error: result.rerank.error
    },
    sessionSummaries: [{
      session: {
        sessionId,
        displayName: sessionName || sessionId,
        kind: sessionId.includes('@chatroom') ? 'group' : 'friend'
      },
      hitCount: hits.length,
      topScore: hits[0]?.score || 0,
      sampleExcerpts: hits.slice(0, 3).map((hit) => hit.excerpt)
    }]
  }
}

async function searchSessionMessages(sessionId: string, query: string, filters: {
  provider?: AIProvider
  model?: string
  originalQuestion?: string
  semanticQuery?: string
  senderUsername?: string
  startTime?: number
  endTime?: number
  limit?: number
  sessionName?: string
} = {}): Promise<{
  payload?: McpSearchMessagesPayload
  toolCall?: SessionQAToolCall
  contextWindows?: ContextWindow[]
  diagnostics?: string[]
}> {
  const retrievalQuery = filters.originalQuestion || query
  const rewrite = await rewriteRetrievalQuery(filters.provider, filters.model, {
    question: retrievalQuery,
    searchQuery: query,
    sessionName: filters.sessionName || sessionId,
    senderUsername: filters.senderUsername,
    startTime: filters.startTime,
    endTime: filters.endTime
  })
  const fallbackSemanticQuery = filters.semanticQuery || `${query} ${retrievalQuery}`.trim()
  const semanticQuery = rewrite.semanticQuery || fallbackSemanticQuery
  const keywordQueries = uniqueCompactQueries([
    query,
    retrievalQuery,
    ...rewrite.keywordQueries
  ], MAX_REWRITE_KEYWORD_QUERIES + 2, 80)
  const semanticQueries = uniqueCompactQueries([
    semanticQuery,
    fallbackSemanticQuery,
    ...rewrite.semanticQueries
  ], MAX_REWRITE_SEMANTIC_QUERIES + 2, 180)

  try {
    const retrieval = await retrievalEngine.search({
      sessionId,
      query: retrievalQuery,
      semanticQuery,
      keywordQueries,
      semanticQueries,
      startTimeMs: filters.startTime ? filters.startTime * 1000 : undefined,
      endTimeMs: filters.endTime ? filters.endTime * 1000 : undefined,
      senderUsername: filters.senderUsername,
      limit: filters.limit || MAX_SEARCH_HITS,
      rerank: true,
      expandEvidence: true
    })

    const payload = retrievalResultToSearchPayload(
      sessionId,
      filters.sessionName || sessionId,
      retrieval,
      filters.limit || MAX_SEARCH_HITS
    )
    const contextWindows = retrieval.hits
      .slice(0, MAX_CONTEXT_WINDOWS)
      .map((hit) => retrievalEvidenceToContextWindow(sessionId, query, hit))
      .filter((window): window is ContextWindow => Boolean(window))
    const diagnostics = [
      ...rewrite.diagnostics,
      ...buildRetrievalDiagnostics(retrieval),
      ...buildRetrievalExplainDiagnostics({
        result: retrieval,
        keywordQueries,
        semanticQueries
      })
    ]
    return {
      payload,
      contextWindows,
      diagnostics,
      toolCall: {
        toolName: 'search_messages',
        args: {
          sessionId,
          query,
          retrievalEngine: 'memory_hybrid',
          semanticQuery,
          keywordQueries,
          semanticQueries,
          queryRewrite: rewrite.applied ? 'applied' : 'fallback',
          limit: filters.limit || MAX_SEARCH_HITS
        },
        summary: `新记忆检索命中 ${payload.hits.length} 条；${diagnostics.join('；')}`,
        status: 'completed',
        evidenceCount: payload.hits.length
      }
    }
  } catch (error) {
    console.warn('[SessionQAAgent] 新记忆检索失败，回退旧 search_messages:', error)
  }

  const args = {
    sessionId,
    query,
    ...(filters.semanticQuery ? { semanticQuery: filters.semanticQuery } : {}),
    limit: filters.limit || MAX_SEARCH_HITS,
    matchMode: 'substring',
    includeRaw: false,
    rerank: true,
    ...(filters.senderUsername ? { senderUsername: filters.senderUsername } : {}),
    ...(filters.startTime ? { startTime: filters.startTime } : {}),
    ...(filters.endTime ? { endTime: filters.endTime } : {})
  }

  const result = await executeMcpTool('search_messages', args)
  return {
    payload: result.payload as McpSearchMessagesPayload,
    diagnostics: rewrite.diagnostics,
    toolCall: {
      toolName: 'search_messages',
      args,
      summary: rewrite.diagnostics.length ? `${result.summary}；${rewrite.diagnostics.join('；')}` : result.summary,
      status: 'completed',
      evidenceCount: ((result.payload as McpSearchMessagesPayload)?.hits || []).length
    }
  }
}

async function loadContextAroundMessage(
  sessionId: string,
  message: McpMessageItem,
  beforeLimit = SEARCH_CONTEXT_BEFORE,
  afterLimit = SEARCH_CONTEXT_AFTER
): Promise<{
  payload?: McpSessionContextPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    mode: 'around',
    anchorCursor: message.cursor,
    beforeLimit,
    afterLimit,
    includeRaw: false
  }
  const result = await executeMcpTool('get_session_context', args)
  return {
    payload: result.payload as McpSessionContextPayload,
    toolCall: {
      toolName: 'read_context',
      args,
      summary: result.summary
    }
  }
}

function formatParticipantStatsLines(items: McpSessionStatisticsPayload['participantRankings']): string {
  if (!items.length) return '无参与者统计。'
  return items.slice(0, 12).map((item, index) =>
    `${index + 1}. ${item.displayName || item.senderUsername || item.role}：${item.messageCount} 条（发出 ${item.sentCount}，收到 ${item.receivedCount}）`
  ).join('\n')
}

function formatSessionStatisticsText(payload: McpSessionStatisticsPayload): string {
  const kindCounts = Object.entries(payload.kindCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}=${count}`)
    .join('，') || '无'
  const activeHours = Object.entries(payload.hourlyDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([hour, count]) => `${hour}时=${count}`)
    .join('，') || '无'

  return [
    `会话统计：${payload.session.displayName}`,
    `总消息 ${payload.totalMessages} 条，发出 ${payload.sentMessages} 条，收到 ${payload.receivedMessages} 条，活跃 ${payload.activeDays} 天。`,
    `首条：${payload.firstMessageTime ? formatTime(payload.firstMessageTime * 1000) : '无'}；末条：${payload.lastMessageTime ? formatTime(payload.lastMessageTime * 1000) : '无'}。`,
    `消息类型：${kindCounts}。`,
    `最活跃小时：${activeHours}。`,
    `发言排行：\n${formatParticipantStatsLines(payload.participantRankings)}`,
    `扫描 ${payload.scannedMessages} 条，范围内匹配 ${payload.matchedMessages} 条${payload.truncated ? '，结果因扫描上限被截断' : ''}。`
  ].join('\n')
}

function formatKeywordStatisticsText(payload: McpKeywordStatisticsPayload): string {
  const lines = payload.keywords.map((item) => {
    const topParticipants = item.participantRankings.slice(0, 5)
      .map((participant) => `${participant.displayName || participant.senderUsername || participant.role}=${participant.messageCount}`)
      .join('，') || '无'
    const activeHours = Object.entries(item.hourlyDistribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, count]) => `${hour}时=${count}`)
      .join('，') || '无'
    return [
      `关键词“${item.keyword}”：命中 ${item.hitCount} 条消息，出现 ${item.occurrenceCount} 次。`,
      `首次：${item.firstHitTime ? formatTime(item.firstHitTime * 1000) : '无'}；末次：${item.lastHitTime ? formatTime(item.lastHitTime * 1000) : '无'}。`,
      `发送者分布：${topParticipants}。`,
      `高频小时：${activeHours}。`
    ].join('\n')
  })

  return [
    `关键词统计：${payload.session.displayName}`,
    ...lines,
    `扫描 ${payload.scannedMessages} 条，命中 ${payload.matchedMessages} 条${payload.truncated ? '，结果因扫描上限被截断' : ''}。`
  ].join('\n\n')
}

async function loadSessionStatistics(
  sessionId: string,
  action: Extract<ToolLoopAction, { action: 'get_session_statistics' }>,
  fallbackRange?: TimeRangeHint
): Promise<{
  payload?: McpSessionStatisticsPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    startTime: action.startTime || fallbackRange?.startTime,
    endTime: action.endTime || fallbackRange?.endTime,
    includeSamples: action.includeSamples || false,
    participantLimit: action.participantLimit || 20
  }
  const result = await executeMcpTool('get_session_statistics', args)
  const payload = result.payload as McpSessionStatisticsPayload
  return {
    payload,
    toolCall: {
      toolName: 'get_session_statistics',
      args,
      summary: formatSessionStatisticsText(payload),
      status: payload.totalMessages > 0 ? 'completed' : 'failed',
      evidenceCount: payload.totalMessages
    }
  }
}

async function loadKeywordStatistics(
  sessionId: string,
  action: Extract<ToolLoopAction, { action: 'get_keyword_statistics' }>,
  fallbackRange?: TimeRangeHint
): Promise<{
  payload?: McpKeywordStatisticsPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    keywords: action.keywords,
    startTime: action.startTime || fallbackRange?.startTime,
    endTime: action.endTime || fallbackRange?.endTime,
    matchMode: action.matchMode || 'substring',
    participantLimit: action.participantLimit || 20
  }
  const result = await executeMcpTool('get_keyword_statistics', args)
  const payload = result.payload as McpKeywordStatisticsPayload
  return {
    payload,
    toolCall: {
      toolName: 'get_keyword_statistics',
      args,
      summary: formatKeywordStatisticsText(payload),
      status: payload.matchedMessages > 0 ? 'completed' : 'failed',
      evidenceCount: payload.matchedMessages
    }
  }
}

async function loadMessagesByTimeRange(
  sessionId: string,
  input: {
    startTime?: number
    endTime?: number
    keyword?: string
    senderUsername?: string
    limit?: number
    order?: 'asc' | 'desc'
  }
): Promise<{
  payload?: McpMessagesPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    offset: 0,
    limit: input.limit || 80,
    order: input.order || 'asc',
    includeRaw: false,
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.keyword ? { keyword: input.keyword } : {})
  }
  const result = await executeMcpTool('get_messages', args)
  const payload = (result.payload || {
    items: [],
    offset: 0,
    limit: input.limit || 80,
    hasMore: false
  }) as McpMessagesPayload
  const items = input.senderUsername
    ? (payload.items || []).filter((message) => message.sender.username === input.senderUsername)
    : payload.items || []

  return {
    payload: {
      ...payload,
      items,
      limit: input.limit || payload.limit
    },
    toolCall: {
      toolName: 'read_by_time_range',
      args: {
        ...args,
        ...(input.senderUsername ? { senderUsername: input.senderUsername } : {})
      },
      summary: result.summary
    }
  }
}

async function loadMessagesByTimeRangeAll(
  sessionId: string,
  input: {
    startTime?: number
    endTime?: number
    senderUsername?: string
    keyword?: string
    maxMessages?: number
  }
): Promise<McpMessageItem[]> {
  const limit = 200
  const maxMessages = Math.max(limit, Math.min(input.maxMessages || 10000, 20000))
  const items: McpMessageItem[] = []
  let offset = 0

  while (items.length < maxMessages) {
    const result = await executeMcpTool('get_messages', {
      sessionId,
      offset,
      limit,
      order: 'asc',
      includeRaw: false,
      ...(input.startTime ? { startTime: input.startTime } : {}),
      ...(input.endTime ? { endTime: input.endTime } : {}),
      ...(input.keyword ? { keyword: input.keyword } : {})
    })
    const payload = result.payload as McpMessagesPayload
    const pageItems = input.senderUsername
      ? (payload.items || []).filter((message) => message.sender.username === input.senderUsername)
      : payload.items || []
    items.push(...pageItems)

    if (!payload.hasMore || (payload.items || []).length === 0) {
      break
    }

    offset += limit
  }

  return items.slice(0, maxMessages)
}

function buildSummaryFactsText(summaryText?: string, structuredContext?: string): string {
  const parts = [
    stripThinkBlocks(summaryText || '').trim(),
    structuredContext ? `结构化摘要：${structuredContext}` : ''
  ].filter(Boolean)

  return compactText(parts.join('\n\n'), MAX_SUMMARY_CHARS + MAX_STRUCTURED_CHARS)
}

function collectStructuredEvidenceRefs(analysis?: StructuredAnalysis): SummaryEvidenceRef[] {
  if (!analysis) return []
  const refs: SummaryEvidenceRef[] = []

  for (const group of [analysis.decisions, analysis.todos, analysis.risks, analysis.events]) {
    for (const item of group) {
      refs.push(...item.evidenceRefs)
    }
  }

  return refs
}

function formatTimeRangeLabel(range?: TimeRangeHint): string {
  if (!range?.startTime && !range?.endTime) return range?.label || '未指定时间范围'
  const start = range.startTime ? formatTime(range.startTime * 1000) : '开始'
  const end = range.endTime ? formatTime(range.endTime * 1000) : '结束'
  return range.label ? `${range.label}（${start} - ${end}）` : `${start} - ${end}`
}

function getRouteLabel(intent: SessionQAIntentType): string {
  const labels: Record<SessionQAIntentType, string> = {
    direct_answer: '直接回答',
    summary_answerable: '摘要可答',
    recent_status: '最近进展',
    time_range: '时间范围',
    participant_focus: '参与者聚焦',
    exact_evidence: '精确证据',
    media_or_file: '媒体文件',
    broad_summary: '趋势总结',
    stats_or_count: '统计计数',
    unclear: '不明确'
  }
  return labels[intent]
}

function participantMatches(query: string, message: McpMessageItem): boolean {
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

async function resolveParticipantName(input: {
  sessionId: string
  name?: string
  contextWindows: ContextWindow[]
  knownHits: KnownSearchHit[]
}): Promise<ParticipantResolution> {
  const query = compactText(input.name || '', 48)
  const observedMessages = dedupeMessagesByCursor([
    ...input.contextWindows.flatMap((window) => window.messages),
    ...input.knownHits.map((hit) => hit.message)
  ])

  if (query) {
    const observed = observedMessages.find((message) => participantMatches(query, message))
    if (observed?.sender.username || observed?.sender.displayName) {
      return {
        query,
        senderUsername: observed.sender.username || undefined,
        displayName: describeSender(observed),
        confidence: observed.sender.username ? 'high' : 'medium',
        source: 'observed'
      }
    }
  }

  if (query) {
    try {
      const result = await executeMcpTool('list_contacts', { q: query, limit: 10, offset: 0 })
      const payload = result.payload as McpContactsPayload
      const exact = payload.items.find((contact) => {
        const names = [contact.displayName, contact.remark || '', contact.nickname || '', contact.contactId]
        return names.some((name) => name && (name === query || name.toLowerCase() === query.toLowerCase()))
      }) || payload.items[0]

      if (exact) {
        return {
          query,
          senderUsername: exact.contactId,
          displayName: exact.displayName || exact.remark || exact.nickname || exact.contactId,
          confidence: exact.displayName === query || exact.remark === query || exact.nickname === query ? 'high' : 'medium',
          source: 'contacts'
        }
      }
    } catch {
      // 参与者解析失败不应中断问答，后续会回退到未过滤读取。
    }
  }

  return {
    query: query || '未指定参与者',
    confidence: 'low',
    source: 'fallback'
  }
}

function findResolvedSenderUsername(
  action: Extract<ToolLoopAction, { action: 'read_by_time_range' }>,
  resolvedParticipants: ParticipantResolution[]
): string | undefined {
  if (action.senderUsername) return action.senderUsername
  if (!action.participantName) {
    return resolvedParticipants.find((item) => item.senderUsername)?.senderUsername
  }
  const normalized = action.participantName.toLowerCase()
  return resolvedParticipants.find((item) => {
    const displayName = (item.displayName || '').toLowerCase()
    return item.query.toLowerCase() === normalized
      || (Boolean(displayName) && (displayName.includes(normalized) || normalized.includes(displayName)))
  })?.senderUsername
}

function aggregateMessages(messages: McpMessageItem[], metric: Extract<ToolLoopAction, { action: 'aggregate_messages' }>['metric'] = 'summary'): string {
  const unique = dedupeMessagesByCursor(messages)
  if (unique.length === 0) return '没有可聚合的消息。'

  const speakerCounts = new Map<string, number>()
  const kindCounts = new Map<string, number>()
  const dayCounts = new Map<string, number>()

  for (const message of unique) {
    const speaker = describeSender(message)
    speakerCounts.set(speaker, (speakerCounts.get(speaker) || 0) + 1)
    kindCounts.set(message.kind, (kindCounts.get(message.kind) || 0) + 1)
    const day = formatTime(message.timestampMs).slice(0, 10)
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
  }

  const formatTop = (map: Map<string, number>, limit = 8) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name}: ${count}`)
    .join('；')

  const first = unique[0]
  const last = unique[unique.length - 1]
  const samples = unique
    .filter((message) => message.text)
    .slice(0, 8)
    .map(formatMessageLine)
    .join('\n')

  if (metric === 'speaker_count') {
    return `消息数：${unique.length}\n发言排行：${formatTop(speakerCounts)}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}`
  }

  if (metric === 'message_count') {
    return `消息数：${unique.length}\n按日期：${formatTop(dayCounts, 10)}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}`
  }

  if (metric === 'kind_count') {
    return `消息数：${unique.length}\n消息类型：${formatTop(kindCounts)}`
  }

  if (metric === 'timeline') {
    return `消息数：${unique.length}\n按日期：${formatTop(dayCounts, 10)}\n代表消息：\n${samples || '无文本消息。'}`
  }

  return `消息数：${unique.length}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}\n发言分布：${formatTop(speakerCounts)}\n消息类型：${formatTop(kindCounts)}\n代表消息：\n${samples || '无文本消息。'}`
}

function buildStructuredContext(analysis?: StructuredAnalysis): string {
  if (!analysis) return ''

  return compactText(JSON.stringify(analysis), MAX_STRUCTURED_CHARS)
}

function buildHistoryContext(history: SessionQAHistoryMessage[] = []): string {
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => `${item.role === 'user' ? '用户' : 'AI'}：${compactText(item.content, 500)}`)
    .join('\n')
}

function buildAnswerPrompt(input: {
  sessionName: string
  question: string
  route: IntentRoute
  summaryText?: string
  structuredContext?: string
  summaryFactsText?: string
  contextWindows: ContextWindow[]
  searchPayloads: SearchPayloadWithQuery[]
  aggregateText?: string
  resolvedParticipants: ParticipantResolution[]
  historyText: string
  usedRecentFallback: boolean
}): string {
  const contextText = input.contextWindows.length > 0
    ? input.contextWindows.map((window, index) => {
      const heading = window.source === 'search'
        ? `上下文窗口 ${index + 1}（关键词：${window.query || '未知'}，围绕命中消息）`
        : window.source === 'time_range'
          ? `上下文窗口 ${index + 1}（按时间读取：${window.label || '指定范围'}）`
          : `上下文窗口 ${index + 1}（最近消息）`
      const lines = window.messages.length > 0
        ? window.messages.map(formatMessageLine).join('\n')
        : '无上下文消息。'
      return `${heading}\n${lines}`
    }).join('\n\n')
    : '无可用上下文。'

  const searchContext = input.searchPayloads.length > 0
    ? input.searchPayloads.map(({ query, payload }) => {
      const lines = payload.hits.length > 0
        ? payload.hits.map((hit) => formatMessageLine(hit.message)).join('\n')
        : '无命中。'
      return `关键词：${query}\n${lines}`
    }).join('\n\n')
    : '本次未执行关键词检索，或检索没有命中。'

  const participantText = input.resolvedParticipants.length > 0
    ? input.resolvedParticipants
      .map((item) => `${item.query} => ${item.displayName || '未命名'} / ${item.senderUsername || '未解析'} / ${item.confidence}`)
      .join('\n')
    : '无'

  return `你是 CipherTalk 的单会话 AI 助手。请只基于提供的本地聊天上下文回答，不要编造未出现的事实。

会话：${input.sessionName}

用户问题：
${input.question}

多轮上下文：
${input.historyText || '无'}

当前摘要：
${compactText(stripThinkBlocks(input.summaryText || ''), MAX_SUMMARY_CHARS) || '无'}

结构化摘要 JSON：
${input.structuredContext || '无'}

内部问题线索：
${getRouteLabel(input.route.intent)}（${input.route.confidence}）：${input.route.reason || '无'}

已读取摘要事实：
${input.summaryFactsText || '无'}

已解析参与者：
${participantText}

按需读取的消息上下文：
${contextText}

关键词检索结果：
${searchContext}

聚合/统计结果：
${input.aggregateText || '无'}

上下文策略：
${input.usedRecentFallback
    ? '本次读取了最近消息，适合回答最近进展或作为证据兜底。'
    : input.searchPayloads.length > 0
      ? '本次执行了关键词检索，并在需要时围绕命中读取上下文。'
      : '本次由 Agent 自主选择了摘要、时间范围、参与者或聚合工具，没有把关键词搜索作为默认入口。'}

回答要求：
1. 用中文直接回答问题。
2. 如果证据不足，明确说“当前证据不足”，并说明还需要什么线索。
3. 可以使用 Markdown 组织最终答案，包括标题、列表、表格、引用和加粗；但不要为了排版而过度复杂。
4. 能引用依据时，在回答末尾加“依据”小节，用时间、发送人和原文预览列 1 到 5 条。
5. 不要输出工具调用过程，不要输出 JSON。`
}

export async function answerSessionQuestionWithAgent(
  options: SessionQAAgentOptions
): Promise<SessionQAAgentResult> {
  const toolCalls: SessionQAToolCall[] = []
  const evidenceCandidates: SummaryEvidenceRef[] = []
  const searchPayloads: SearchPayloadWithQuery[] = []
  const contextWindows: ContextWindow[] = []
  const observations: ToolObservation[] = []
  const knownHits: KnownSearchHit[] = []
  const searchedQueries = new Set<string>()
  const readContextKeys = new Set<string>()
  const structuredContext = buildStructuredContext(options.structuredAnalysis)
  const historyText = buildHistoryContext(options.history)
  const resolvedParticipants: ParticipantResolution[] = []
  const route = enforceConcreteEvidenceRoute(routeFromHeuristics(options.question, options.summaryText), options.question)
  const agentDecisionMaxTokens = clampTokenBudget(
    options.agentDecisionMaxTokens,
    DEFAULT_AGENT_DECISION_MAX_TOKENS,
    512,
    MAX_AGENT_DECISION_MAX_TOKENS
  )
  const agentAnswerMaxTokens = clampTokenBudget(
    options.agentAnswerMaxTokens,
    DEFAULT_AGENT_ANSWER_MAX_TOKENS,
    512,
    MAX_AGENT_ANSWER_MAX_TOKENS
  )
  const finalAnswerContentCharLimit = Math.max(4000, agentAnswerMaxTokens * 4)
  let summaryFactsRead = false
  let summaryFactsText = ''
  let aggregateText = ''
  let usedRecentFallback = false
  let answerText = ''
  let lastAgentPrompt = ''

  const emitVisibleText = (content: string) => {
    const text = stripThinkBlocks(content).trim()
    if (!text) return
    const prefix = answerText && !/\s$/.test(answerText) ? '\n\n' : ''
    const visible = `${prefix}${text}`
    answerText += visible
    options.onChunk(visible)
  }

  const addKnownHits = (query: string, payload?: McpSearchMessagesPayload) => {
    if (!payload) return

    for (const hit of payload.hits) {
      const key = getMessageCursorKey(hit.message)
      if (knownHits.some((item) => getMessageCursorKey(item.message) === key)) continue
      const knownHit: KnownSearchHit = {
        ...hit,
        query,
        hitId: `h${knownHits.length + 1}`
      }
      knownHits.push(knownHit)
      const ref = toEvidenceRef(options.sessionId, hit.message, hit.excerpt)
      if (ref) evidenceCandidates.push(ref)
    }
  }

  const addContextEvidence = (messages: McpMessageItem[], limit = 8) => {
    for (const message of messages.slice(-limit)) {
      const ref = toEvidenceRef(options.sessionId, message)
      if (ref) evidenceCandidates.push(ref)
    }
  }

  const currentEvidenceQuality = () => assessEvidenceQuality({
    searchPayloads,
    contextWindows,
    summaryFactsRead,
    aggregateText,
    intent: route.intent
  })

  const currentEvidenceState = () => currentEvidenceQuality() !== 'none'

  let toolCallsUsed = 0
  let decisionAttempts = 0
  let searchRetries = 0

  while (toolCallsUsed < MAX_TOOL_CALLS && decisionAttempts < MAX_TOOL_DECISION_ATTEMPTS) {
    decisionAttempts += 1

    const evidenceQuality = currentEvidenceQuality()
    const conclusiveSearchFailure = hasConclusiveSearchFailure(searchPayloads)
    const agentDecision = await chooseNextAutonomousAgentAction(options.provider, options.model, {
      sessionName: options.sessionName || options.sessionId,
      question: options.question,
      route,
      summaryText: options.summaryText,
      structuredContext,
      historyText,
      observations,
      knownHits,
      resolvedParticipants,
      aggregateText,
      summaryFactsRead,
      toolCallsUsed,
      evidenceQuality,
      searchRetries,
      searchPayloads,
      contextWindows
    }, {
      decisionMaxTokens: agentDecisionMaxTokens,
      finalAnswerContentCharLimit
    })
    lastAgentPrompt = agentDecision.prompt

    if (agentDecision.action.action === 'assistant_text') {
      emitVisibleText(agentDecision.action.content)
      observations.push({
        title: 'Agent 输出',
        detail: agentDecision.action.content
      })
      continue
    }

    if (agentDecision.action.action === 'final_answer') {
      if (evidenceQuality === 'none' && route.intent !== 'direct_answer' && !conclusiveSearchFailure) {
        const hasTriedSummary = observations.some((item) => item.title === '读取摘要事实')
        const fallbackAction: ToolLoopAction = summaryFactsRead || hasTriedSummary
          ? { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '模型准备回答但仍缺少证据，读取最近上下文兜底' }
          : { action: 'read_summary_facts', reason: '模型准备回答但尚无证据，先检查摘要事实' }
        observations.push({
          title: '延后回答',
          detail: agentDecision.action.reason || '当前没有证据，继续收集上下文。'
        })
        agentDecision.action = { action: 'tool_call', tool: fallbackAction }
      } else if (agentDecision.action.content) {
        emitProgress(options, {
          id: 'answer',
          stage: 'answer',
          status: 'running',
          title: '生成回答',
          detail: agentDecision.action.reason || 'Agent 已决定直接回答'
        })
        emitVisibleText(agentDecision.action.content)
        emitProgress(options, {
          id: 'answer',
          stage: 'answer',
          status: 'completed',
          title: '生成回答',
          detail: '回答生成完成'
        })

        return {
          answerText: stripThinkBlocks(answerText),
          evidenceRefs: dedupeEvidenceRefs(evidenceCandidates),
          toolCalls,
          promptText: lastAgentPrompt
        }
      } else {
        observations.push({
          title: '开始回答',
          detail: agentDecision.action.reason || 'Agent 判断已有可用证据，进入最终回答。'
        })
        break
      }
    }

    let action: ToolLoopAction = agentDecision.action.action === 'tool_call'
      ? agentDecision.action.tool
      : { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: 'Agent 动作无效，读取最近上下文兜底' }

    if (evidenceQuality === 'none' && toolCallsUsed >= MAX_TOOL_CALLS - 1 && action.action !== 'read_latest') {
      action = {
        action: 'read_latest',
        limit: MAX_CONTEXT_MESSAGES,
        reason: '工具预算即将耗尽，先读取最近消息作为最低限度依据'
      }
    }

    if (action.action === 'answer') {
      if (evidenceQuality === 'none' && !conclusiveSearchFailure) {
        action = summaryFactsRead
          ? { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '摘要事实不足，回答前读取最近上下文' }
          : { action: 'read_summary_facts', reason: '尚无可用证据，先检查摘要事实' }
      } else if (evidenceQuality === 'weak' && toolCallsUsed < MAX_TOOL_CALLS - 2) {
        const hasSearchedWithNoHits = searchPayloads.length > 0
          && searchPayloads.every((item) => item.payload.hits.length === 0)
        if (hasSearchedWithNoHits && searchRetries < MAX_SEARCH_RETRIES) {
          const nextQuery = route.searchQueries.find((query) => !searchedQueries.has(query.toLowerCase()))
          action = nextQuery
            ? { action: 'search_messages', query: nextQuery, reason: '之前的搜索没有命中，换关键词重试' }
            : { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '搜索没有命中且缺少新关键词，读取最近上下文兜底' }
        } else {
          observations.push({
            title: '开始回答',
            detail: action.reason || '证据有限但已尝试多种策略，进入回答生成。'
          })
          break
        }
      } else {
        observations.push({
          title: '开始回答',
          detail: action.reason || '已有可用证据，进入回答生成。'
        })
        break
      }
    }

    if (action.action === 'read_summary_facts') {
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-summary`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取摘要事实',
        detail: action.reason || '读取当前摘要和结构化摘要',
        toolName: 'read_summary_facts'
      })

      summaryFactsText = buildSummaryFactsText(options.summaryText, structuredContext)
      summaryFactsRead = Boolean(summaryFactsText)
      if (summaryFactsRead) {
        evidenceCandidates.push(...collectStructuredEvidenceRefs(options.structuredAnalysis))
      }

      toolCalls.push({
        toolName: 'read_summary_facts',
        args: {
          hasSummaryText: Boolean(stripThinkBlocks(options.summaryText || '').trim()),
          hasStructuredAnalysis: Boolean(structuredContext)
        },
        summary: summaryFactsRead ? '已读取当前摘要和结构化摘要。' : '当前没有可用摘要事实。'
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'completed',
        title: '读取摘要事实',
        detail: summaryFactsRead ? '当前摘要/结构化摘要可作为回答依据' : '当前摘要为空或不足',
        toolName: 'read_summary_facts',
        count: summaryFactsRead ? 1 : 0
      })

      observations.push({
        title: '读取摘要事实',
        detail: summaryFactsRead ? summaryFactsText : '当前没有可用摘要事实。'
      })

      continue
    }

    if (action.action === 'resolve_participant') {
      toolCallsUsed += 1
      const name = action.name || route.participantHints[0] || ''
      const progressId = `tool-loop-${toolCallsUsed}-participant`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '解析参与者',
        detail: name ? `正在解析：${name}` : '正在从问题中解析参与者',
        toolName: 'resolve_participant',
        query: name
      })

      const resolution = await resolveParticipantName({
        sessionId: options.sessionId,
        name,
        contextWindows,
        knownHits
      })
      resolvedParticipants.push(resolution)
      toolCalls.push({
        toolName: 'resolve_participant',
        args: { sessionId: options.sessionId, name },
        summary: resolution.senderUsername
          ? `解析为 ${resolution.displayName || resolution.senderUsername}`
          : '未解析到明确发送者，后续读取会不加发送者过滤。'
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: resolution.senderUsername ? 'completed' : 'failed',
        title: '解析参与者',
        detail: resolution.senderUsername
          ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername}`
          : `${resolution.query} 未解析到明确发送者`,
        toolName: 'resolve_participant',
        query: name,
        count: resolution.senderUsername ? 1 : 0
      })

      observations.push({
        title: '解析参与者',
        detail: resolution.senderUsername
          ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername} (${resolution.senderUsername})，置信度 ${resolution.confidence}。`
          : `${resolution.query} 未解析到明确 senderUsername。`
      })

      continue
    }

    if (action.action === 'read_by_time_range') {
      toolCallsUsed += 1
      const inferredRange = route.timeRange || inferTimeRangeFromQuestion(options.question)
      const range: TimeRangeHint = {
        startTime: action.startTime || inferredRange?.startTime,
        endTime: action.endTime || inferredRange?.endTime,
        label: action.label || inferredRange?.label
      }
      const senderUsername = findResolvedSenderUsername(action, resolvedParticipants)
      const hasRange = Boolean(range.startTime || range.endTime)
      const limit = clampToolLimit(action.limit, hasRange ? 80 : MAX_CONTEXT_MESSAGES, 100)
      const progressId = `tool-loop-${toolCallsUsed}-time`
      const label = hasRange ? formatTimeRangeLabel(range) : '最近一批消息'
      const participantLabel = action.participantName || resolvedParticipants[0]?.displayName || resolvedParticipants[0]?.query || ''

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: hasRange ? '按时间读取消息' : '读取最近消息',
        detail: `${label}${participantLabel ? `；参与者：${participantLabel}` : ''}`,
        toolName: 'read_by_time_range',
        query: action.keyword
      })

      try {
        const payload = await loadMessagesByTimeRange(options.sessionId, {
          startTime: range.startTime,
          endTime: range.endTime,
          keyword: action.keyword,
          senderUsername,
          limit,
          order: hasRange ? 'asc' : 'desc'
        })
        if (payload.toolCall) toolCalls.push(payload.toolCall)
        const messages = payload.payload?.items || []
        contextWindows.push({
          source: 'time_range',
          label: `${label}${senderUsername ? `；发送者：${senderUsername}` : participantLabel ? `；参与者：${participantLabel}` : ''}`,
          messages
        })
        addContextEvidence(messages)

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: hasRange ? '按时间读取消息' : '读取最近消息',
          detail: `读取到 ${messages.length} 条消息`,
          toolName: 'read_by_time_range',
          query: action.keyword,
          count: messages.length
        })

        observations.push({
          title: hasRange ? '按时间读取消息' : '读取最近消息',
          detail: `${label}${senderUsername ? `，senderUsername=${senderUsername}` : ''}，读取到 ${messages.length} 条。\n${messages.slice(0, 12).map(formatMessageLine).join('\n') || '无消息。'}`
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: hasRange ? '按时间读取失败' : '读取最近消息失败',
          detail: compactText(String(error), 120),
          toolName: 'read_by_time_range',
          query: action.keyword
        })

        observations.push({
          title: hasRange ? '按时间读取失败' : '读取最近消息失败',
          detail: `失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'get_session_statistics') {
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-session-stats`
      const inferredRange = route.timeRange || inferTimeRangeFromQuestion(options.question)
      const label = action.label || inferredRange?.label || '全部消息'

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '统计当前会话',
        detail: action.reason ? `${label}；${action.reason}` : label,
        toolName: 'get_session_statistics'
      })

      try {
        const stats = await loadSessionStatistics(options.sessionId, action, inferredRange)
        if (stats.toolCall) toolCalls.push(stats.toolCall)
        const payload = stats.payload
        const statsText = payload ? formatSessionStatisticsText(payload) : '未读取到会话统计。'
        aggregateText = aggregateText ? `${aggregateText}\n\n${statsText}` : statsText

        if (payload?.samples?.length) {
          for (const message of payload.samples) {
            const ref = toEvidenceRef(options.sessionId, message)
            if (ref) evidenceCandidates.push(ref)
          }
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: payload && payload.totalMessages > 0 ? 'completed' : 'failed',
          title: '统计当前会话',
          detail: payload
            ? `统计 ${payload.totalMessages} 条消息，扫描 ${payload.scannedMessages} 条${payload.truncated ? '，已截断' : ''}`
            : '没有统计结果',
          toolName: 'get_session_statistics',
          count: payload?.totalMessages || 0
        })

        observations.push({
          title: '统计当前会话',
          detail: statsText
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '统计当前会话失败',
          detail: compactText(String(error), 120),
          toolName: 'get_session_statistics'
        })
        observations.push({
          title: '统计当前会话失败',
          detail: `失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'get_keyword_statistics') {
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-keyword-stats`
      const inferredRange = route.timeRange || inferTimeRangeFromQuestion(options.question)
      const keywords = action.keywords.filter((keyword) => !isGenericSearchQuery(keyword)).slice(0, 6)

      if (keywords.length === 0) {
        observations.push({
          title: '跳过关键词统计',
          detail: '没有可用关键词，改用会话统计或其它工具。'
        })
        continue
      }

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '统计关键词',
        detail: action.reason ? `关键词：${keywords.join('、')}；${action.reason}` : `关键词：${keywords.join('、')}`,
        toolName: 'get_keyword_statistics',
        query: keywords.join(' ')
      })

      try {
        const stats = await loadKeywordStatistics(options.sessionId, { ...action, keywords }, inferredRange)
        if (stats.toolCall) toolCalls.push(stats.toolCall)
        const payload = stats.payload
        const statsText = payload ? formatKeywordStatisticsText(payload) : '未读取到关键词统计。'
        aggregateText = aggregateText ? `${aggregateText}\n\n${statsText}` : statsText

        if (payload) {
          for (const keywordStat of payload.keywords) {
            for (const sample of keywordStat.samples) {
              const ref = toEvidenceRef(options.sessionId, sample.message, sample.excerpt)
              if (ref) evidenceCandidates.push(ref)
            }
          }
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: payload && payload.matchedMessages > 0 ? 'completed' : 'failed',
          title: '统计关键词',
          detail: payload
            ? `命中 ${payload.matchedMessages} 条消息，扫描 ${payload.scannedMessages} 条${payload.truncated ? '，已截断' : ''}`
            : '没有统计结果',
          toolName: 'get_keyword_statistics',
          query: keywords.join(' '),
          count: payload?.matchedMessages || 0
        })

        observations.push({
          title: '统计关键词',
          detail: statsText
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '统计关键词失败',
          detail: compactText(String(error), 120),
          toolName: 'get_keyword_statistics',
          query: keywords.join(' ')
        })
        observations.push({
          title: '统计关键词失败',
          detail: `失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'aggregate_messages') {
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-aggregate`
      const inferredRange = route.timeRange || inferTimeRangeFromQuestion(options.question)
      const senderUsername = resolvedParticipants.find((item) => item.senderUsername)?.senderUsername
      let messages = dedupeMessagesByCursor(contextWindows.flatMap((window) => window.messages))

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '整理统计',
        detail: route.intent === 'stats_or_count'
          ? '正在按完整范围读取并统计消息'
          : action.reason || '对已读取消息做计数、分组和趋势整理',
        toolName: 'aggregate_messages',
        count: messages.length
      })

      if (route.intent === 'stats_or_count') {
        try {
          const directMessages = await loadMessagesByTimeRangeAll(options.sessionId, {
            startTime: inferredRange?.startTime,
            endTime: inferredRange?.endTime,
            senderUsername,
            maxMessages: 10000
          })
          if (directMessages.length > messages.length) {
            messages = dedupeMessagesByCursor(directMessages)
          }
        } catch (error) {
          observations.push({
            title: '完整统计读取失败',
            detail: `回退到已读取上下文统计：${compactText(String(error), 160)}。`
          })
        }
      }

      aggregateText = aggregateMessages(messages, action.metric)
      toolCalls.push({
        toolName: 'aggregate_messages',
        args: { metric: action.metric || 'summary', messageCount: messages.length },
        summary: aggregateText,
        status: messages.length > 0 ? 'completed' : 'failed',
        evidenceCount: messages.length
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: messages.length > 0 ? 'completed' : 'failed',
        title: '整理统计',
        detail: messages.length > 0 ? `已整理 ${messages.length} 条消息` : '没有可聚合的消息',
        toolName: 'aggregate_messages',
        count: messages.length
      })

      observations.push({
        title: '整理统计',
        detail: aggregateText
      })

      continue
    }

    if (action.action === 'search_messages') {
      const query = normalizeSearchQuery(action.query, 48)
      const queryKey = query.toLowerCase()
      if (!query || searchedQueries.has(queryKey)) {
        observations.push({
          title: '跳过重复检索',
          detail: query ? `关键词“${query}”已检索过，请换更短或同义关键词。` : '模型给出的关键词为空。'
        })
        continue
      }

      searchedQueries.add(queryKey)
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-search`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '搜索相关消息',
        detail: action.reason ? `关键词：${query}；${action.reason}` : `关键词：${query}`,
        toolName: 'search_messages',
        query
      })

      try {
        const search = await searchSessionMessages(options.sessionId, query, {
          provider: options.provider,
          model: options.model,
          originalQuestion: options.question,
          sessionName: options.sessionName || options.sessionId,
          semanticQuery: `${query} ${options.question}`,
          startTime: route.timeRange?.startTime,
          endTime: route.timeRange?.endTime,
          senderUsername: route.intent === 'participant_focus'
            ? resolvedParticipants.find((item) => item.senderUsername)?.senderUsername
            : undefined
        })
        if (search.toolCall) toolCalls.push(search.toolCall)
        if (search.payload) {
          searchPayloads.push({ query, payload: search.payload })
          addKnownHits(query, search.payload)
        }
        if (search.contextWindows?.length) {
          for (const window of search.contextWindows) {
            contextWindows.push(window)
            addContextEvidence(window.messages)
            if (window.anchor) {
              readContextKeys.add(getMessageCursorKey(window.anchor))
            }
          }
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '搜索相关消息',
          detail: `关键词：${query}，命中 ${search.payload?.hits.length || 0} 条`,
          toolName: 'search_messages',
          query,
          count: search.payload?.hits.length || 0,
          diagnostics: [
            ...(search.diagnostics || []),
            ...getSearchDiagnostics(search.payload)
          ]
        })

        observations.push({
          title: '搜索相关消息',
          detail: [
            summarizeSearchObservation(query, search.payload, knownHits),
            search.contextWindows?.length ? `新检索链路已展开 ${search.contextWindows.length} 个证据上下文窗口。` : '',
            search.diagnostics?.length ? search.diagnostics.join('\n') : ''
          ].filter(Boolean).join('\n')
        })

        if ((search.payload?.hits.length || 0) === 0 && toolCallsUsed < MAX_TOOL_CALLS - 1) {
          const failure = interpretSearchFailure(search.payload)
          if (failure.reason === 'content_not_found') {
            observations.push({
              title: '搜索无结果（内容不存在）',
              detail: failure.suggestion
            })
          } else if (searchRetries < MAX_SEARCH_RETRIES) {
            searchRetries += 1
            observations.push({
              title: '搜索策略调整',
              detail: `关键词"${query}"搜索 0 命中。${failure.suggestion}（第 ${searchRetries} 次重试机会）`
            })
          }
        }
      } catch (error) {
        toolCalls.push({
          toolName: 'search_messages',
          args: { sessionId: options.sessionId, query },
          summary: `检索失败：${String(error)}`
        })

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '搜索相关消息失败',
          detail: `关键词：${query}，${compactText(String(error), 120)}`,
          toolName: 'search_messages',
          query
        })

        observations.push({
          title: '搜索相关消息失败',
          detail: `关键词：${query}，失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'read_context') {
      const target = findKnownHitForAction(action, knownHits)
      if (!target) {
        observations.push({
          title: '读取命中上下文',
          detail: '没有可读取的搜索命中，请先搜索或读取最近消息。'
        })
        continue
      }

      const contextKey = getMessageCursorKey(target.message)
      if (readContextKeys.has(contextKey)) {
        observations.push({
          title: '跳过重复上下文',
          detail: `${target.hitId} 已读取过前后文，请选择其他命中或开始回答。`
        })
        continue
      }

      readContextKeys.add(contextKey)
      toolCallsUsed += 1
      const beforeLimit = clampToolLimit(action.beforeLimit, SEARCH_CONTEXT_BEFORE, 12)
      const afterLimit = clampToolLimit(action.afterLimit, SEARCH_CONTEXT_AFTER, 12)
      const progressId = `tool-loop-${toolCallsUsed}-context`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取命中上下文',
        detail: `${target.hitId}，关键词：${target.query}，读取前 ${beforeLimit} 条后 ${afterLimit} 条`,
        toolName: 'read_context',
        query: target.query
      })

      try {
        const context = await loadContextAroundMessage(options.sessionId, target.message, beforeLimit, afterLimit)
        if (context.toolCall) toolCalls.push(context.toolCall)
        const messages = context.payload?.items || []
        contextWindows.push({
          source: 'search',
          query: target.query,
          anchor: target.message,
          messages
        })

        for (const message of messages) {
          const ref = toEvidenceRef(options.sessionId, message)
          if (ref) evidenceCandidates.push(ref)
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '读取命中上下文',
          detail: `${target.hitId}，读取到 ${messages.length} 条上下文消息`,
          toolName: 'read_context',
          query: target.query,
          count: messages.length
        })

        observations.push({
          title: '读取命中上下文',
          detail: `${target.hitId}，关键词：${target.query}，读取到 ${messages.length} 条。\n${messages.slice(0, 10).map(formatMessageLine).join('\n')}`
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '读取命中上下文失败',
          detail: `${target.hitId}，${compactText(String(error), 120)}`,
          toolName: 'read_context',
          query: target.query
        })

        observations.push({
          title: '读取命中上下文失败',
          detail: `${target.hitId}，失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'read_latest') {
      usedRecentFallback = true
      toolCallsUsed += 1
      const latestLimit = clampToolLimit(action.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES)
      const progressId = `tool-loop-${toolCallsUsed}-latest`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取最近上下文',
        detail: action.reason ? `读取最近 ${latestLimit} 条；${action.reason}` : `读取最近 ${latestLimit} 条消息`,
        toolName: 'read_latest'
      })

      try {
        const latest = await loadLatestContext(options.sessionId, latestLimit)
        if (latest.toolCall) toolCalls.push(latest.toolCall)
        const latestMessages = latest.payload?.items || []
        contextWindows.push({
          source: 'latest',
          messages: latestMessages
        })

        for (const message of latestMessages.slice(-8)) {
          const ref = toEvidenceRef(options.sessionId, message)
          if (ref) evidenceCandidates.push(ref)
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '读取最近上下文',
          detail: `读取到 ${latestMessages.length} 条最近消息`,
          toolName: 'read_latest',
          count: latestMessages.length
        })

        observations.push({
          title: '读取最近上下文',
          detail: `读取到 ${latestMessages.length} 条最近消息。\n${latestMessages.slice(0, 10).map(formatMessageLine).join('\n')}`
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '读取最近上下文失败',
          detail: compactText(String(error), 120),
          toolName: 'read_latest'
        })

        observations.push({
          title: '读取最近上下文失败',
          detail: `失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }
  }

  if (!currentEvidenceState() && toolCallsUsed < MAX_TOOL_CALLS) {
    usedRecentFallback = true
    toolCallsUsed += 1
    const progressId = `tool-loop-${toolCallsUsed}-latest-final`

    emitProgress(options, {
      id: progressId,
      stage: 'tool',
      status: 'running',
      title: '读取最近上下文',
      detail: '回答前仍缺少证据，读取最近消息兜底',
      toolName: 'read_latest'
    })

    try {
      const latest = await loadLatestContext(options.sessionId, MAX_CONTEXT_MESSAGES)
      if (latest.toolCall) toolCalls.push(latest.toolCall)
      const latestMessages = latest.payload?.items || []
      contextWindows.push({
        source: 'latest',
        messages: latestMessages
      })

      for (const message of latestMessages.slice(-8)) {
        const ref = toEvidenceRef(options.sessionId, message)
        if (ref) evidenceCandidates.push(ref)
      }

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'completed',
        title: '读取最近上下文',
        detail: `读取到 ${latestMessages.length} 条最近消息`,
        toolName: 'read_latest',
        count: latestMessages.length
      })
    } catch (error) {
      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'failed',
        title: '读取最近上下文失败',
        detail: compactText(String(error), 120),
        toolName: 'read_latest'
      })
    }
  }

  const contextMessageCount = dedupeMessagesByCursor(contextWindows.flatMap((window) => window.messages)).length
  const totalSearchHits = searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)

  emitProgress(options, {
    id: 'context',
    stage: 'context',
    status: 'completed',
    title: '整理回答依据',
    detail: `摘要${summaryFactsRead ? '可用' : '未用'}；搜索命中 ${totalSearchHits} 条；读取消息 ${contextMessageCount} 条${aggregateText ? '；已聚合' : ''}`,
    count: contextMessageCount
  })

  const promptText = buildAnswerPrompt({
    sessionName: options.sessionName || options.sessionId,
    question: options.question,
    route,
    summaryText: options.summaryText,
    structuredContext,
    summaryFactsText,
    contextWindows,
    searchPayloads,
    aggregateText,
    resolvedParticipants,
    historyText,
    usedRecentFallback
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: '你是严谨的本地聊天记录问答助手。你必须基于给定上下文回答，并在证据不足时明确承认不足。'
    },
    {
      role: 'user',
      content: promptText
    }
  ]

  emitProgress(options, {
    id: 'answer',
    stage: 'answer',
    status: 'running',
    title: '生成回答',
    detail: '正在基于上下文生成回答'
  })

  const enableThinking = options.enableThinking !== false
  const thinkFilterState = { isThinking: false }
  await options.provider.streamChat(
    messages,
    {
      model: options.model,
      temperature: 0.3,
      maxTokens: agentAnswerMaxTokens,
      enableThinking
    },
    (chunk) => {
      const visibleChunk = enableThinking ? chunk : filterThinkChunk(chunk, thinkFilterState)
      if (!visibleChunk) return
      answerText += visibleChunk
      options.onChunk(visibleChunk)
    }
  )

  const finalAnswerText = stripThinkBlocks(answerText)

  emitProgress(options, {
    id: 'answer',
    stage: 'answer',
    status: 'completed',
    title: '生成回答',
    detail: '回答生成完成'
  })

  return {
    answerText: finalAnswerText,
    evidenceRefs: dedupeEvidenceRefs(evidenceCandidates),
    toolCalls,
    promptText: lastAgentPrompt ? `${lastAgentPrompt}\n\n--- final answer prompt ---\n${promptText}` : promptText
  }
}

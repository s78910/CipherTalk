/**
 * Agent 专用统计工具。
 */
import { agentDataRepository } from '../data/repository'
import type { AgentKeywordStats, AgentMessage, AgentParticipantStatistics, AgentSessionStats } from '../data/models'
import type { SessionQAToolCall, TimeRangeHint, ToolLoopAction } from '../types'
import { formatTime } from '../utils/time'

type AgentMessagesPayload = {
  items: AgentMessage[]
  offset: number
  limit: number
  hasMore: boolean
}

function buildParticipantRankings(messages: AgentMessage[], participantLimit = 20): AgentParticipantStatistics[] {
  const map = new Map<string, AgentParticipantStatistics>()
  for (const message of messages) {
    const key = message.sender.username || (message.sender.isSelf ? '__self__' : message.sender.displayName || 'unknown')
    const existing = map.get(key) || {
      senderUsername: message.sender.username || undefined,
      displayName: message.sender.displayName || undefined,
      role: message.sender.isSelf ? 'self' as const : 'participant' as const,
      messageCount: 0,
      sentCount: 0,
      receivedCount: 0
    }
    existing.messageCount += 1
    if (message.direction === 'out') existing.sentCount += 1
    else existing.receivedCount += 1
    map.set(key, existing)
  }
  return Array.from(map.values())
    .sort((a, b) => b.messageCount - a.messageCount || (a.displayName || '').localeCompare(b.displayName || '', 'zh-CN'))
    .slice(0, participantLimit)
}

function formatParticipantStatsLines(items: AgentParticipantStatistics[]): string {
  if (!items.length) return '无参与者统计。'
  return items.slice(0, 12).map((item, index) =>
    `${index + 1}. ${item.displayName || item.senderUsername || item.role}：${item.messageCount} 条（发出 ${item.sentCount}，收到 ${item.receivedCount}）`
  ).join('\n')
}

export function formatSessionStatisticsText(payload: AgentSessionStats): string {
  const kindCounts = Object.entries(payload.kindCounts).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}=${count}`).join('，') || '无'
  const activeHours = Object.entries(payload.hourlyDistribution).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([hour, count]) => `${hour}时=${count}`).join('，') || '无'
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

export function formatKeywordStatisticsText(payload: AgentKeywordStats): string {
  const lines = payload.keywords.map((item) => {
    const topParticipants = item.participantRankings.slice(0, 5).map((p) => `${p.displayName || p.senderUsername || p.role}=${p.messageCount}`).join('，') || '无'
    const activeHours = Object.entries(item.hourlyDistribution).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hour, count]) => `${hour}时=${count}`).join('，') || '无'
    return [
      `关键词"${item.keyword}"：命中 ${item.hitCount} 条消息，出现 ${item.occurrenceCount} 次。`,
      `首次：${item.firstHitTime ? formatTime(item.firstHitTime * 1000) : '无'}；末次：${item.lastHitTime ? formatTime(item.lastHitTime * 1000) : '无'}。`,
      `发送者分布：${topParticipants}。`,
      `高频小时：${activeHours}。`
    ].join('\n')
  })
  return [`关键词统计：${payload.session.displayName}`, ...lines, `扫描 ${payload.scannedMessages} 条，命中 ${payload.matchedMessages} 条${payload.truncated ? '，结果因扫描上限被截断' : ''}。`].join('\n\n')
}

export async function loadSessionStatistics(sessionId: string, action: Extract<ToolLoopAction, { action: 'get_session_statistics' }>, fallbackRange?: TimeRangeHint): Promise<{ payload?: AgentSessionStats; toolCall?: SessionQAToolCall }> {
  const startTime = action.startTime || fallbackRange?.startTime
  const endTime = action.endTime || fallbackRange?.endTime
  const participantLimit = action.participantLimit || 20
  const result = agentDataRepository.getMessages(sessionId, { startTime, endTime, order: 'asc', limit: 20000 })
  const messages = result.items
  const displayMap = agentDataRepository.loadDisplayNameMap(sessionId)
  const daySet = new Set<string>()
  const kindCounts: Record<string, number> = {}
  const hourlyDistribution: Record<string, number> = {}
  for (const message of messages) {
    kindCounts[message.kind] = (kindCounts[message.kind] || 0) + 1
    const date = new Date(message.timestampMs)
    daySet.add(`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`)
    const hour = String(date.getHours())
    hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1
  }
  const payload: AgentSessionStats = {
    session: agentDataRepository.getSessionRef(sessionId, displayMap),
    totalMessages: messages.length,
    sentMessages: messages.filter((m) => m.direction === 'out').length,
    receivedMessages: messages.filter((m) => m.direction !== 'out').length,
    activeDays: daySet.size,
    firstMessageTime: messages[0]?.timestamp,
    lastMessageTime: messages[messages.length - 1]?.timestamp,
    kindCounts,
    hourlyDistribution,
    participantRankings: buildParticipantRankings(messages, participantLimit),
    samples: action.includeSamples ? messages.filter((m) => m.text).slice(0, 5) : [],
    scannedMessages: result.scanned,
    matchedMessages: messages.length,
    truncated: result.hasMore
  }
  const args = { sessionId, startTime, endTime, includeSamples: action.includeSamples || false, participantLimit }
  return {
    payload,
    toolCall: {
      toolName: 'get_session_statistics',
      displayName: '运行统计',
      nodeName: '运行统计',
      args,
      summary: formatSessionStatisticsText(payload),
      status: payload.totalMessages > 0 ? 'completed' : 'failed',
      evidenceCount: payload.totalMessages
    }
  }
}

export async function loadKeywordStatistics(sessionId: string, action: Extract<ToolLoopAction, { action: 'get_keyword_statistics' }>, fallbackRange?: TimeRangeHint): Promise<{ payload?: AgentKeywordStats; toolCall?: SessionQAToolCall }> {
  const startTime = action.startTime || fallbackRange?.startTime
  const endTime = action.endTime || fallbackRange?.endTime
  const displayMap = agentDataRepository.loadDisplayNameMap(sessionId)
  const all = agentDataRepository.getMessages(sessionId, { startTime, endTime, order: 'asc', limit: 20000 })
  const matchedMessageKeys = new Set<string>()
  const keywordItems = action.keywords.map((keyword) => {
    const normalized = keyword.toLowerCase()
    const matched = all.items.filter((message) => {
      const text = `${message.text}\n${message.raw?.rawContent || ''}`.toLowerCase()
      return action.matchMode === 'exact' ? text.trim() === normalized : text.includes(normalized)
    })
    const hourlyDistribution: Record<string, number> = {}
    let occurrenceCount = 0
    for (const message of matched) {
      matchedMessageKeys.add(`${message.cursor.localId}:${message.cursor.createTime}:${message.cursor.sortSeq}`)
      const text = `${message.text}\n${message.raw?.rawContent || ''}`.toLowerCase()
      occurrenceCount += action.matchMode === 'exact'
        ? 1
        : Math.max(1, text.split(normalized).length - 1)
      const hour = String(new Date(message.timestampMs).getHours())
      hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1
    }
    return {
      keyword,
      hitCount: matched.length,
      occurrenceCount,
      firstHitTime: matched[0]?.timestamp,
      lastHitTime: matched[matched.length - 1]?.timestamp,
      participantRankings: buildParticipantRankings(matched, action.participantLimit || 20),
      hourlyDistribution,
      samples: matched.slice(0, 5).map((message) => ({ message, excerpt: message.text }))
    }
  })
  const payload: AgentKeywordStats = {
    session: agentDataRepository.getSessionRef(sessionId, displayMap),
    keywords: keywordItems,
    scannedMessages: all.scanned,
    matchedMessages: matchedMessageKeys.size,
    truncated: all.hasMore
  }
  const args = { sessionId, keywords: action.keywords, startTime, endTime, matchMode: action.matchMode || 'substring', participantLimit: action.participantLimit || 20 }
  return {
    payload,
    toolCall: {
      toolName: 'get_keyword_statistics',
      displayName: '关键词统计',
      nodeName: '关键词统计',
      args,
      summary: formatKeywordStatisticsText(payload),
      status: payload.matchedMessages > 0 ? 'completed' : 'failed',
      evidenceCount: payload.matchedMessages
    }
  }
}

export async function loadMessagesByTimeRange(sessionId: string, input: { startTime?: number; endTime?: number; keyword?: string; senderUsername?: string; limit?: number; order?: 'asc' | 'desc' }): Promise<{ payload?: AgentMessagesPayload; toolCall?: SessionQAToolCall }> {
  const result = agentDataRepository.getMessages(sessionId, {
    startTime: input.startTime,
    endTime: input.endTime,
    keyword: input.keyword,
    senderUsername: input.senderUsername,
    limit: input.limit || 80,
    order: input.order || 'asc'
  })
  const payload: AgentMessagesPayload = {
    items: result.items,
    offset: 0,
    limit: input.limit || 80,
    hasMore: result.hasMore
  }
  const args = { sessionId, offset: 0, limit: payload.limit, order: input.order || 'asc', ...(input.startTime ? { startTime: input.startTime } : {}), ...(input.endTime ? { endTime: input.endTime } : {}), ...(input.keyword ? { keyword: input.keyword } : {}), ...(input.senderUsername ? { senderUsername: input.senderUsername } : {}) }
  return {
    payload,
    toolCall: {
      toolName: 'read_by_time_range',
      displayName: input.startTime || input.endTime ? '按时间读取' : '读取最近消息',
      nodeName: input.startTime || input.endTime ? '按时间读取' : '读取最近消息',
      args,
      summary: `读取到 ${payload.items.length} 条消息。`,
      status: payload.items.length > 0 ? 'completed' : 'failed',
      evidenceCount: payload.items.length
    }
  }
}

export async function loadMessagesByTimeRangeAll(sessionId: string, input: { startTime?: number; endTime?: number; senderUsername?: string; keyword?: string; maxMessages?: number }): Promise<AgentMessage[]> {
  return agentDataRepository.getMessages(sessionId, {
    startTime: input.startTime,
    endTime: input.endTime,
    senderUsername: input.senderUsername,
    keyword: input.keyword,
    order: 'asc',
    limit: input.maxMessages || 10000
  }).items
}

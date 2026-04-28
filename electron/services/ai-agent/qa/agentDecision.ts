/**
 * Agent 工具参数规范化。
 *
 * 旧版这里会解析模型输出的 JSON action；现在主循环改为原生
 * tools/tool_calls，本文件只保留本地安全校验和参数标准化。
 */
import type {
  ToolLoopAction
} from './types'
import {
  MAX_CONTEXT_MESSAGES,
  SEARCH_CONTEXT_BEFORE,
  SEARCH_CONTEXT_AFTER
} from './types'
import { compactText, isRecord, clampToolLimit } from './utils/text'
import { normalizeSearchQuery } from './utils/search'
import { normalizeStringArray } from './utils/text'

/**
 * 将模型原始输出规范化为 ToolLoopAction
 */
export function normalizeToolAction(raw: unknown): ToolLoopAction | null {
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

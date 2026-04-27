/**
 * Agent 专用搜索/检索工具集成。
 */
import type { AIProvider } from '../../../ai/providers/base'
import { agentDataRepository } from '../data/repository'
import { agentRetriever } from '../data/retriever'
import type { AgentMessage, AgentSearchResult } from '../data/models'
import type { ContextWindow, QueryRewriteResult, SessionQAToolCall } from '../types'
import {
  MAX_CONTEXT_MESSAGES,
  MAX_REWRITE_INPUT_CHARS,
  MAX_REWRITE_KEYWORD_QUERIES,
  MAX_REWRITE_SEMANTIC_QUERIES,
  MAX_SEARCH_HITS
} from '../types'
import { compactText, stripJsonFence, stripThinkBlocks, uniqueCompactQueries } from '../utils/text'

function normalizeRewriteArray(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return uniqueCompactQueries(value.map((item: unknown) => String(item || '')), limit, maxLength)
}

export async function rewriteRetrievalQuery(
  provider: AIProvider | undefined,
  model: string | undefined,
  input: { question: string; searchQuery: string; sessionName?: string; senderUsername?: string; startTime?: number; endTime?: number }
): Promise<QueryRewriteResult> {
  if (!provider || !model) {
    return { applied: false, keywordQueries: [], semanticQueries: [], diagnostics: ['查询改写：跳过，缺少模型配置。'] }
  }

  try {
    const question = compactText(input.question, MAX_REWRITE_INPUT_CHARS)
    const response = await provider.chat([
      { role: 'system', content: '你是 CipherTalk 会话问答的检索查询改写器。只输出严格 JSON，不要解释，不要 Markdown。' },
      { role: 'user', content: `请把用户关于单个微信会话的问题改写为更适合本地混合检索的查询。必须保留人名、时间、地点、产品名、技术名、专有名词；不要编造事实；统计、计数、时间范围类问题不要改写成摘要型问题。输出 JSON 字段：semanticQuery, keywordQueries, semanticQueries, reason。\n\n会话：${input.sessionName || '当前会话'}\n用户原问题：${question}\n当前关键词：${input.searchQuery || '无'}\nsenderUsername 过滤：${input.senderUsername || '无'}\n开始时间秒：${input.startTime || '无'}\n结束时间秒：${input.endTime || '无'}\n\n约束：\n- semanticQuery 必须是 1 个适合语义检索的完整短句。\n- keywordQueries 最多 4 个。\n- semanticQueries 最多 3 个。\n- reason 一句话说明改写原因。` }
    ], { model, temperature: 0.1, maxTokens: 500, enableThinking: false })
    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(response))) as Record<string, unknown>
    const semanticQuery = compactText(String(parsed.semanticQuery || ''), 180)
    const keywordQueries = normalizeRewriteArray(parsed.keywordQueries, MAX_REWRITE_KEYWORD_QUERIES, 48)
    const semanticQueries = normalizeRewriteArray(parsed.semanticQueries, MAX_REWRITE_SEMANTIC_QUERIES, 160)
    const reason = compactText(String(parsed.reason || ''), 160)
    if (!semanticQuery && keywordQueries.length === 0 && semanticQueries.length === 0) {
      return { applied: false, keywordQueries: [], semanticQueries: [], reason, diagnostics: ['查询改写：失败，结果为空。'] }
    }
    return {
      applied: true,
      semanticQuery: semanticQuery || semanticQueries[0],
      keywordQueries,
      semanticQueries,
      reason,
      diagnostics: [`查询改写：已应用，语义查询=${compactText(semanticQuery || semanticQueries[0] || '', 120)}`]
    }
  } catch (error) {
    return { applied: false, keywordQueries: [], semanticQueries: [], diagnostics: [`查询改写：失败，${compactText(String(error), 120)}`] }
  }
}

export async function searchSessionMessages(sessionId: string, query: string, filters: {
  provider?: AIProvider
  model?: string
  originalQuestion?: string
  semanticQuery?: string
  senderUsername?: string
  startTime?: number
  endTime?: number
  limit?: number
  sessionName?: string
  contactMap?: Map<string, string>
} = {}): Promise<{ payload?: AgentSearchResult; toolCall?: SessionQAToolCall; contextWindows?: ContextWindow[]; diagnostics?: string[] }> {
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
  const keywordQueries = uniqueCompactQueries([query, retrievalQuery, ...rewrite.keywordQueries], MAX_REWRITE_KEYWORD_QUERIES + 2, 80)
  const semanticQueries = uniqueCompactQueries([semanticQuery, fallbackSemanticQuery, ...rewrite.semanticQueries], MAX_REWRITE_SEMANTIC_QUERIES + 2, 180)
  const { result, contextWindows } = await agentRetriever.search({
    sessionId,
    sessionName: filters.sessionName,
    query: retrievalQuery,
    semanticQuery,
    keywordQueries,
    semanticQueries,
    startTime: filters.startTime,
    endTime: filters.endTime,
    senderUsername: filters.senderUsername,
    limit: filters.limit || MAX_SEARCH_HITS,
    expandEvidence: true
  })
  return {
    payload: result,
    contextWindows,
    diagnostics: [...rewrite.diagnostics, ...result.diagnostics],
    toolCall: {
      toolName: 'search_messages',
      displayName: '语义搜索',
      nodeName: '语义搜索',
      args: {
        sessionId,
        query,
        queryRewrite: rewrite.applied ? 'applied' : 'fallback',
        limit: filters.limit || MAX_SEARCH_HITS
      },
      summary: `Agent 检索命中 ${result.hits.length} 条`,
      status: 'completed',
      evidenceCount: result.hits.length
    }
  }
}

export async function loadLatestContext(sessionId: string, limit = MAX_CONTEXT_MESSAGES): Promise<{ payload?: { items: AgentMessage[] }; toolCall?: SessionQAToolCall }> {
  const items = agentDataRepository.getMessages(sessionId, { order: 'desc', limit }).items.sort((a, b) =>
    a.cursor.sortSeq - b.cursor.sortSeq
    || a.cursor.createTime - b.cursor.createTime
    || a.cursor.localId - b.cursor.localId
  )
  const args = { sessionId, mode: 'latest', limit }
  return {
    payload: { items },
    toolCall: {
      toolName: 'read_latest',
      displayName: '读取最近消息',
      nodeName: '读取最近消息',
      args,
      summary: `读取到 ${items.length} 条最近消息。`,
      status: items.length > 0 ? 'completed' : 'failed',
      evidenceCount: items.length
    }
  }
}

export async function loadContextAroundMessage(sessionId: string, message: AgentMessage, beforeLimit: number, afterLimit: number): Promise<{ payload?: { items: AgentMessage[] }; toolCall?: SessionQAToolCall }> {
  const items = agentDataRepository.getContextAround(sessionId, message.cursor, beforeLimit, afterLimit)
  const args = { sessionId, mode: 'around', anchorCursor: message.cursor, beforeLimit, afterLimit }
  return {
    payload: { items },
    toolCall: {
      toolName: 'read_context',
      displayName: '读取上下文',
      nodeName: '读取上下文',
      args,
      summary: `读取到 ${items.length} 条上下文消息。`,
      status: items.length > 0 ? 'completed' : 'failed',
      evidenceCount: items.length
    }
  }
}

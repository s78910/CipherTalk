import type Database from 'better-sqlite3'
import type {
  AgentContextWindow,
  AgentCursor,
  AgentIndexDiagnostics,
  AgentMemoryItem,
  AgentMessage,
  AgentRetrievalSource,
  AgentSearchHit,
  AgentSearchResult,
  AgentVectorDiagnostics
} from './models'
import { agentEmbeddingRuntime } from './embeddingRuntime'
import { agentDataRepository, buildAgentFtsQuery } from './repository'

type IndexRow = {
  id: number
  session_id: string
  local_id: number
  server_id: number
  local_type: number
  create_time: number
  sort_seq: number
  is_send: number | null
  sender_username: string | null
  parsed_content: string
  raw_content: string
  search_text: string
  token_text: string
  message_json: string
  rank?: number
  vector_id?: number
}

type SearchInput = {
  sessionId: string
  sessionName?: string
  query: string
  semanticQuery?: string
  keywordQueries?: string[]
  semanticQueries?: string[]
  startTime?: number
  endTime?: number
  senderUsername?: string
  limit?: number
  expandEvidence?: boolean
}

const MAX_INDEX_CANDIDATES = 240
const VECTOR_OVERFETCH = 8
const VECTOR_MIN_SCORE = 0.35

function toTimestampMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function compactText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function compareCursorAsc(a: AgentCursor, b: AgentCursor): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function createExcerpt(source: string, matchedIndex: number, queryLength: number): string {
  const text = String(source || '')
  if (!text) return ''
  const start = Math.max(0, matchedIndex - 48)
  const end = Math.min(text.length, matchedIndex + Math.max(1, queryLength) + 48)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

function normalizeSearchText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueQueries(values: Array<string | undefined>, limit = 8): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const query = String(value || '').trim()
    const key = normalizeSearchText(query)
    if (!query || !key || seen.has(key)) continue
    seen.add(key)
    result.push(query)
    if (result.length >= limit) break
  }
  return result
}

function sessionKey(sessionId: string): number {
  let hash = 2166136261
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function scoreByRank(rank: number, base: number): number {
  return Number((base + 1 / (60 + Math.max(1, rank))).toFixed(6))
}

function rowToMessage(row: IndexRow, displayNameMap: Map<string, string>): AgentMessage {
  try {
    const parsed = JSON.parse(String(row.message_json || '{}')) as Record<string, unknown>
    const source = {
      localId: Number(parsed.localId ?? row.local_id ?? 0),
      serverId: Number(parsed.serverId ?? row.server_id ?? 0),
      localType: Number(parsed.localType ?? row.local_type ?? 0),
      createTime: Number(parsed.createTime ?? row.create_time ?? 0),
      sortSeq: Number(parsed.sortSeq ?? row.sort_seq ?? 0),
      isSend: (parsed.isSend ?? row.is_send ?? null) as number | null,
      senderUsername: (parsed.senderUsername ?? row.sender_username ?? null) as string | null,
      parsedContent: String(parsed.parsedContent ?? row.parsed_content ?? ''),
      rawContent: String(parsed.rawContent ?? row.raw_content ?? '')
    }
    return agentDataRepository.sourceToAgentMessage(row.session_id, source, displayNameMap)
  } catch {
    return agentDataRepository.sourceToAgentMessage(row.session_id, {
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType: Number(row.local_type || 0),
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.is_send ?? null,
      senderUsername: row.sender_username ?? null,
      parsedContent: String(row.parsed_content || ''),
      rawContent: String(row.raw_content || '')
    }, displayNameMap)
  }
}

function matchIndexedText(row: IndexRow, query: string): { matchedField: 'text' | 'raw'; excerpt: string; score: number } {
  const exactQuery = String(query || '').trim()
  const normalizedQuery = normalizeSearchText(query)
  const text = String(row.parsed_content || '')
  const raw = String(row.raw_content || '')
  const searchText = String(row.search_text || '')
  const normalizedText = normalizeSearchText(text)
  const normalizedRaw = normalizeSearchText(raw)

  const textIndex = normalizedQuery ? normalizedText.indexOf(normalizedQuery) : -1
  if (textIndex >= 0) {
    return { matchedField: 'text', excerpt: createExcerpt(text || normalizedText, textIndex, normalizedQuery.length), score: 1400 - Math.min(textIndex, 500) }
  }

  const compactIndex = normalizedQuery ? searchText.replace(/\s+/g, '').indexOf(normalizedQuery.replace(/\s+/g, '')) : -1
  if (compactIndex >= 0) {
    return { matchedField: 'text', excerpt: createExcerpt(text || searchText, Math.min(compactIndex, Math.max(0, (text || searchText).length - 1)), normalizedQuery.length), score: 1180 - Math.min(compactIndex, 500) }
  }

  const rawIndex = exactQuery ? normalizedRaw.indexOf(normalizedQuery) : -1
  if (rawIndex >= 0) {
    return { matchedField: 'raw', excerpt: createExcerpt(raw || normalizedRaw, rawIndex, normalizedQuery.length), score: 880 - Math.min(rawIndex, 500) }
  }

  return { matchedField: 'text', excerpt: createExcerpt(text || searchText, 0, Math.max(normalizedQuery.length, 1)), score: 720 }
}

function buildIndexFilters(input: SearchInput, params: Record<string, unknown>): string[] {
  const filters = ['m.session_id = @sessionId']
  params.sessionId = input.sessionId
  if (input.startTime) {
    filters.push('m.create_time >= @startTime')
    params.startTime = Math.floor(input.startTime)
  }
  if (input.endTime) {
    filters.push('m.create_time <= @endTime')
    params.endTime = Math.floor(input.endTime)
  }
  if (input.senderUsername) {
    filters.push("lower(COALESCE(m.sender_username, '')) = @senderUsername")
    params.senderUsername = input.senderUsername.toLowerCase()
  }
  return filters
}

function loadSqliteVec(db: Database.Database): { available: boolean; error?: string } {
  try {
    const sqliteVec = require('sqlite-vec') as { load: (database: Database.Database) => void }
    sqliteVec.load(db)
    return { available: true }
  } catch (error) {
    return { available: false, error: String(error) }
  }
}

function memoryFilterSql(input: SearchInput, params: Record<string, unknown>): string {
  const filters: string[] = []
  if (input.sessionId) {
    filters.push('m.session_id = @sessionId')
    params.sessionId = input.sessionId
  }
  if (input.startTime) {
    filters.push('COALESCE(m.time_end, m.time_start, 0) >= @startTime')
    params.startTime = Math.floor(input.startTime)
  }
  if (input.endTime) {
    filters.push('COALESCE(m.time_start, m.time_end, 0) <= @endTime')
    params.endTime = Math.floor(input.endTime)
  }
  return filters.length ? `AND ${filters.join(' AND ')}` : ''
}

function parseMemorySearchRows(db: Database.Database, input: SearchInput, query: string, limit: number): Array<{ memory: AgentMemoryItem; source: AgentRetrievalSource; score: number; rank: number }> {
  const rowsById = new Map<number, { memory: AgentMemoryItem; source: AgentRetrievalSource; score: number; rank: number }>()
  const params: Record<string, unknown> = { limit }
  const filter = memoryFilterSql(input, params)
  const ftsQuery = buildAgentFtsQuery(query)
  if (ftsQuery) {
    try {
      const rows = db.prepare(`
        SELECT m.*, bm25(memory_items_fts) AS fts_rank
        FROM memory_items_fts
        JOIN memory_items m ON m.id = memory_items_fts.rowid
        WHERE memory_items_fts MATCH @ftsQuery
          ${filter}
        ORDER BY fts_rank ASC, COALESCE(m.time_end, m.time_start, m.updated_at) DESC, m.id DESC
        LIMIT @limit
      `).all({ ...params, ftsQuery }) as Array<Record<string, unknown> & { fts_rank?: number }>
      rows.forEach((row, index) => {
        const memory = agentDataRepository.parseMemoryRow(row)
        rowsById.set(memory.id, { memory, source: 'memory_fts', score: scoreByRank(index + 1, 1000), rank: index + 1 })
      })
    } catch {
      // FTS may not exist on old cache databases.
    }
  }

  try {
    const likeParams: Record<string, unknown> = { ...params, likeQuery: `%${query}%` }
    const likeRows = db.prepare(`
      SELECT m.*
      FROM memory_items m
      WHERE (
        m.title LIKE @likeQuery
        OR m.content LIKE @likeQuery
        OR m.entities_json LIKE @likeQuery
        OR m.tags_json LIKE @likeQuery
      )
        ${memoryFilterSql(input, likeParams)}
      ORDER BY COALESCE(m.time_end, m.time_start, m.updated_at) DESC, m.id DESC
      LIMIT @limit
    `).all(likeParams) as Array<Record<string, unknown>>
    let rank = 1
    for (const row of likeRows) {
      const memory = agentDataRepository.parseMemoryRow(row)
      if (!rowsById.has(memory.id)) {
        rowsById.set(memory.id, { memory, source: 'memory_like', score: scoreByRank(rank, 700), rank })
      }
      rank += 1
    }
  } catch {
    // ignore
  }

  return Array.from(rowsById.values())
}

export class AgentRetriever {
  async search(input: SearchInput): Promise<{ result: AgentSearchResult; contextWindows: AgentContextWindow[] }> {
    const limit = Math.max(1, Math.min(Math.floor(input.limit || 20), 100))
    const query = String(input.query || '').trim()
    const keywordQueries = uniqueQueries([query, ...(input.keywordQueries || [])])
    const displayNameMap = agentDataRepository.loadDisplayNameMap(input.sessionId)
    const session = agentDataRepository.getSessionRef(input.sessionId, displayNameMap)
    const diagnostics: string[] = []
    const hitBuckets: AgentSearchHit[] = []
    const indexStatus: AgentIndexDiagnostics = { ready: false, indexedMessages: 0 }
    let messagesScanned = 0

    if (!query) {
      return {
        result: {
          hits: [],
          limit,
          messagesScanned: 0,
          truncated: false,
          source: 'agent_hybrid',
          diagnostics: ['检索查询为空。']
        },
        contextWindows: []
      }
    }

    const indexDb = agentDataRepository.getSearchIndexDb()
    if (indexDb) {
      for (const keywordQuery of keywordQueries) {
        const indexed = this.searchMessageIndex(indexDb, input, keywordQuery, limit, displayNameMap)
        hitBuckets.push(...indexed.hits)
        messagesScanned += indexed.scanned
        indexStatus.ready = indexStatus.ready || indexed.ready
        indexStatus.indexedMessages = Math.max(indexStatus.indexedMessages, indexed.indexedMessages)
        if (indexed.error && !indexStatus.error) indexStatus.error = indexed.error
        diagnostics.push(...indexed.diagnostics)
      }
    } else {
      diagnostics.push('消息索引库不存在，改用原始消息扫描。')
    }

    const memoryDb = agentDataRepository.getMemoryDb()
    if (memoryDb) {
      for (const keywordQuery of keywordQueries) {
        const memoryHits = this.searchMemory(memoryDb, input, keywordQuery, limit, displayNameMap)
        hitBuckets.push(...memoryHits.hits)
        diagnostics.push(...memoryHits.diagnostics)
      }
    } else {
      diagnostics.push('记忆库不存在，跳过记忆检索。')
    }

    const vector = indexDb ? await this.searchVector(indexDb, input, displayNameMap) : {
      diagnostics: ['语义向量索引库不可用。'],
      hits: [],
      vectorSearch: { requested: true, attempted: false, providerAvailable: false, indexComplete: false, hitCount: 0, indexedMessages: 0, vectorizedMessages: 0, skippedReason: 'index_db_missing' } satisfies AgentVectorDiagnostics
    }
    hitBuckets.push(...vector.hits)
    diagnostics.push(...vector.diagnostics)

    if (hitBuckets.length === 0) {
      for (const keywordQuery of keywordQueries) {
        const raw = this.searchRawMessages(input, keywordQuery, limit, displayNameMap)
        hitBuckets.push(...raw.hits)
        messagesScanned += raw.scanned
        diagnostics.push(...raw.diagnostics)
        if (hitBuckets.length >= limit) break
      }
    }

    const hits = this.fuseHits(hitBuckets).slice(0, limit)
    const resultSource = this.detectResultSource(hits, indexStatus)
    const contextWindows = input.expandEvidence === false
      ? []
      : hits.slice(0, 4).map((hit) => ({
        source: 'search' as const,
        query,
        anchor: hit.message,
        messages: agentDataRepository.getContextAround(input.sessionId, hit.message.cursor, 4, 4)
      })).filter((window) => window.messages.length > 0)

    return {
      result: {
          hits,
          limit,
          messagesScanned,
          truncated: hitBuckets.length > limit,
          source: resultSource,
        indexStatus,
        vectorSearch: vector.vectorSearch,
        diagnostics
      },
      contextWindows
    }
  }

  private detectResultSource(hits: AgentSearchHit[], indexStatus: AgentIndexDiagnostics): AgentSearchResult['source'] {
    const sources = new Set(hits.map((hit) => hit.retrievalSource))
    if (sources.size === 0) return indexStatus.ready ? 'agent_index' : 'agent_raw_scan'
    if (sources.size > 1) return 'agent_hybrid'
    const [source] = Array.from(sources)
    if (source === 'raw_scan') return 'agent_raw_scan'
    if (source === 'memory_fts' || source === 'memory_like') return 'agent_memory'
    return 'agent_index'
  }

  private searchMessageIndex(db: Database.Database, input: SearchInput, query: string, limit: number, displayNameMap: Map<string, string>): { hits: AgentSearchHit[]; scanned: number; ready: boolean; indexedMessages: number; diagnostics: string[]; error?: string } {
    const params: Record<string, unknown> = { limit: Math.max(MAX_INDEX_CANDIDATES, limit) }
    const filters = buildIndexFilters(input, params)
    const rowsById = new Map<number, IndexRow>()
    let indexedMessages = 0

    try {
      const countRow = db.prepare('SELECT indexed_count FROM session_index_state WHERE session_id = ?').get(input.sessionId) as { indexed_count?: number } | undefined
      indexedMessages = Number(countRow?.indexed_count || 0)
    } catch {
      indexedMessages = 0
    }

    try {
      const ftsQuery = buildAgentFtsQuery(query)
      if (ftsQuery) {
        const ftsRows = db.prepare(`
          SELECT m.*, bm25(message_index_fts) AS rank
          FROM message_index_fts
          JOIN message_index m ON m.id = message_index_fts.rowid
          WHERE message_index_fts MATCH @ftsQuery
            AND ${filters.join(' AND ')}
          ORDER BY rank ASC, m.sort_seq DESC, m.create_time DESC, m.local_id DESC
          LIMIT @limit
        `).all({ ...params, ftsQuery }) as IndexRow[]
        for (const row of ftsRows) rowsById.set(Number(row.id), row)
      }

      const likeRows = db.prepare(`
        SELECT m.*
        FROM message_index m
        WHERE ${filters.join(' AND ')}
          AND (
            m.search_text LIKE @likeQuery
            OR replace(m.search_text, ' ', '') LIKE @compactLikeQuery
          )
        ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
        LIMIT @limit
      `).all({
        ...params,
        likeQuery: `%${query}%`,
        compactLikeQuery: `%${query.replace(/\s+/g, '') || query}%`
      }) as IndexRow[]
      for (const row of likeRows) rowsById.set(Number(row.id), row)

      const hits = Array.from(rowsById.values()).map((row) => {
        const match = matchIndexedText(row, query)
        return {
          session: agentDataRepository.getSessionRef(input.sessionId, displayNameMap),
          message: rowToMessage(row, displayNameMap),
          excerpt: match.excerpt,
          matchedField: match.matchedField,
          score: match.score,
          retrievalSource: 'keyword_index' as const
        }
      }).sort((a, b) => b.score - a.score || compareCursorAsc(b.message.cursor, a.message.cursor))

      return {
        hits: hits.slice(0, limit),
        scanned: rowsById.size,
        ready: indexedMessages > 0,
        indexedMessages,
        diagnostics: [`关键词索引：命中 ${hits.length} 条，已索引 ${indexedMessages} 条。`]
      }
    } catch (error) {
      return {
        hits: [],
        scanned: 0,
        ready: false,
        indexedMessages,
        error: String(error),
        diagnostics: [`关键词索引读取失败：${compactText(String(error), 120)}`]
      }
    }
  }

  private searchMemory(db: Database.Database, input: SearchInput, query: string, limit: number, displayNameMap: Map<string, string>): { hits: AgentSearchHit[]; diagnostics: string[] } {
    const rows = parseMemorySearchRows(db, input, query, Math.max(limit * 4, 40))
    const hits: AgentSearchHit[] = []
    const session = agentDataRepository.getSessionRef(input.sessionId, displayNameMap)

    for (const item of rows) {
      const ref = item.memory.sourceRefs.find((candidate) => candidate.sessionId === input.sessionId) || item.memory.sourceRefs[0]
      const message = ref
        ? agentDataRepository.getMessageByCursor(ref.sessionId, ref) || agentDataRepository.evidenceRefToMessage(ref, displayNameMap)
        : agentDataRepository.evidenceRefToMessage({
          sessionId: input.sessionId,
          localId: item.memory.id,
          createTime: Number(item.memory.timeStart || item.memory.timeEnd || 0),
          sortSeq: item.memory.id,
          excerpt: item.memory.content
        }, displayNameMap)
      hits.push({
        session,
        message,
        excerpt: compactText(item.memory.content || item.memory.title, 240),
        matchedField: 'memory',
        score: item.score + Number(item.memory.importance || 0),
        retrievalSource: item.source
      })
    }
    return { hits: hits.slice(0, limit), diagnostics: [`记忆检索：命中 ${hits.length} 条。`] }
  }

  private async searchVector(db: Database.Database, input: SearchInput, displayNameMap: Map<string, string>): Promise<{ hits: AgentSearchHit[]; diagnostics: string[]; vectorSearch: AgentVectorDiagnostics }> {
    const vectorLoad = loadSqliteVec(db)
    const diagnostics: string[] = []
    const profile = agentEmbeddingRuntime.getCurrentProfile()
    const vectorModel = agentEmbeddingRuntime.getVectorModelId(profile)
    const state = this.getVectorState(db, input.sessionId, vectorModel)
    const vectorSearch: AgentVectorDiagnostics = {
      requested: true,
      attempted: false,
      providerAvailable: vectorLoad.available,
      indexComplete: Boolean(state?.isComplete),
      hitCount: 0,
      indexedMessages: state?.indexedCount || 0,
      vectorizedMessages: state?.vectorizedCount || 0,
      model: vectorModel
    }

    if (!vectorLoad.available) {
      vectorSearch.skippedReason = 'sqlite_vec_unavailable'
      vectorSearch.error = vectorLoad.error
      return { hits: [], diagnostics: [`语义搜索：向量扩展不可用，${compactText(vectorLoad.error || '', 120)}`], vectorSearch }
    }
    if (!state?.isComplete) {
      vectorSearch.skippedReason = 'vector_index_incomplete'
      return { hits: [], diagnostics: '语义搜索：当前会话向量索引未完成。'.split('\n'), vectorSearch }
    }

    try {
      const semanticQuery = input.semanticQuery || input.semanticQueries?.[0] || input.query
      const { embedding } = await agentEmbeddingRuntime.embedQuery(semanticQuery)
      const scanLimit = Math.max((input.limit || 20) * VECTOR_OVERFETCH, (input.limit || 20) + 20)
      const vectorRows = db.prepare(`
        SELECT vector_id, distance
        FROM message_embedding_vec
        WHERE embedding MATCH @queryEmbedding
          AND session_key = CAST(@sessionKey AS INTEGER)
          AND k = @limit
        ORDER BY distance ASC
      `).all({
        queryEmbedding: embedding,
        sessionKey: sessionKey(input.sessionId),
        limit: scanLimit
      }) as Array<{ vector_id: number; distance: number }>

      if (vectorRows.length === 0) {
        vectorSearch.attempted = true
        diagnostics.push('语义搜索：向量命中 0 条。')
        return { hits: [], diagnostics, vectorSearch }
      }

      const ids = vectorRows.map((row) => Number(row.vector_id || 0)).filter((id) => id > 0)
      const idParams: Record<string, number> = {}
      ids.forEach((id, index) => { idParams[`id${index}`] = id })
      const filters: string[] = []
      const params: Record<string, unknown> = {
        sessionId: input.sessionId,
        vectorModel,
        ...idParams
      }
      if (input.startTime) {
        filters.push('m.create_time >= @startTime')
        params.startTime = Math.floor(input.startTime)
      }
      if (input.endTime) {
        filters.push('m.create_time <= @endTime')
        params.endTime = Math.floor(input.endTime)
      }
      if (input.senderUsername) {
        filters.push("lower(COALESCE(m.sender_username, '')) = @senderUsername")
        params.senderUsername = input.senderUsername.toLowerCase()
      }
      const postWhere = filters.length ? `AND ${filters.join(' AND ')}` : ''
      const placeholders = ids.map((_, index) => `@id${index}`).join(', ')
      const rows = db.prepare(`
        SELECT m.*, v.id AS vector_id
        FROM message_vector_index v
        JOIN message_index m ON m.id = v.message_id AND m.session_id = @sessionId
        WHERE v.id IN (${placeholders})
          AND v.vector_model = @vectorModel
          ${postWhere}
      `).all(params) as IndexRow[]
      const distanceById = new Map(vectorRows.map((row) => [Number(row.vector_id), Number(row.distance || 0)]))
      const hits = rows.map((row) => {
        const vectorScore = Math.max(0, Math.min(1, 1 - Number(distanceById.get(Number(row.vector_id || 0)) || 0)))
        const message = rowToMessage(row, displayNameMap)
        return {
          session: agentDataRepository.getSessionRef(input.sessionId, displayNameMap),
          message,
          excerpt: createExcerpt(message.text || row.search_text, 0, Math.min((input.query || '').length, 24)),
          matchedField: 'text' as const,
          score: Number((650 + vectorScore * 500).toFixed(2)),
          retrievalSource: 'vector_index' as const
        }
      })
        .filter((hit) => hit.score >= 650 + VECTOR_MIN_SCORE * 500)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit || 20)
      vectorSearch.attempted = true
      vectorSearch.hitCount = hits.length
      diagnostics.push(`语义搜索：向量命中 ${hits.length} 条。`)
      return { hits, diagnostics, vectorSearch }
    } catch (error) {
      vectorSearch.attempted = true
      vectorSearch.error = String(error)
      return { hits: [], diagnostics: [`语义搜索失败：${compactText(String(error), 120)}`], vectorSearch }
    }
  }

  private getVectorState(db: Database.Database, sessionId: string, vectorModel: string): { indexedCount: number; vectorizedCount: number; isComplete: boolean } | null {
    try {
      const state = db.prepare(`
        SELECT is_complete
        FROM session_vector_state
        WHERE session_id = ? AND vector_model = ?
      `).get(sessionId, vectorModel) as { is_complete?: number } | undefined
      const indexed = db.prepare('SELECT COUNT(*) AS count FROM message_index WHERE session_id = ?').get(sessionId) as { count?: number } | undefined
      const vectorized = db.prepare('SELECT COUNT(*) AS count FROM message_vector_index WHERE session_id = ? AND vector_model = ?').get(sessionId, vectorModel) as { count?: number } | undefined
      return {
        indexedCount: Number(indexed?.count || 0),
        vectorizedCount: Number(vectorized?.count || 0),
        isComplete: Boolean(state?.is_complete) && Number(vectorized?.count || 0) >= Number(indexed?.count || 0)
      }
    } catch {
      return null
    }
  }

  private searchRawMessages(input: SearchInput, query: string, limit: number, displayNameMap: Map<string, string>): { hits: AgentSearchHit[]; scanned: number; diagnostics: string[] } {
    const result = agentDataRepository.getMessages(input.sessionId, {
      startTime: input.startTime,
      endTime: input.endTime,
      keyword: query,
      senderUsername: input.senderUsername,
      order: 'desc',
      limit: Math.max(limit * 20, 500)
    })
    const lower = query.toLowerCase()
    const hits = result.items
      .map((message) => {
        const raw = message.raw?.rawContent || ''
        const text = message.text || ''
        const haystack = `${text}\n${raw}`.toLowerCase()
        const index = haystack.indexOf(lower)
        return {
          session: agentDataRepository.getSessionRef(input.sessionId, displayNameMap),
          message,
          excerpt: index >= 0 ? createExcerpt(text || raw, Math.min(index, Math.max(0, (text || raw).length - 1)), query.length) : compactText(text || raw, 160),
          matchedField: raw.toLowerCase().includes(lower) ? 'raw' as const : 'text' as const,
          score: index >= 0 ? 620 - Math.min(index, 300) : 420,
          retrievalSource: 'raw_scan' as const
        }
      })
      .filter((hit) => hit.excerpt)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    return { hits, scanned: result.scanned, diagnostics: [`原始扫描：扫描 ${result.scanned} 条，命中 ${hits.length} 条。`] }
  }

  private fuseHits(hits: AgentSearchHit[]): AgentSearchHit[] {
    const byKey = new Map<string, AgentSearchHit>()
    for (const hit of hits) {
      const key = `${hit.message.cursor.localId}:${hit.message.cursor.createTime}:${hit.message.cursor.sortSeq}`
      const existing = byKey.get(key)
      if (!existing || hit.score > existing.score) {
        byKey.set(key, hit)
      } else if (existing.retrievalSource !== hit.retrievalSource) {
        existing.score = Number((existing.score + 25).toFixed(2))
      }
    }
    return Array.from(byKey.values()).sort((a, b) => b.score - a.score || compareCursorAsc(b.message.cursor, a.message.cursor))
  }
}

export const agentRetriever = new AgentRetriever()

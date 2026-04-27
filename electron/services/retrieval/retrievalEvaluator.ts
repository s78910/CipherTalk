import { existsSync, readFileSync } from 'fs'
import type {
  RetrievalEvalCase,
  RetrievalEvalCaseResult,
  RetrievalEvalHit,
  RetrievalEvalMode,
  RetrievalEvalReport,
  RetrievalEvalSummary
} from './retrievalTypes'

export type RunRetrievalEvaluationOptions = {
  cases: RetrievalEvalCase[]
  mode?: RetrievalEvalMode
  limit?: number
  prepareVectorIndex?: boolean
  onCaseComplete?: (result: RetrievalEvalCaseResult) => void | Promise<void>
}

type SearchService = {
  prepareSessionVectorIndex(sessionId: string): Promise<unknown>
  getSessionVectorIndexState(sessionId: string): {
    vectorProviderAvailable?: boolean
    isVectorComplete: boolean
  }
  searchSession(options: any): Promise<{ hits: any[] }>
  searchSessionByVector(options: any): Promise<{ hits: any[] }>
}

function getSearchService(): SearchService {
  return require('../search/chatSearchIndexService').chatSearchIndexService as SearchService
}

function normalizeMode(value?: string): RetrievalEvalMode {
  return value === 'keyword' || value === 'vector' || value === 'hybrid' ? value : 'hybrid'
}

function validateEvalCase(input: any, lineNumber: number): RetrievalEvalCase {
  if (!input || typeof input !== 'object') {
    throw new Error(`评测集第 ${lineNumber} 行不是有效对象`)
  }

  const id = String(input.id || '').trim()
  const sessionId = String(input.sessionId || '').trim()
  const question = String(input.question || '').trim()
  const expectedEvidence = Array.isArray(input.expectedEvidence) ? input.expectedEvidence : []

  if (!id) throw new Error(`评测集第 ${lineNumber} 行缺少 id`)
  if (!sessionId) throw new Error(`评测集第 ${lineNumber} 行缺少 sessionId`)
  if (!question) throw new Error(`评测集第 ${lineNumber} 行缺少 question`)
  if (expectedEvidence.length === 0) throw new Error(`评测集第 ${lineNumber} 行缺少 expectedEvidence`)

  return {
    id,
    sessionId,
    question,
    semanticQuery: typeof input.semanticQuery === 'string' ? input.semanticQuery.trim() || undefined : undefined,
    expectedEvidence: expectedEvidence.map((item: any) => ({
      localId: Number(item.localId || 0),
      createTime: Number(item.createTime || 0),
      sortSeq: Number(item.sortSeq || 0)
    })),
    expectedKeywords: Array.isArray(input.expectedKeywords)
      ? input.expectedKeywords.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : undefined,
    startTimeMs: Number.isFinite(Number(input.startTimeMs)) ? Number(input.startTimeMs) : undefined,
    endTimeMs: Number.isFinite(Number(input.endTimeMs)) ? Number(input.endTimeMs) : undefined,
    direction: input.direction === 'in' || input.direction === 'out' ? input.direction : undefined,
    senderUsername: typeof input.senderUsername === 'string' ? input.senderUsername.trim() || undefined : undefined,
    limit: Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Number(input.limit) : undefined
  }
}

export function loadRetrievalEvalCases(filePath: string): RetrievalEvalCase[] {
  if (!existsSync(filePath)) {
    throw new Error(`评测集不存在：${filePath}`)
  }

  const lines = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line, index) => validateEvalCase(JSON.parse(line), index + 1))
}

function hitKey(hit: RetrievalEvalHit): string {
  return `${hit.sessionId}:${Number(hit.message.localId || 0)}:${Number(hit.message.createTime || 0)}:${Number(hit.message.sortSeq || 0)}`
}

function expectedKey(sessionId: string, evidence: { localId: number; createTime: number; sortSeq: number }): string {
  return `${sessionId}:${Number(evidence.localId || 0)}:${Number(evidence.createTime || 0)}:${Number(evidence.sortSeq || 0)}`
}

function rankHits(hits: RetrievalEvalHit[]): RetrievalEvalHit[] {
  const byKey = new Map<string, RetrievalEvalHit>()
  for (const hit of hits) {
    const key = hitKey(hit)
    const existing = byKey.get(key)
    if (!existing || hit.score > existing.score) {
      byKey.set(key, hit)
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.score - a.score)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(mode: RetrievalEvalMode, startedAt: string, completedAt: string, cases: RetrievalEvalCaseResult[]): RetrievalEvalSummary {
  const successful = cases.filter((item) => !item.error)
  const latencies = successful.map((item) => item.latencyMs)
  const denominator = successful.length || 1

  return {
    mode,
    caseCount: cases.length,
    successfulCases: successful.length,
    failedCases: cases.length - successful.length,
    recallAt10: successful.filter((item) => item.recallAt10).length / denominator,
    recallAt20: successful.filter((item) => item.recallAt20).length / denominator,
    mrr: successful.reduce((sum, item) => sum + item.reciprocalRank, 0) / denominator,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    startedAt,
    completedAt
  }
}

export async function runRetrievalEvaluation(options: RunRetrievalEvaluationOptions): Promise<RetrievalEvalReport> {
  const mode = normalizeMode(options.mode)
  const startedAt = new Date().toISOString()
  const results: RetrievalEvalCaseResult[] = []
  const chatSearchIndexService = getSearchService()

  for (const evalCase of options.cases) {
    const caseLimit = evalCase.limit || options.limit || 20
    const started = Date.now()
    let vectorAttempted = false
    let vectorSkippedReason: string | undefined

    try {
      if (options.prepareVectorIndex && mode !== 'keyword') {
        await chatSearchIndexService.prepareSessionVectorIndex(evalCase.sessionId)
      }

      const hits: RetrievalEvalHit[] = []
      if (mode === 'keyword' || mode === 'hybrid') {
        const keyword = await chatSearchIndexService.searchSession({
          sessionId: evalCase.sessionId,
          query: evalCase.question,
          limit: caseLimit,
          startTimeMs: evalCase.startTimeMs,
          endTimeMs: evalCase.endTimeMs,
          direction: evalCase.direction,
          senderUsername: evalCase.senderUsername
        })
        hits.push(...keyword.hits.map((hit) => ({ ...hit, retrievalSource: 'keyword_index' as const })))
      }

      if (mode === 'vector' || mode === 'hybrid') {
        const vectorState = chatSearchIndexService.getSessionVectorIndexState(evalCase.sessionId)
        if (!vectorState.vectorProviderAvailable) {
          vectorSkippedReason = 'vector_provider_unavailable'
        } else if (!vectorState.isVectorComplete) {
          vectorSkippedReason = 'vector_index_incomplete'
        } else {
          vectorAttempted = true
          const vector = await chatSearchIndexService.searchSessionByVector({
            sessionId: evalCase.sessionId,
            query: evalCase.semanticQuery || evalCase.question,
            limit: caseLimit,
            startTimeMs: evalCase.startTimeMs,
            endTimeMs: evalCase.endTimeMs,
            direction: evalCase.direction,
            senderUsername: evalCase.senderUsername
          })
          hits.push(...vector.hits.map((hit) => ({ ...hit, retrievalSource: 'vector_index' as const })))
        }
      }

      const rankedHits = rankHits(hits)
      const expected = new Set(evalCase.expectedEvidence.map((item) => expectedKey(evalCase.sessionId, item)))
      const firstMatchIndex = rankedHits.findIndex((hit) => expected.has(hitKey(hit)))
      const firstMatchRank = firstMatchIndex >= 0 ? firstMatchIndex + 1 : null
      const result: RetrievalEvalCaseResult = {
        id: evalCase.id,
        sessionId: evalCase.sessionId,
        question: evalCase.question,
        mode,
        hitCount: rankedHits.length,
        recallAt10: firstMatchRank !== null && firstMatchRank <= 10,
        recallAt20: firstMatchRank !== null && firstMatchRank <= 20,
        reciprocalRank: firstMatchRank ? 1 / firstMatchRank : 0,
        firstMatchRank,
        latencyMs: Date.now() - started,
        vectorAttempted,
        vectorSkippedReason
      }
      results.push(result)
      await options.onCaseComplete?.(result)
    } catch (error) {
      const result: RetrievalEvalCaseResult = {
        id: evalCase.id,
        sessionId: evalCase.sessionId,
        question: evalCase.question,
        mode,
        hitCount: 0,
        recallAt10: false,
        recallAt20: false,
        reciprocalRank: 0,
        firstMatchRank: null,
        latencyMs: Date.now() - started,
        vectorAttempted,
        vectorSkippedReason,
        error: String(error)
      }
      results.push(result)
      await options.onCaseComplete?.(result)
    }
  }

  const completedAt = new Date().toISOString()
  return {
    summary: summarize(mode, startedAt, completedAt, results),
    cases: results
  }
}

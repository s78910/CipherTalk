export type RetrievalEvalEvidenceRef = {
  localId: number
  createTime: number
  sortSeq: number
}

export type RetrievalEvalCase = {
  id: string
  sessionId: string
  question: string
  semanticQuery?: string
  expectedEvidence: RetrievalEvalEvidenceRef[]
  expectedKeywords?: string[]
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  senderUsername?: string
  limit?: number
}

export type RetrievalEvalMode = 'keyword' | 'vector' | 'hybrid'

export type RetrievalEvalMessage = {
  localId: number
  createTime: number
  sortSeq: number
  [key: string]: unknown
}

export type RetrievalEvalHit = {
  sessionId: string
  message: RetrievalEvalMessage
  excerpt: string
  matchedField: 'text' | 'raw'
  score: number
  retrievalSource: 'keyword_index' | 'vector_index'
}

export type RetrievalEvalCaseResult = {
  id: string
  sessionId: string
  question: string
  mode: RetrievalEvalMode
  hitCount: number
  recallAt10: boolean
  recallAt20: boolean
  reciprocalRank: number
  firstMatchRank: number | null
  latencyMs: number
  vectorAttempted: boolean
  vectorSkippedReason?: string
  error?: string
}

export type RetrievalEvalSummary = {
  mode: RetrievalEvalMode
  caseCount: number
  successfulCases: number
  failedCases: number
  recallAt10: number
  recallAt20: number
  mrr: number
  latencyP50Ms: number
  latencyP95Ms: number
  startedAt: string
  completedAt: string
}

export type RetrievalEvalReport = {
  summary: RetrievalEvalSummary
  cases: RetrievalEvalCaseResult[]
}

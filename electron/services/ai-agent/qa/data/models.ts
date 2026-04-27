export type AgentCursor = {
  localId: number
  createTime: number
  sortSeq: number
}

export type AgentMessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'contact_card'
  | 'video'
  | 'emoji'
  | 'location'
  | 'voip'
  | 'system'
  | 'quote'
  | 'app_music'
  | 'app_link'
  | 'app_file'
  | 'app_chat_record'
  | 'app_mini_program'
  | 'app_quote'
  | 'app_pat'
  | 'app_announcement'
  | 'app_gift'
  | 'app_transfer'
  | 'app_red_packet'
  | 'app'
  | 'unknown'

export type AgentMessageDirection = 'in' | 'out'

export type AgentChatRecordItem = {
  datatype: number
  datadesc?: string
  datatitle?: string
  sourcename?: string
  sourcetime?: string
  sourceheadurl?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  dataurl?: string
  datathumburl?: string
  datacdnurl?: string
  aeskey?: string
  md5?: string
  imgheight?: number
  imgwidth?: number
  duration?: number
}

export type AgentSourceMessage = {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  chatRecordList?: AgentChatRecordItem[]
  fileName?: string
  quotedContent?: string
}

export type AgentMessage = {
  messageId: number
  timestamp: number
  timestampMs: number
  direction: AgentMessageDirection
  kind: AgentMessageKind
  text: string
  sender: {
    username: string | null
    displayName: string | null
    isSelf: boolean
  }
  cursor: AgentCursor
  raw?: AgentSourceMessage
}

export type AgentContactKind = 'friend' | 'group' | 'official' | 'former_friend' | 'other'

export type AgentContact = {
  contactId: string
  sessionId: string
  displayName: string
  remark?: string
  nickname?: string
  kind: AgentContactKind
  lastContactTime?: number
}

export type AgentSessionRef = {
  sessionId: string
  displayName: string
  kind: 'friend' | 'group' | 'official' | 'other'
}

export type AgentRetrievalSource = 'keyword_index' | 'vector_index' | 'memory_fts' | 'memory_like' | 'raw_scan'

export type AgentSearchHit = {
  session: AgentSessionRef
  message: AgentMessage
  excerpt: string
  matchedField: 'text' | 'raw' | 'memory'
  score: number
  retrievalSource: AgentRetrievalSource
}

export type AgentVectorDiagnostics = {
  requested: boolean
  attempted: boolean
  providerAvailable: boolean
  indexComplete: boolean
  hitCount: number
  indexedMessages: number
  vectorizedMessages: number
  skippedReason?: string
  error?: string
  model?: string
}

export type AgentIndexDiagnostics = {
  ready: boolean
  indexedMessages: number
  error?: string
}

export type AgentSearchResult = {
  hits: AgentSearchHit[]
  limit: number
  messagesScanned: number
  truncated: boolean
  source: 'agent_index' | 'agent_raw_scan' | 'agent_memory' | 'agent_hybrid'
  vectorSearch?: AgentVectorDiagnostics
  indexStatus?: AgentIndexDiagnostics
  diagnostics: string[]
}

export type AgentContextWindow = {
  source: 'search' | 'latest' | 'time_range'
  query?: string
  label?: string
  anchor?: AgentMessage
  messages: AgentMessage[]
}

export type AgentParticipantStatistics = {
  senderUsername?: string
  displayName?: string
  role: 'self' | 'contact' | 'participant'
  messageCount: number
  sentCount: number
  receivedCount: number
}

export type AgentSessionStats = {
  session: AgentSessionRef
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  activeDays: number
  firstMessageTime?: number
  lastMessageTime?: number
  kindCounts: Record<string, number>
  hourlyDistribution: Record<string, number>
  participantRankings: AgentParticipantStatistics[]
  samples: AgentMessage[]
  scannedMessages: number
  matchedMessages: number
  truncated: boolean
}

export type AgentKeywordStatisticsSample = {
  message: AgentMessage
  excerpt: string
}

export type AgentKeywordStatisticsItem = {
  keyword: string
  hitCount: number
  occurrenceCount: number
  firstHitTime?: number
  lastHitTime?: number
  participantRankings: AgentParticipantStatistics[]
  hourlyDistribution: Record<string, number>
  samples: AgentKeywordStatisticsSample[]
}

export type AgentKeywordStats = {
  session: AgentSessionRef
  keywords: AgentKeywordStatisticsItem[]
  scannedMessages: number
  matchedMessages: number
  truncated: boolean
}

export type AgentSeries<T = unknown> = {
  name: string
  values: T[]
}

export type AgentDataFrame = {
  columns: string[]
  rows: Array<Record<string, unknown>>
  series?: AgentSeries[]
}

export type AgentMemoryRef = {
  sessionId: string
  localId: number
  createTime: number
  sortSeq: number
  senderUsername?: string
  excerpt?: string
}

export type AgentMemoryItem = {
  id: number
  sourceType: string
  sessionId?: string | null
  title: string
  content: string
  importance: number
  confidence: number
  timeStart?: number | null
  timeEnd?: number | null
  sourceRefs: AgentMemoryRef[]
  updatedAt: number
}

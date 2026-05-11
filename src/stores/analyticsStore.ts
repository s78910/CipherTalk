import { create } from 'zustand'

interface ChatStatistics {
  totalMessages: number
  textMessages: number
  imageMessages: number
  voiceMessages: number
  videoMessages: number
  emojiMessages: number
  otherMessages: number
  sentMessages: number
  receivedMessages: number
  unknownMessages?: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  activeDays: number
  messageTypeCounts: Record<number, number>
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

interface StatsPartialError {
  dbName?: string
  dbPath?: string
  tableName?: string
  message: string
}

interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  unknownCount?: number
  lastMessageTime: number | null
}

interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  weekdayDistribution?: Record<number, number>
  monthlyDistribution: Record<string, number>
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

interface AnalyticsState {
  // 数据
  statistics: ChatStatistics | null
  rankings: ContactRanking[]
  timeDistribution: TimeDistribution | null
  
  // 状态
  isLoaded: boolean
  lastLoadTime: number | null
  
  // Actions
  setStatistics: (data: ChatStatistics) => void
  setRankings: (data: ContactRanking[]) => void
  setTimeDistribution: (data: TimeDistribution) => void
  markLoaded: () => void
  clearCache: () => void
}

export const useAnalyticsStore = create<AnalyticsState>((set) => ({
  statistics: null,
  rankings: [],
  timeDistribution: null,
  isLoaded: false,
  lastLoadTime: null,

  setStatistics: (data) => set({ statistics: data }),
  setRankings: (data) => set({ rankings: data }),
  setTimeDistribution: (data) => set({ timeDistribution: data }),
  markLoaded: () => set({ isLoaded: true, lastLoadTime: Date.now() }),
  clearCache: () => set({ 
    statistics: null, 
    rankings: [], 
    timeDistribution: null, 
    isLoaded: false, 
    lastLoadTime: null 
  }),
}))

import { ConfigService } from './config'
import { dbAdapter } from './dbAdapter'
import { findMessageDbPaths } from './dbStoragePaths'
import { resolveContactNames } from './contactNameResolver'
import {
  extractExactMessageTableHash,
  getMessageTableColumns,
  getMessageTableHash,
  getMyRowId,
  hasName2IdTable,
  listExactMessageTables,
} from './messageDbScanner'
import { CHINESE_STOP_WORDS, StatsPartialError, SYSTEM_USERNAME_CONTAINS, SYSTEM_USERNAME_EXACT, SYSTEM_USERNAME_PREFIXES, TEXT_LOCAL_TYPES } from './statsConstants'
import { buildMessageStatsWhere, normalizeTimeRange, recordStatsError, toLocalDateParts, utcDateFromLocalKey } from './statsSqlHelpers'
import { cut_for_search } from 'jieba-wasm'

export interface TopContact {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
}

export interface MonthlyTopFriend {
  month: number
  displayName: string
  avatarUrl?: string
  messageCount: number
  bucket?: string
  label?: string
}

export interface ChatPeakDay {
  date: string
  messageCount: number
  topFriend?: string
  topFriendCount?: number
}

export interface ActivityHeatmap {
  data: number[][]
}

export interface AnnualReportData {
  year: number
  totalMessages: number
  totalFriends: number
  coreFriends: TopContact[]
  monthlyTopFriends: MonthlyTopFriend[]
  peakDay: ChatPeakDay | null
  longestStreak: {
    friendName: string
    days: number
    startDate: string
    endDate: string
  } | null
  activityHeatmap: ActivityHeatmap
  midnightKing: {
    displayName: string
    count: number
    percentage: number
  } | null
  selfAvatarUrl?: string
  daysCovered?: number
  errors?: StatsPartialError[]
  partialFailureCount?: number
  mutualFriend: {
    displayName: string
    avatarUrl?: string
    sentCount: number
    receivedCount: number
    ratio: number
  } | null
  socialInitiative: {
    initiatedChats: number
    receivedChats: number
    initiativeRate: number
  } | null
  responseSpeed: {
    avgResponseTime: number
    fastestFriend: string
    fastestTime: number
  } | null
  topPhrases: {
    phrase: string
    count: number
  }[]
}

class AnnualReportService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]
    return trimmed
  }

  private shouldExcludeAnnualSession(username: string): boolean {
    const u = String(username || '').toLowerCase().trim()
    if (!u) return true
    if (u.includes('@chatroom')) return true
    if (SYSTEM_USERNAME_EXACT.has(u)) return true
    if (SYSTEM_USERNAME_PREFIXES.some(prefix => u.startsWith(prefix))) return true
    if (SYSTEM_USERNAME_CONTAINS.some(part => u.includes(part))) return true
    if (u.includes('reminder') || u.includes('notify')) return true
    return false
  }

  private segmentPhrase(content: string): string[] {
    const cleaned = String(content || '')
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned || cleaned.length < 2) return []

    let words: string[] = []
    try {
      words = cut_for_search(cleaned, true)
    } catch {
      const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new (Intl as any).Segmenter('zh-CN', { granularity: 'word' })
        : null
      words = segmenter
        ? Array.from(segmenter.segment(cleaned)).map((part: any) => part.segment)
        : cleaned.split(/\s+/)
    }

    return words
      .map(word => String(word).trim())
      .filter(word => word.length >= 2 && word.length <= 12)
      .filter(word => !/^\d+$/.test(word))
      .filter(word => !CHINESE_STOP_WORDS.has(word))
  }

  private resolveDirection(row: any, myRowId: number | null, hasRealSenderId: boolean, hasIsSend: boolean): 'sent' | 'received' | 'unknown' {
    if (hasRealSenderId && myRowId !== null) {
      if (row.real_sender_id === null || row.real_sender_id === undefined) return 'unknown'
      return Number(row.real_sender_id) === myRowId ? 'sent' : 'received'
    }
    if (hasIsSend) {
      if (Number(row.is_send) === 1) return 'sent'
      if (Number(row.is_send) === 0) return 'received'
    }
    return 'unknown'
  }

  async getAvailableYears(): Promise<{ success: boolean; data?: number[]; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const years = new Set<number>()
      for (const dbPath of findMessageDbPaths()) {
        let tables: string[] = []
        try {
          tables = await listExactMessageTables(dbPath)
        } catch {
          continue
        }
        for (const tableName of tables) {
          try {
            const result = await dbAdapter.get<{ min_time: number; max_time: number }>(
              'message',
              dbPath,
              `SELECT MIN(create_time) as min_time, MAX(create_time) as max_time
               FROM "${tableName}" WHERE create_time > 0`
            )
            if (result?.min_time && result?.max_time) {
              const minYear = new Date(result.min_time * 1000).getFullYear()
              const maxYear = new Date(result.max_time * 1000).getFullYear()
              for (let y = minYear; y <= maxYear; y++) {
                if (y >= 2010 && y <= new Date().getFullYear()) years.add(y)
              }
            }
          } catch {
            // skip malformed shard
          }
        }
      }

      return { success: true, data: Array.from(years).sort((a, b) => b - a) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async generateReport(year: number): Promise<{ success: boolean; data?: AnnualReportData; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) return { success: false, error: '未找到消息数据库' }

      const sessions = await dbAdapter.all<{ username: string }>(
        'session',
        '',
        'SELECT username FROM SessionTable'
      )
      const wxidLower = wxid.toLowerCase()
      const cleanedWxidLower = cleanedWxid.toLowerCase()
      const privateUsernames = sessions
        .map(s => s.username)
        .filter(u => {
          const lower = String(u || '').toLowerCase()
          return lower !== wxidLower && lower !== cleanedWxidLower && !this.shouldExcludeAnnualSession(u)
        })

      const hashToUsername = new Map<string, string>()
      for (const username of privateUsernames) hashToUsername.set(getMessageTableHash(username), username)

      const isAllTime = year <= 0
      const reportYear = isAllTime ? 0 : year
      const startTime = isAllTime ? undefined : Math.floor(new Date(year, 0, 1).getTime() / 1000)
      const endTime = isAllTime ? undefined : Math.floor(new Date(year + 1, 0, 1).getTime() / 1000)
      const range = normalizeTimeRange(startTime, endTime)

      let totalMessages = 0
      const contactStats = new Map<string, { sent: number; received: number; unknown: number }>()
      const monthlyStats = new Map<string, Map<string, number>>()
      const dailyStats = new Map<string, number>()
      const dailyContactStats = new Map<string, Map<string, number>>()
      const heatmapData: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
      const midnightStats = new Map<string, number>()
      const conversationStarts = new Map<string, { initiated: number; received: number }>()
      const responseTimeStats = new Map<string, number[]>()
      const phraseCount = new Map<string, number>()
      const lastMessageTime = new Map<string, { time: number; isSent: boolean }>()
      const sessionActiveDays = new Map<string, Set<string>>()
      const allActiveDays = new Set<string>()
      const errors: StatsPartialError[] = []

      for (const dbPath of dbFiles) {
        const hasName2Id = await hasName2IdTable(dbPath)
        const myRowId = hasName2Id ? await getMyRowId(dbPath, [cleanedWxid, wxid]) : null
        let tables: string[] = []
        try {
          tables = await listExactMessageTables(dbPath)
        } catch (e) {
          recordStatsError(errors, e, { dbPath, prefix: '[AnnualReportService]' })
          continue
        }

        for (const tableName of tables) {
          const tableHash = extractExactMessageTableHash(tableName)
          const sessionId = tableHash ? hashToUsername.get(tableHash) : undefined
          if (!sessionId) continue

          try {
            const columns = await getMessageTableColumns(dbPath, tableName)
            const where = buildMessageStatsWhere({ range, contentColumn: columns.contentColumn || undefined })
            const selectFields = [
              'create_time',
              'local_type',
              columns.hasRealSenderId ? 'real_sender_id' : 'NULL as real_sender_id',
              columns.hasIsSend ? 'is_send' : 'NULL as is_send',
              columns.contentColumn ? `"${columns.contentColumn}" as msg_content` : 'NULL as msg_content',
            ].join(', ')
            const messages = await dbAdapter.all<any>(
              'message',
              dbPath,
              `SELECT ${selectFields}
               FROM "${tableName}"
               ${where.sql}
               ORDER BY create_time ASC`,
              where.params
            )

            let lastMsg = lastMessageTime.get(sessionId)
            const CONVERSATION_GAP = 3600

            for (const msg of messages) {
              const createTime = Number(msg.create_time || 0)
              if (createTime <= 0) continue
              const direction = this.resolveDirection(msg, myRowId, columns.hasRealSenderId && hasName2Id, columns.hasIsSend)
              const isSent = direction === 'sent'
              const parts = toLocalDateParts(createTime)
              const monthBucket = isAllTime ? parts.monthKey : String(parts.month)

              totalMessages++
              allActiveDays.add(parts.day)

              const stats = contactStats.get(sessionId) || { sent: 0, received: 0, unknown: 0 }
              stats[direction]++
              contactStats.set(sessionId, stats)

              const convStats = conversationStarts.get(sessionId) || { initiated: 0, received: 0 }
              if (!lastMsg || (createTime - lastMsg.time) > CONVERSATION_GAP) {
                if (isSent) convStats.initiated++
                else convStats.received++
              } else if (lastMsg.isSent !== isSent && isSent && !lastMsg.isSent) {
                const responseTime = createTime - lastMsg.time
                if (responseTime > 0 && responseTime < 86400) {
                  const times = responseTimeStats.get(sessionId) || []
                  times.push(responseTime)
                  responseTimeStats.set(sessionId, times)
                }
              }
              conversationStarts.set(sessionId, convStats)
              lastMsg = { time: createTime, isSent }
              lastMessageTime.set(sessionId, lastMsg)

              if (TEXT_LOCAL_TYPES.includes(Number(msg.local_type) as any) && msg.msg_content && isSent) {
                for (const phrase of this.segmentPhrase(msg.msg_content)) {
                  phraseCount.set(phrase, (phraseCount.get(phrase) || 0) + 1)
                }
              }

              const monthMap = monthlyStats.get(sessionId) || new Map<string, number>()
              monthMap.set(monthBucket, (monthMap.get(monthBucket) || 0) + 1)
              monthlyStats.set(sessionId, monthMap)

              dailyStats.set(parts.day, (dailyStats.get(parts.day) || 0) + 1)
              const dayContactMap = dailyContactStats.get(parts.day) || new Map<string, number>()
              dayContactMap.set(sessionId, (dayContactMap.get(sessionId) || 0) + 1)
              dailyContactStats.set(parts.day, dayContactMap)

              const activeDays = sessionActiveDays.get(sessionId) || new Set<string>()
              activeDays.add(parts.day)
              sessionActiveDays.set(sessionId, activeDays)

              const weekdayIndex = parts.weekday === 0 ? 6 : parts.weekday - 1
              heatmapData[weekdayIndex][parts.hour]++
              if (parts.hour >= 0 && parts.hour < 6) {
                midnightStats.set(sessionId, (midnightStats.get(sessionId) || 0) + 1)
              }
            }
          } catch (e) {
            recordStatsError(errors, e, { dbPath, tableName, prefix: '[AnnualReportService]' })
          }
        }
      }

      const contactInfoMap = await resolveContactNames(Array.from(contactStats.keys()).concat([cleanedWxid, wxid]))
      const selfAvatarUrl = contactInfoMap.get(cleanedWxid)?.avatarUrl || contactInfoMap.get(wxid)?.avatarUrl

      const coreFriends: TopContact[] = Array.from(contactStats.entries())
        .map(([sessionId, stats]) => {
          const info = contactInfoMap.get(sessionId)
          return {
            username: sessionId,
            displayName: info?.displayName || sessionId,
            avatarUrl: info?.avatarUrl,
            messageCount: stats.sent + stats.received + stats.unknown,
            sentCount: stats.sent,
            receivedCount: stats.received
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, 10)

      const monthlyTopFriends: MonthlyTopFriend[] = []
      const monthBuckets = isAllTime
        ? Array.from(new Set(Array.from(monthlyStats.values()).flatMap(m => Array.from(m.keys())))).sort()
        : Array.from({ length: 12 }, (_, i) => String(i + 1))
      for (const bucket of monthBuckets) {
        let maxCount = 0
        let topSessionId = ''
        for (const [sessionId, monthMap] of monthlyStats.entries()) {
          const count = monthMap.get(bucket) || 0
          if (count > maxCount) {
            maxCount = count
            topSessionId = sessionId
          }
        }
        const info = contactInfoMap.get(topSessionId)
        const month = isAllTime ? Number(bucket.slice(5, 7)) || 0 : Number(bucket)
        monthlyTopFriends.push({
          month,
          bucket,
          label: isAllTime ? bucket : `${month}月`,
          displayName: info?.displayName || (topSessionId ? topSessionId : '暂无'),
          avatarUrl: info?.avatarUrl,
          messageCount: maxCount
        })
      }

      let peakDay: ChatPeakDay | null = null
      let maxDayCount = 0
      for (const [day, count] of dailyStats.entries()) {
        if (count > maxDayCount) {
          maxDayCount = count
          const dayContactMap = dailyContactStats.get(day)
          let topFriend = ''
          let topFriendCount = 0
          if (dayContactMap) {
            for (const [sessionId, c] of dayContactMap.entries()) {
              if (c > topFriendCount) {
                topFriendCount = c
                topFriend = contactInfoMap.get(sessionId)?.displayName || sessionId
              }
            }
          }
          peakDay = { date: day, messageCount: count, topFriend, topFriendCount }
        }
      }

      let midnightKing: AnnualReportData['midnightKing'] = null
      if (totalMessages > 0 && midnightStats.size > 0) {
        let maxMidnight = 0
        let midnightSessionId = ''
        for (const [sessionId, count] of midnightStats.entries()) {
          if (count > maxMidnight) {
            maxMidnight = count
            midnightSessionId = sessionId
          }
        }
        const info = contactInfoMap.get(midnightSessionId)
        midnightKing = {
          displayName: info?.displayName || midnightSessionId,
          count: maxMidnight,
          percentage: Math.round((maxMidnight / totalMessages) * 1000) / 10
        }
      }

      let longestStreak: AnnualReportData['longestStreak'] = null
      let bestStreakDays = 0
      let bestStreakSessionId = ''
      let bestStart = ''
      let bestEnd = ''
      for (const [sessionId, activeDaysSet] of sessionActiveDays.entries()) {
        const sortedKeys = Array.from(activeDaysSet).sort()
        if (sortedKeys.length < 2) continue
        let currentStreak = 1
        let currentStart = sortedKeys[0]
        let maxStreak = 1
        let maxStart = sortedKeys[0]
        let maxEnd = sortedKeys[0]
        for (let i = 1; i < sortedKeys.length; i++) {
          const prev = utcDateFromLocalKey(sortedKeys[i - 1])
          const curr = utcDateFromLocalKey(sortedKeys[i])
          const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86400000)
          if (diffDays === 1) {
            currentStreak++
          } else {
            currentStreak = 1
            currentStart = sortedKeys[i]
          }
          if (currentStreak > maxStreak) {
            maxStreak = currentStreak
            maxStart = currentStart
            maxEnd = sortedKeys[i]
          }
        }
        if (maxStreak > bestStreakDays) {
          bestStreakDays = maxStreak
          bestStreakSessionId = sessionId
          bestStart = maxStart
          bestEnd = maxEnd
        }
      }
      if (bestStreakSessionId && bestStreakDays > 0) {
        longestStreak = {
          friendName: contactInfoMap.get(bestStreakSessionId)?.displayName || bestStreakSessionId,
          days: bestStreakDays,
          startDate: bestStart,
          endDate: bestEnd
        }
      }

      let mutualFriend: AnnualReportData['mutualFriend'] = null
      let bestRatioDiff = Infinity
      for (const [sessionId, stats] of contactStats.entries()) {
        if (stats.sent >= 50 && stats.received >= 50) {
          const ratio = stats.sent / stats.received
          const ratioDiff = Math.abs(ratio - 1)
          if (ratioDiff < bestRatioDiff) {
            bestRatioDiff = ratioDiff
            const info = contactInfoMap.get(sessionId)
            mutualFriend = {
              displayName: info?.displayName || sessionId,
              avatarUrl: info?.avatarUrl,
              sentCount: stats.sent,
              receivedCount: stats.received,
              ratio: Math.round(ratio * 100) / 100
            }
          }
        }
      }

      let totalInitiated = 0
      let totalReceived = 0
      for (const stats of conversationStarts.values()) {
        totalInitiated += stats.initiated
        totalReceived += stats.received
      }
      const totalConversations = totalInitiated + totalReceived
      const socialInitiative = totalConversations > 0
        ? {
            initiatedChats: totalInitiated,
            receivedChats: totalReceived,
            initiativeRate: Math.round((totalInitiated / totalConversations) * 1000) / 10
          }
        : null

      let responseSpeed: AnnualReportData['responseSpeed'] = null
      const allResponseTimes: number[] = []
      let fastestFriendId = ''
      let fastestAvgTime = Infinity
      for (const [sessionId, times] of responseTimeStats.entries()) {
        if (times.length >= 10) {
          allResponseTimes.push(...times)
          const avgTime = times.reduce((a, b) => a + b, 0) / times.length
          if (avgTime < fastestAvgTime) {
            fastestAvgTime = avgTime
            fastestFriendId = sessionId
          }
        }
      }
      if (allResponseTimes.length > 0) {
        const avgResponseTime = allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length
        responseSpeed = {
          avgResponseTime: Math.round(avgResponseTime),
          fastestFriend: contactInfoMap.get(fastestFriendId)?.displayName || fastestFriendId,
          fastestTime: Math.round(fastestAvgTime)
        }
      }

      const topPhrases = Array.from(phraseCount.entries())
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 32)
        .map(([phrase, count]) => ({ phrase, count }))

      const reportData: AnnualReportData = {
        year: reportYear,
        totalMessages,
        totalFriends: contactStats.size,
        coreFriends,
        monthlyTopFriends,
        peakDay,
        longestStreak,
        activityHeatmap: { data: heatmapData },
        midnightKing,
        selfAvatarUrl,
        daysCovered: allActiveDays.size,
        mutualFriend,
        socialInitiative,
        responseSpeed,
        topPhrases,
      }
      if (errors.length > 0) Object.assign(reportData, { errors, partialFailureCount: errors.length })
      return { success: true, data: reportData }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close() {
    // 共享 messageDbScanner 缓存由账号切换入口统一清理。
  }
}

export const annualReportService = new AnnualReportService()

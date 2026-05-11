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
import { MAIN_MEDIA_TYPE_NAMES, StatsPartialError, SYSTEM_USERNAME_CONTAINS, SYSTEM_USERNAME_EXACT, SYSTEM_USERNAME_PREFIXES, TEXT_LOCAL_TYPES } from './statsConstants'
import { buildMessageStatsWhere, normalizeTimeRange, recordStatsError, toLocalDateKey, toLocalMonthKey } from './statsSqlHelpers'

export interface ChatStatistics {
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

export interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  weekdayDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

export interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  unknownCount?: number
  lastMessageTime: number | null
}

type TimeRangeFilter = {
  startTimeSec?: number
  endTimeSec?: number
}

class AnalyticsService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
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

  private isPrivateSession(username: string, cleanedWxid: string): boolean {
    const u = String(username || '').trim()
    if (!u) return false
    const lower = u.toLowerCase()
    if (lower === cleanedWxid.toLowerCase()) return false
    if (lower.includes('@chatroom')) return false
    if (SYSTEM_USERNAME_EXACT.has(lower)) return false
    if (SYSTEM_USERNAME_PREFIXES.some(prefix => lower.startsWith(prefix))) return false
    if (SYSTEM_USERNAME_CONTAINS.some(part => lower.includes(part))) return false
    return true
  }

  private async getPrivateSessions(cleanedWxid: string): Promise<string[]> {
    const sessions = await dbAdapter.all<{ username: string }>(
      'session',
      '',
      'SELECT username FROM SessionTable'
    )
    return sessions.map(s => s.username).filter(u => this.isPrivateSession(u, cleanedWxid))
  }

  private buildPrivateHashMap(usernames: string[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const username of usernames) map.set(getMessageTableHash(username), username)
    return map
  }

  private async getDirectionSelect(dbPath: string, tableName: string, cleanedWxid: string): Promise<{ select: string; params: unknown[] }> {
    const columns = await getMessageTableColumns(dbPath, tableName)
    const hasName2Id = await hasName2IdTable(dbPath)
    const myRowId = hasName2Id ? await getMyRowId(dbPath, [cleanedWxid]) : null
    if (hasName2Id && myRowId !== null && columns.hasRealSenderId) {
      return {
        select: `
          SUM(CASE WHEN real_sender_id = ? THEN 1 ELSE 0 END) as sent_count,
          SUM(CASE WHEN real_sender_id IS NOT NULL AND real_sender_id != ? THEN 1 ELSE 0 END) as received_count,
          SUM(CASE WHEN real_sender_id IS NULL THEN 1 ELSE 0 END) as unknown_count
        `,
        params: [myRowId, myRowId],
      }
    }
    if (columns.hasIsSend) {
      return {
        select: `
          SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) as sent_count,
          SUM(CASE WHEN is_send = 0 THEN 1 ELSE 0 END) as received_count,
          SUM(CASE WHEN is_send IS NULL OR is_send NOT IN (0, 1) THEN 1 ELSE 0 END) as unknown_count
        `,
        params: [],
      }
    }
    return {
      select: '0 as sent_count, 0 as received_count, COUNT(*) as unknown_count',
      params: [],
    }
  }

  async getOverallStatistics(startTime?: number, endTime?: number): Promise<{ success: boolean; data?: ChatStatistics; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) return { success: false, error: '未找到消息数据库' }

      const privateUsernames = await this.getPrivateSessions(cleanedWxid)
      const tableHashToUsername = this.buildPrivateHashMap(privateUsernames)
      const timeRange = normalizeTimeRange(startTime, endTime)

      let totalMessages = 0
      let textMessages = 0
      let imageMessages = 0
      let voiceMessages = 0
      let videoMessages = 0
      let emojiMessages = 0
      let sentMessages = 0
      let receivedMessages = 0
      let unknownMessages = 0
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null
      const messageTypeCounts: Record<number, number> = {}
      const activeDatesSet = new Set<string>()
      const errors: StatsPartialError[] = []

      for (const dbPath of dbFiles) {
        let tables: string[] = []
        try {
          tables = await listExactMessageTables(dbPath)
        } catch (e) {
          recordStatsError(errors, e, { dbPath, prefix: '[AnalyticsService]' })
          continue
        }

        for (const tableName of tables) {
          const tableHash = extractExactMessageTableHash(tableName)
          if (!tableHash || !tableHashToUsername.has(tableHash)) continue

          try {
            const columns = await getMessageTableColumns(dbPath, tableName)
            const where = buildMessageStatsWhere({ range: timeRange, contentColumn: columns.contentColumn || undefined })
            const direction = await this.getDirectionSelect(dbPath, tableName, cleanedWxid)
            const statsQuery = `
              SELECT
                COUNT(*) as total,
                SUM(CASE WHEN local_type IN (${TEXT_LOCAL_TYPES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) as text_count,
                SUM(CASE WHEN local_type = 3 THEN 1 ELSE 0 END) as image_count,
                SUM(CASE WHEN local_type = 34 THEN 1 ELSE 0 END) as voice_count,
                SUM(CASE WHEN local_type = 43 THEN 1 ELSE 0 END) as video_count,
                SUM(CASE WHEN local_type = 47 THEN 1 ELSE 0 END) as emoji_count,
                ${direction.select},
                MIN(create_time) as first_time,
                MAX(create_time) as last_time
              FROM "${tableName}" ${where.sql}
            `
            const params = [...TEXT_LOCAL_TYPES, ...direction.params, ...where.params]
            const stats = await dbAdapter.get<any>('message', dbPath, statsQuery, params)

            if (stats && stats.total > 0) {
              totalMessages += Number(stats.total || 0)
              textMessages += Number(stats.text_count || 0)
              imageMessages += Number(stats.image_count || 0)
              voiceMessages += Number(stats.voice_count || 0)
              videoMessages += Number(stats.video_count || 0)
              emojiMessages += Number(stats.emoji_count || 0)
              sentMessages += Number(stats.sent_count || 0)
              receivedMessages += Number(stats.received_count || 0)
              unknownMessages += Number(stats.unknown_count || 0)

              if (stats.first_time && (!firstMessageTime || stats.first_time < firstMessageTime)) firstMessageTime = stats.first_time
              if (stats.last_time && (!lastMessageTime || stats.last_time > lastMessageTime)) lastMessageTime = stats.last_time

              const dates = await dbAdapter.all<{ create_time: number }>(
                'message',
                dbPath,
                `SELECT create_time FROM "${tableName}" ${where.sql}`,
                where.params
              )
              for (const { create_time } of dates) {
                if (create_time > 0) activeDatesSet.add(toLocalDateKey(create_time))
              }

              const typeCounts = await dbAdapter.all<{ local_type: number; count: number }>(
                'message',
                dbPath,
                `SELECT local_type, COUNT(*) as count FROM "${tableName}" ${where.sql} GROUP BY local_type`,
                where.params
              )
              for (const { local_type, count } of typeCounts) {
                messageTypeCounts[local_type] = (messageTypeCounts[local_type] || 0) + count
              }
            }
          } catch (e) {
            recordStatsError(errors, e, { dbPath, tableName, prefix: '[AnalyticsService]' })
          }
        }
      }

      const otherMessages = totalMessages - textMessages - imageMessages - voiceMessages - videoMessages - emojiMessages
      const data: ChatStatistics = {
        totalMessages,
        textMessages,
        imageMessages,
        voiceMessages,
        videoMessages,
        emojiMessages,
        otherMessages: Math.max(0, otherMessages),
        sentMessages,
        receivedMessages,
        unknownMessages,
        firstMessageTime,
        lastMessageTime,
        activeDays: activeDatesSet.size,
        messageTypeCounts,
      }
      if (errors.length > 0) {
        data.errors = errors
        data.partialFailureCount = errors.length
      }
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContactRankings(limit: number = 20, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: ContactRanking[]; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) return { success: false, error: '未找到消息数据库' }

      const privateUsernames = await this.getPrivateSessions(cleanedWxid)
      const tableHashToUsername = this.buildPrivateHashMap(privateUsernames)
      const timeRange = normalizeTimeRange(startTime, endTime)
      const contactStats: Map<string, {
        messageCount: number
        sentCount: number
        receivedCount: number
        unknownCount: number
        lastMessageTime: number | null
      }> = new Map()
      const errors: StatsPartialError[] = []

      for (const dbPath of dbFiles) {
        let tables: string[] = []
        try {
          tables = await listExactMessageTables(dbPath)
        } catch (e) {
          recordStatsError(errors, e, { dbPath, prefix: '[AnalyticsService]' })
          continue
        }

        for (const tableName of tables) {
          const tableHash = extractExactMessageTableHash(tableName)
          const username = tableHash ? tableHashToUsername.get(tableHash) : undefined
          if (!username) continue

          try {
            const columns = await getMessageTableColumns(dbPath, tableName)
            const where = buildMessageStatsWhere({ range: timeRange, contentColumn: columns.contentColumn || undefined })
            const direction = await this.getDirectionSelect(dbPath, tableName, cleanedWxid)
            const statsQuery = `
              SELECT
                COUNT(*) as total,
                ${direction.select},
                MAX(create_time) as last_time
              FROM "${tableName}" ${where.sql}
            `
            const stats = await dbAdapter.get<any>('message', dbPath, statsQuery, [...direction.params, ...where.params])
            if (stats && stats.total > 0) {
              const existing = contactStats.get(username) || { messageCount: 0, sentCount: 0, receivedCount: 0, unknownCount: 0, lastMessageTime: null }
              existing.messageCount += Number(stats.total || 0)
              existing.sentCount += Number(stats.sent_count || 0)
              existing.receivedCount += Number(stats.received_count || 0)
              existing.unknownCount += Number(stats.unknown_count || 0)
              if (stats.last_time && (!existing.lastMessageTime || stats.last_time > existing.lastMessageTime)) {
                existing.lastMessageTime = stats.last_time
              }
              contactStats.set(username, existing)
            }
          } catch (e) {
            recordStatsError(errors, e, { dbPath, tableName, prefix: '[AnalyticsService]' })
          }
        }
      }

      const contactInfo = await resolveContactNames(Array.from(contactStats.keys()))
      const rankings: ContactRanking[] = Array.from(contactStats.entries())
        .map(([username, stats]) => {
          const info = contactInfo.get(username)
          return {
            username,
            displayName: info?.displayName || username,
            avatarUrl: info?.avatarUrl,
            messageCount: stats.messageCount,
            sentCount: stats.sentCount,
            receivedCount: stats.receivedCount,
            unknownCount: stats.unknownCount,
            lastMessageTime: stats.lastMessageTime
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount || (b.lastMessageTime || 0) - (a.lastMessageTime || 0))
        .slice(0, limit)

      if (errors.length > 0) console.warn('[AnalyticsService] 联系人排名存在部分失败:', errors.length)
      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getTimeDistribution(startTime?: number, endTime?: number): Promise<{ success: boolean; data?: TimeDistribution; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const privateUsernames = await this.getPrivateSessions(cleanedWxid)
      const tableHashToUsername = this.buildPrivateHashMap(privateUsernames)
      const timeRange = normalizeTimeRange(startTime, endTime)
      const dbFiles = findMessageDbPaths()
      const errors: StatsPartialError[] = []

      const hourlyDistribution: Record<number, number> = {}
      const weekdayDistribution: Record<number, number> = {}
      const monthlyDistribution: Record<string, number> = {}
      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0
      for (let i = 1; i <= 7; i++) weekdayDistribution[i] = 0

      for (const dbPath of dbFiles) {
        let tables: string[] = []
        try {
          tables = await listExactMessageTables(dbPath)
        } catch (e) {
          recordStatsError(errors, e, { dbPath, prefix: '[AnalyticsService]' })
          continue
        }

        for (const tableName of tables) {
          const tableHash = extractExactMessageTableHash(tableName)
          if (!tableHash || !tableHashToUsername.has(tableHash)) continue

          try {
            const columns = await getMessageTableColumns(dbPath, tableName)
            const where = buildMessageStatsWhere({ range: timeRange, contentColumn: columns.contentColumn || undefined })
            const rows = await dbAdapter.all<{ create_time: number }>(
              'message',
              dbPath,
              `SELECT create_time FROM "${tableName}" ${where.sql}`,
              where.params
            )
            for (const row of rows) {
              if (!row.create_time) continue
              const d = new Date(row.create_time * 1000)
              const hour = d.getHours()
              const weekday = d.getDay() === 0 ? 7 : d.getDay()
              hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1
              weekdayDistribution[weekday] = (weekdayDistribution[weekday] || 0) + 1
              const month = toLocalMonthKey(row.create_time)
              monthlyDistribution[month] = (monthlyDistribution[month] || 0) + 1
            }
          } catch (e) {
            recordStatsError(errors, e, { dbPath, tableName, prefix: '[AnalyticsService]' })
          }
        }
      }

      const data: TimeDistribution = { hourlyDistribution, weekdayDistribution, monthlyDistribution }
      if (errors.length > 0) {
        data.errors = errors
        data.partialFailureCount = errors.length
      }
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close() {
    // 共享 messageDbScanner 缓存由账号切换入口统一清理。
  }
}

export const analyticsService = new AnalyticsService()

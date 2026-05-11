import { dbAdapter } from './dbAdapter'
import { resolveContactNames } from './contactNameResolver'
import { findSessionMessageTables, getMessageTableColumns, hasName2IdTable } from './messageDbScanner'
import { MAIN_MEDIA_TYPE_NAMES, StatsPartialError, TEXT_LOCAL_TYPES } from './statsConstants'
import { buildMessageStatsWhere, normalizeTimeRange, recordStatsError } from './statsSqlHelpers'

export interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  avatarUrl?: string
  sortTimestamp?: number
}

export interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
}

export interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

export interface GroupActiveHours {
  hourlyDistribution: Record<number, number>
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

export interface MediaTypeCount {
  type: number
  name: string
  count: number
}

export interface GroupMediaStats {
  typeCounts: MediaTypeCount[]
  total: number
  appSubtypes?: MediaTypeCount[]
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

export interface GroupMentionRank {
  member: GroupMember
  count: number
}

export interface GroupSystemEvent {
  type: 'join' | 'leave' | 'other'
  content: string
  createTime: number
}

export interface GroupEvents {
  mentions: GroupMentionRank[]
  systemEvents: GroupSystemEvent[]
  firstSpeaker: GroupMember | null
  averageMessageLength: number
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

export interface GroupMessageBreakdown {
  mediaStats: GroupMediaStats
  firstSpeaker: GroupMember | null
  averageMessageLength: number
  errors?: StatsPartialError[]
  partialFailureCount?: number
}

class GroupAnalyticsService {
  private toBuffer(value: any): Buffer | null {
    if (value == null) return null
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (Array.isArray(value)) return Buffer.from(value)
    if (typeof value === 'string') {
      try { return Buffer.from(value, 'base64') } catch { return null }
    }
    return null
  }

  private async getAvatarsFromHeadImageDb(usernames: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    if (usernames.length === 0) return result

    try {
      for (let i = 0; i < usernames.length; i += 500) {
        const group = usernames.slice(i, i + 500)
        const placeholders = group.map(() => '?').join(',')
        const rows = await dbAdapter.all<any>(
          'head_image',
          '',
          `SELECT username, image_buffer FROM head_image WHERE username IN (${placeholders})`,
          group
        )
        for (const row of rows) {
          const buffer = this.toBuffer(row?.image_buffer)
          if (!buffer || buffer.length === 0) continue
          result[row.username] = `data:image/jpeg;base64,${buffer.toString('base64')}`
        }
      }
    } catch (e) {
      console.error('从 head_image.db 获取头像失败:', e)
    }

    return result
  }

  private async hydrateMissingAvatars<T extends { username: string; avatarUrl?: string }>(items: T[]): Promise<void> {
    const missing = items.filter(item => !item.avatarUrl).map(item => item.username)
    const avatars = await this.getAvatarsFromHeadImageDb(missing)
    for (const item of items) {
      if (!item.avatarUrl && avatars[item.username]) item.avatarUrl = avatars[item.username]
    }
  }

  private classifyAppSubtype(content: string): { type: number; name: string } {
    const match = String(content || '').match(/<appmsg[^>]*\btype=["']?(\d+)["']?/i)
    const appType = match ? Number(match[1]) : -1
    const names: Record<number, string> = {
      1: '链接',
      5: '链接',
      6: '文件',
      19: '聊天记录',
      33: '小程序',
      36: '小程序',
      51: '视频号/分享',
      57: '引用',
      2000: '转账',
      2001: '红包',
    }
    return { type: appType, name: names[appType] || '其他 type=49' }
  }

  private classifySystemEvent(content: string): GroupSystemEvent['type'] {
    if (/加入群聊|邀请.*加入|invited/i.test(content)) return 'join'
    if (/退出群聊|移出群聊|removed|left/i.test(content)) return 'leave'
    return 'other'
  }

  private stripText(content: string): string {
    return String(content || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  async getGroupChats(): Promise<{ success: boolean; data?: GroupChatInfo[]; error?: string }> {
    try {
      const sessions = await dbAdapter.all<{ username: string; sort_timestamp?: number; last_timestamp?: number }>(
        'session',
        '',
        `SELECT username, sort_timestamp, last_timestamp
         FROM SessionTable
         WHERE username LIKE '%@chatroom' AND COALESCE(last_timestamp, sort_timestamp, 0) > 0`
      )

      if (sessions.length === 0) return { success: true, data: [] }

      const names = await resolveContactNames(sessions.map(s => s.username))
      const memberCountMap: Map<string, number> = new Map()

      try {
        const tables = await dbAdapter.all<{ name: string }>(
          'contact',
          '',
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chatroom_member', 'name2id')"
        )
        const hasChatroomMember = tables.some(t => t.name === 'chatroom_member')
        const hasName2Id = tables.some(t => t.name === 'name2id')

        if (hasChatroomMember && hasName2Id) {
          for (const { username } of sessions) {
            try {
              const row = await dbAdapter.get<{ count: number }>(
                'contact',
                '',
                `SELECT COUNT(*) as count FROM chatroom_member
                 WHERE room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
                [username]
              )
              memberCountMap.set(username, row?.count || 0)
            } catch (e) {
              console.warn('[GroupAnalyticsService] 群成员数量读取失败:', username, e)
            }
          }
        }
      } catch (e) {
        console.warn('[GroupAnalyticsService] 群成员表探测失败:', e)
      }

      const groups: GroupChatInfo[] = sessions.map(({ username, sort_timestamp, last_timestamp }) => {
        const info = names.get(username)
        return {
          username,
          displayName: info?.displayName || username,
          memberCount: memberCountMap.get(username) || 0,
          avatarUrl: info?.avatarUrl,
          sortTimestamp: sort_timestamp || last_timestamp || 0
        }
      }).sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))

      await this.hydrateMissingAvatars(groups)
      return { success: true, data: groups }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; data?: GroupMember[]; error?: string }> {
    try {
      const members: GroupMember[] = []
      try {
        const memberRows = await dbAdapter.all<{ username: string; nick_name?: string; remark?: string; alias?: string; small_head_url?: string; big_head_url?: string }>(
          'contact',
          '',
          `SELECT n.username, c.nick_name, c.remark, c.alias, c.small_head_url, c.big_head_url
           FROM chatroom_member m
           JOIN name2id n ON m.member_id = n.rowid
           LEFT JOIN contact c ON n.username = c.username
           WHERE m.room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
          [chatroomId]
        )

        for (const row of memberRows) {
          members.push({
            username: row.username,
            displayName: row.remark || row.nick_name || row.alias || row.username,
            avatarUrl: row.big_head_url || row.small_head_url
          })
        }
      } catch (e) {
        console.warn('[GroupAnalyticsService] 群成员读取失败:', chatroomId, e)
      }

      await this.hydrateMissingAvatars(members)
      return { success: true, data: members }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async getSenderCounts(dbPath: string, tableName: string, range = normalizeTimeRange()): Promise<Array<{ sender: string; count: number }>> {
    const columns = await getMessageTableColumns(dbPath, tableName)
    const hasName2Id = await hasName2IdTable(dbPath)
    if (hasName2Id && columns.hasRealSenderId) {
      const where = buildMessageStatsWhere({ alias: 'm', range, contentColumn: columns.contentColumn || undefined })
      return dbAdapter.all<{ sender: string; count: number }>(
        'message',
        dbPath,
        `SELECT n.user_name as sender, COUNT(*) as count
         FROM "${tableName}" m
         JOIN Name2Id n ON m.real_sender_id = n.rowid
         ${where.sql}
         GROUP BY m.real_sender_id`,
        where.params
      )
    }

    if (columns.senderColumn) {
      const where = buildMessageStatsWhere({ range, contentColumn: columns.contentColumn || undefined })
      const prefix = where.sql ? `${where.sql} AND` : 'WHERE'
      return dbAdapter.all<{ sender: string; count: number }>(
        'message',
        dbPath,
        `SELECT "${columns.senderColumn}" as sender, COUNT(*) as count
         FROM "${tableName}"
         ${prefix} "${columns.senderColumn}" IS NOT NULL AND "${columns.senderColumn}" != ''
         GROUP BY "${columns.senderColumn}"`,
        where.params
      )
    }

    return []
  }

  async getGroupMessageRanking(
    chatroomId: string,
    limit: number = 20,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupMessageRank[]; error?: string; errors?: StatsPartialError[]; partialFailureCount?: number }> {
    try {
      const messageCounts: Map<string, number> = new Map()
      const errors: StatsPartialError[] = []
      const range = normalizeTimeRange(startTime, endTime)

      for (const pair of await findSessionMessageTables(chatroomId)) {
        try {
          const senderCounts = await this.getSenderCounts(pair.dbPath, pair.tableName, range)
          for (const { sender, count } of senderCounts) {
            if (sender) messageCounts.set(sender, (messageCounts.get(sender) || 0) + count)
          }
        } catch (e) {
          recordStatsError(errors, e, { dbPath: pair.dbPath, tableName: pair.tableName, prefix: '[GroupAnalyticsService]' })
        }
      }

      const membersResult = await this.getGroupMembers(chatroomId)
      const memberMap = new Map<string, GroupMember>()
      if (membersResult.success && membersResult.data) {
        for (const m of membersResult.data) memberMap.set(m.username, m)
      }
      const missing = Array.from(messageCounts.keys()).filter(username => !memberMap.has(username))
      const resolved = await resolveContactNames(missing)
      for (const [username, info] of resolved) memberMap.set(username, info)

      const rankings = Array.from(messageCounts.entries())
        .map(([username, count]) => ({
          member: memberMap.get(username) || { username, displayName: username },
          messageCount: count
        }))
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      const result: any = { success: true, data: rankings }
      if (errors.length > 0) Object.assign(result, { errors, partialFailureCount: errors.length })
      return result
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupActiveHours(
    chatroomId: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupActiveHours; error?: string }> {
    try {
      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0
      const errors: StatsPartialError[] = []
      const range = normalizeTimeRange(startTime, endTime)

      for (const pair of await findSessionMessageTables(chatroomId)) {
        try {
          const columns = await getMessageTableColumns(pair.dbPath, pair.tableName)
          const where = buildMessageStatsWhere({ range, contentColumn: columns.contentColumn || undefined })
          const rows = await dbAdapter.all<{ create_time: number }>(
            'message',
            pair.dbPath,
            `SELECT create_time FROM "${pair.tableName}" ${where.sql}`,
            where.params
          )
          for (const row of rows) {
            const hour = new Date(row.create_time * 1000).getHours()
            hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1
          }
        } catch (e) {
          recordStatsError(errors, e, { dbPath: pair.dbPath, tableName: pair.tableName, prefix: '[GroupAnalyticsService]' })
        }
      }

      const data: GroupActiveHours = { hourlyDistribution }
      if (errors.length > 0) Object.assign(data, { errors, partialFailureCount: errors.length })
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMediaStats(
    chatroomId: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupMediaStats; error?: string }> {
    try {
      const typeCounts = new Map<number, number>()
      const subtypeCounts = new Map<number, { name: string; count: number }>()
      const errors: StatsPartialError[] = []
      const range = normalizeTimeRange(startTime, endTime)

      for (const pair of await findSessionMessageTables(chatroomId)) {
        try {
          const columns = await getMessageTableColumns(pair.dbPath, pair.tableName)
          const where = buildMessageStatsWhere({ range, contentColumn: columns.contentColumn || undefined })
          const rows = await dbAdapter.all<{ local_type: number; count: number }>(
            'message',
            pair.dbPath,
            `SELECT local_type, COUNT(*) as count
             FROM "${pair.tableName}"
             ${where.sql}
             GROUP BY local_type`,
            where.params
          )
          for (const { local_type, count } of rows) {
            typeCounts.set(local_type, (typeCounts.get(local_type) || 0) + count)
          }

          if (columns.contentColumn) {
            const appRows = await dbAdapter.all<{ msg_content: string }>(
              'message',
              pair.dbPath,
              `SELECT "${columns.contentColumn}" as msg_content
               FROM "${pair.tableName}"
               ${where.sql ? `${where.sql} AND` : 'WHERE'} local_type = 49`,
              where.params
            )
            for (const row of appRows) {
              const subtype = this.classifyAppSubtype(row.msg_content)
              const existing = subtypeCounts.get(subtype.type) || { name: subtype.name, count: 0 }
              existing.count++
              subtypeCounts.set(subtype.type, existing)
            }
          }
        } catch (e) {
          recordStatsError(errors, e, { dbPath: pair.dbPath, tableName: pair.tableName, prefix: '[GroupAnalyticsService]' })
        }
      }

      const result: MediaTypeCount[] = Array.from(typeCounts.entries())
        .filter(([, count]) => count > 0)
        .map(([type, count]) => ({
          type,
          name: MAIN_MEDIA_TYPE_NAMES[type] || '其他',
          count
        }))
        .sort((a, b) => b.count - a.count)

      const appSubtypes: MediaTypeCount[] = Array.from(subtypeCounts.entries())
        .map(([type, item]) => ({ type, name: item.name, count: item.count }))
        .sort((a, b) => b.count - a.count)

      const data: GroupMediaStats = {
        typeCounts: result,
        total: result.reduce((sum, item) => sum + item.count, 0),
        appSubtypes,
      }
      if (errors.length > 0) Object.assign(data, { errors, partialFailureCount: errors.length })
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async getFirstSpeaker(chatroomId: string, startTime?: number, endTime?: number): Promise<GroupMember | null> {
    const range = normalizeTimeRange(startTime, endTime)
    let best: { username: string; createTime: number } | null = null
    for (const pair of await findSessionMessageTables(chatroomId)) {
      const columns = await getMessageTableColumns(pair.dbPath, pair.tableName)
      const hasName2Id = await hasName2IdTable(pair.dbPath)
      const where = buildMessageStatsWhere({ alias: hasName2Id && columns.hasRealSenderId ? 'm' : undefined, range, contentColumn: columns.contentColumn || undefined })
      let row: { sender?: string; create_time: number } | null = null
      if (hasName2Id && columns.hasRealSenderId) {
        row = await dbAdapter.get<any>(
          'message',
          pair.dbPath,
          `SELECT n.user_name as sender, m.create_time
           FROM "${pair.tableName}" m JOIN Name2Id n ON m.real_sender_id = n.rowid
           ${where.sql}
           ORDER BY m.create_time ASC LIMIT 1`,
          where.params
        )
      } else if (columns.senderColumn) {
        row = await dbAdapter.get<any>(
          'message',
          pair.dbPath,
          `SELECT "${columns.senderColumn}" as sender, create_time
           FROM "${pair.tableName}"
           ${where.sql}
           ORDER BY create_time ASC LIMIT 1`,
          where.params
        )
      }
      if (row?.sender && (!best || row.create_time < best.createTime)) {
        best = { username: row.sender, createTime: row.create_time }
      }
    }
    if (!best) return null
    const names = await resolveContactNames([best.username])
    return names.get(best.username) || { username: best.username, displayName: best.username }
  }

  async getGroupEvents(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupEvents; error?: string }> {
    try {
      const errors: StatsPartialError[] = []
      const range = normalizeTimeRange(startTime, endTime)
      const membersResult = await this.getGroupMembers(chatroomId)
      const memberMap = new Map<string, GroupMember>()
      const displayToMember = new Map<string, GroupMember>()
      for (const member of membersResult.data || []) {
        memberMap.set(member.username, member)
        displayToMember.set(member.displayName, member)
      }
      const mentionCounts = new Map<string, number>()
      const systemEvents: GroupSystemEvent[] = []
      let textLengthSum = 0
      let textCount = 0

      for (const pair of await findSessionMessageTables(chatroomId)) {
        try {
          const columns = await getMessageTableColumns(pair.dbPath, pair.tableName)
          const where = buildMessageStatsWhere({ range, contentColumn: columns.contentColumn || undefined })

          if (columns.contentColumn) {
            const textRows = await dbAdapter.all<{ msg_content: string; local_type: number }>(
              'message',
              pair.dbPath,
              `SELECT local_type, "${columns.contentColumn}" as msg_content
               FROM "${pair.tableName}"
               ${where.sql}
               AND local_type IN (${TEXT_LOCAL_TYPES.map(() => '?').join(',')})`,
              [...where.params, ...TEXT_LOCAL_TYPES]
            )
            for (const row of textRows) {
              const text = this.stripText(row.msg_content)
              if (text) {
                textLengthSum += text.length
                textCount++
              }
              for (const match of text.matchAll(/@([^\s\u2005]+)/g)) {
                const token = match[1].trim()
                const member = displayToMember.get(token) || memberMap.get(token)
                const key = member?.username || token
                mentionCounts.set(key, (mentionCounts.get(key) || 0) + 1)
              }
            }

            const systemWhere = buildMessageStatsWhere({
              range,
              contentColumn: columns.contentColumn || undefined,
              includeExcludedTypes: false,
            })
            const systemRows = await dbAdapter.all<{ create_time: number; msg_content: string }>(
              'message',
              pair.dbPath,
              `SELECT create_time, "${columns.contentColumn}" as msg_content
               FROM "${pair.tableName}"
               ${systemWhere.sql}
               AND local_type = 10000
               ORDER BY create_time ASC`,
              systemWhere.params
            )
            for (const row of systemRows) {
              const content = this.stripText(row.msg_content)
              if (!content) continue
              const type = this.classifySystemEvent(content)
              if (type !== 'other') systemEvents.push({ type, content, createTime: row.create_time })
            }
          }
        } catch (e) {
          recordStatsError(errors, e, { dbPath: pair.dbPath, tableName: pair.tableName, prefix: '[GroupAnalyticsService]' })
        }
      }

      const missingNames = Array.from(mentionCounts.keys()).filter(username => !memberMap.has(username))
      const resolved = await resolveContactNames(missingNames)
      for (const [username, info] of resolved) memberMap.set(username, info)
      const mentions = Array.from(mentionCounts.entries())
        .map(([username, count]) => ({ member: memberMap.get(username) || { username, displayName: username }, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)

      const data: GroupEvents = {
        mentions,
        systemEvents: systemEvents.slice(-100),
        firstSpeaker: await this.getFirstSpeaker(chatroomId, startTime, endTime),
        averageMessageLength: textCount > 0 ? Math.round((textLengthSum / textCount) * 10) / 10 : 0,
      }
      if (errors.length > 0) Object.assign(data, { errors, partialFailureCount: errors.length })
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMessageBreakdown(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMessageBreakdown; error?: string }> {
    const media = await this.getGroupMediaStats(chatroomId, startTime, endTime)
    const events = await this.getGroupEvents(chatroomId, startTime, endTime)
    if (!media.success) return { success: false, error: media.error }
    if (!events.success) return { success: false, error: events.error }
    const errors = [...(media.data?.errors || []), ...(events.data?.errors || [])]
    const data: GroupMessageBreakdown = {
      mediaStats: media.data || { typeCounts: [], total: 0 },
      firstSpeaker: events.data?.firstSpeaker || null,
      averageMessageLength: events.data?.averageMessageLength || 0,
    }
    if (errors.length > 0) Object.assign(data, { errors, partialFailureCount: errors.length })
    return { success: true, data }
  }

  close() {
    // 无服务内缓存。
  }
}

export const groupAnalyticsService = new GroupAnalyticsService()

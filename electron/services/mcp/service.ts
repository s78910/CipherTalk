import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { chatService } from '../chatService'
import { ConfigService } from '../config'
import { imageDecryptService } from '../imageDecryptService'
import { videoService } from '../videoService'
import { McpToolError } from './result'
import type { McpMessageItem, McpMessagesPayload, McpSessionItem, McpSessionsPayload } from './types'

const listSessionsArgsSchema = z.object({
  q: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  unreadOnly: z.boolean().optional()
})

const getMessagesArgsSchema = z.object({
  sessionId: z.string().trim().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  keyword: z.string().optional(),
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().optional(),
  includeRaw: z.boolean().optional(),
  includeMediaPaths: z.boolean().optional()
})

type ListSessionsArgs = z.infer<typeof listSessionsArgsSchema>
type GetMessagesArgs = z.infer<typeof getMessagesArgsSchema>

function toTimestampMs(value?: number | null): number | null {
  if (!value || !Number.isFinite(value) || value <= 0) return null
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function detectSessionKind(sessionId: string): McpSessionItem['kind'] {
  if (sessionId.includes('@chatroom')) return 'group'
  if (sessionId.startsWith('gh_')) return 'official'
  if (sessionId) return 'friend'
  return 'other'
}

function detectMessageKind(message: Record<string, unknown>): string {
  const localType = Number(message.localType || 0)
  const raw = String(message.rawContent || message.parsedContent || '')
  const xmlTypeMatch = raw.match(/<type>\s*([^<]+)\s*<\/type>/i)
  const appMsgType = xmlTypeMatch?.[1]?.trim()

  if (localType === 1) return 'text'
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 42) return 'contact_card'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 48) return 'location'
  if (localType === 50) return 'voip'
  if (localType === 10000) return 'system'
  if (localType === 244813135921) return 'quote'

  if (localType === 49 || appMsgType) {
    switch (appMsgType) {
      case '3':
        return 'app_music'
      case '5':
      case '49':
        return 'app_link'
      case '6':
        return 'app_file'
      case '19':
        return 'app_chat_record'
      case '33':
      case '36':
        return 'app_mini_program'
      case '57':
        return 'app_quote'
      case '62':
        return 'app_pat'
      case '87':
        return 'app_announcement'
      case '115':
        return 'app_gift'
      case '2000':
        return 'app_transfer'
      case '2001':
        return 'app_red_packet'
      default:
        return 'app'
    }
  }

  return 'unknown'
}

function mapChatError(errorMessage?: string): never {
  const message = errorMessage || 'Unknown chat service error.'

  if (
    message.includes('请先在设置页面配置微信ID') ||
    message.includes('请先解密数据库') ||
    message.includes('未找到账号') ||
    message.includes('未找到 session.db') ||
    message.includes('未找到会话表') ||
    message.includes('数据库未连接')
  ) {
    throw new McpToolError('DB_NOT_READY', 'Chat database is not ready.', message)
  }

  if (message.includes('未找到该会话的消息表')) {
    throw new McpToolError('SESSION_NOT_FOUND', 'Session not found.', message)
  }

  throw new McpToolError('INTERNAL_ERROR', 'Failed to query CipherTalk data.', message)
}

async function getEmojiLocalPath(base: Record<string, unknown>): Promise<string | null> {
  const emojiMd5 = base.emojiMd5 as string | undefined
  const emojiCdnUrl = base.emojiCdnUrl as string | undefined

  if (!emojiMd5 && !emojiCdnUrl) return null

  try {
    const result = await chatService.downloadEmoji(
      String(emojiCdnUrl || ''),
      emojiMd5,
      base.productId as string | undefined,
      Number(base.createTime || 0)
    )

    return result.success ? result.cachePath || result.localPath || null : null
  } catch {
    return null
  }
}

async function getImageLocalPath(sessionId: string, base: Record<string, unknown>): Promise<string | null> {
  if (!base.imageMd5 && !base.imageDatName) return null

  try {
    const resolved = await imageDecryptService.resolveCachedImage({
      sessionId,
      imageMd5: base.imageMd5 as string | undefined,
      imageDatName: base.imageDatName as string | undefined
    })

    if (resolved.success && resolved.localPath) {
      return resolved.localPath
    }

    const decrypted = await imageDecryptService.decryptImage({
      sessionId,
      imageMd5: base.imageMd5 as string | undefined,
      imageDatName: base.imageDatName as string | undefined,
      force: false
    })

    return decrypted.success ? decrypted.localPath || null : null
  } catch {
    return null
  }
}

function getVideoLocalPath(base: Record<string, unknown>): string | null {
  if (!base.videoMd5) return null

  try {
    const info = videoService.getVideoInfo(String(base.videoMd5))
    return info.exists ? info.videoUrl || null : null
  } catch {
    return null
  }
}

async function getVoiceLocalPath(sessionId: string, base: Record<string, unknown>): Promise<string | null> {
  const localId = Number(base.localId || 0)
  const createTime = Number(base.createTime || 0)
  if (!localId || !createTime) return null

  try {
    const voiceResult = await chatService.getVoiceData(sessionId, String(localId), createTime)
    if (!voiceResult.success || !voiceResult.data) return null

    const configService = new ConfigService()
    const cachePath = String(configService.get('cachePath') || '')
    configService.close()

    const baseDir = cachePath || join(process.cwd(), 'cache')
    const voiceDir = join(baseDir, 'McpVoices', sessionId.replace(/[\\/:*?"<>|]/g, '_'))
    if (!existsSync(voiceDir)) {
      mkdirSync(voiceDir, { recursive: true })
    }

    const absolutePath = join(voiceDir, `${createTime}_${localId}.wav`)
    await writeFile(absolutePath, Buffer.from(voiceResult.data, 'base64'))
    return absolutePath
  } catch {
    return null
  }
}

function getFileLocalPath(base: Record<string, unknown>): string | null {
  const fileName = String(base.fileName || '')
  if (!fileName) return null

  const configService = new ConfigService()
  try {
    const dbPath = String(configService.get('dbPath') || '')
    const myWxid = String(configService.get('myWxid') || '')
    if (!dbPath || !myWxid) return null

    const createTimeMs = toTimestampMs(Number(base.createTime || 0))
    const fileDate = createTimeMs ? new Date(createTimeMs) : new Date()
    const monthDir = `${fileDate.getFullYear()}-${String(fileDate.getMonth() + 1).padStart(2, '0')}`
    return join(dbPath, myWxid, 'msg', 'file', monthDir, fileName)
  } finally {
    configService.close()
  }
}

async function toMcpMessage(sessionId: string, includeMediaPaths: boolean, includeRaw: boolean, message: Record<string, unknown>): Promise<McpMessageItem> {
  const kind = detectMessageKind(message)
  const direction = Number(message.isSend) === 1 ? 'out' : 'in'
  const base: McpMessageItem = {
    messageId: Number(message.localId || message.serverId || 0),
    timestamp: Number(message.createTime || 0),
    direction,
    kind,
    text: String(message.parsedContent || message.rawContent || ''),
    sender: {
      username: (message.senderUsername as string | null) ?? null,
      isSelf: direction === 'out'
    }
  }

  if (includeRaw) {
    base.raw = String(message.rawContent || '')
  }

  switch (kind) {
    case 'emoji':
      base.media = {
        type: 'emoji',
        md5: (message.emojiMd5 as string | undefined) || null
      }
      if (includeMediaPaths) {
        base.media.localPath = await getEmojiLocalPath(message)
      }
      break
    case 'image':
      base.media = {
        type: 'image',
        md5: (message.imageMd5 as string | undefined) || null,
        isLivePhoto: Boolean(message.isLivePhoto)
      }
      if (includeMediaPaths) {
        base.media.localPath = await getImageLocalPath(sessionId, message)
      }
      break
    case 'video':
      base.media = {
        type: 'video',
        md5: (message.videoMd5 as string | undefined) || null,
        durationSeconds: Number(message.videoDuration || 0) || null,
        isLivePhoto: Boolean(message.isLivePhoto)
      }
      if (includeMediaPaths) {
        base.media.localPath = getVideoLocalPath(message)
      }
      break
    case 'voice':
      base.media = {
        type: 'voice',
        durationSeconds: Number(message.voiceDuration || 0) || null
      }
      if (includeMediaPaths) {
        base.media.localPath = await getVoiceLocalPath(sessionId, message)
      }
      break
    case 'app_file': {
      const localPath = includeMediaPaths ? getFileLocalPath(message) : null
      base.media = {
        type: 'file',
        md5: (message.fileMd5 as string | undefined) || null,
        fileName: (message.fileName as string | undefined) || null,
        fileSize: Number(message.fileSize || 0) || null,
        localPath,
        exists: localPath ? existsSync(localPath) : null
      }
      break
    }
    default:
      break
  }

  return base
}

export class McpReadService {
  async listSessions(rawArgs: ListSessionsArgs): Promise<McpSessionsPayload> {
    const args = listSessionsArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid list_sessions arguments.', args.error.message)
    }

    const query = String(args.data.q || '').trim().toLowerCase()
    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 100, 200)
    const unreadOnly = Boolean(args.data.unreadOnly)

    const result = await chatService.getSessions()
    if (!result.success) {
      mapChatError(result.error)
    }

    let sessions = (result.sessions || []).map((session) => ({
      sessionId: session.username,
      displayName: session.displayName || session.username,
      kind: detectSessionKind(session.username),
      lastMessagePreview: session.summary || '',
      unreadCount: Number(session.unreadCount || 0),
      lastTimestamp: Number(session.lastTimestamp || 0)
    } satisfies McpSessionItem))

    if (query) {
      sessions = sessions.filter((session) => {
        return [
          session.sessionId,
          session.displayName,
          session.lastMessagePreview
        ].some((value) => value.toLowerCase().includes(query))
      })
    }

    if (unreadOnly) {
      sessions = sessions.filter((session) => session.unreadCount > 0)
    }

    sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)

    const total = sessions.length
    const items = sessions.slice(offset, offset + limit)

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total
    }
  }

  async getMessages(rawArgs: GetMessagesArgs, defaultIncludeMediaPaths: boolean): Promise<McpMessagesPayload> {
    const args = getMessagesArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_messages arguments.', args.error.message)
    }

    const {
      sessionId,
      keyword,
      includeRaw = false,
      order = 'asc'
    } = args.data

    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 50, 200)
    const includeMediaPaths = args.data.includeMediaPaths ?? defaultIncludeMediaPaths
    const keywordQuery = String(keyword || '').trim().toLowerCase()
    const startTimeMs = toTimestampMs(args.data.startTime)
    const endTimeMs = toTimestampMs(args.data.endTime)

    const matched: Record<string, unknown>[] = []
    const batchSize = 200
    const maxScan = 5000
    let scanOffset = 0
    let scanned = 0
    let reachedEnd = false
    const targetCount = offset + limit + 1

    while (scanned < maxScan && matched.length < targetCount) {
      const result = await chatService.getMessages(sessionId, scanOffset, batchSize)
      if (!result.success) {
        mapChatError(result.error)
      }

      const part = result.messages || []
      if (part.length === 0) {
        reachedEnd = true
        break
      }

      for (const message of part) {
        const timestampMs = toTimestampMs(Number(message.createTime || 0)) || 0
        const parsedContent = String(message.parsedContent || '')
        const rawContent = String(message.rawContent || '')

        if (startTimeMs && timestampMs < startTimeMs) continue
        if (endTimeMs && timestampMs > endTimeMs) continue
        if (keywordQuery && !parsedContent.toLowerCase().includes(keywordQuery) && !rawContent.toLowerCase().includes(keywordQuery)) {
          continue
        }

        matched.push(message as unknown as Record<string, unknown>)
      }

      scanOffset += part.length
      scanned += part.length

      if (!result.hasMore) {
        reachedEnd = true
        break
      }
    }

    matched.sort((a, b) => {
      const timeDelta = Number(a.createTime || 0) - Number(b.createTime || 0)
      if (timeDelta !== 0) {
        return order === 'asc' ? timeDelta : -timeDelta
      }

      const idDelta = Number(a.localId || 0) - Number(b.localId || 0)
      return order === 'asc' ? idDelta : -idDelta
    })

    const page = matched.slice(offset, offset + limit)
    const items = await Promise.all(page.map((message) => toMcpMessage(sessionId, includeMediaPaths, includeRaw, message)))

    return {
      items,
      offset,
      limit,
      hasMore: reachedEnd ? matched.length > offset + items.length : true
    }
  }
}

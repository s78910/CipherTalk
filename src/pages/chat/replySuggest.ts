import type { ChatSession, Message } from '../../types/models'
import type { PersonaRecordInfo } from '../../types/electron'
import { isGroupChat } from './utils/messageGuards'

/** 回复建议：类型、会话级配置读写、上下文构建。UI 在 ChatHeader(设置下拉) 和 ReplySuggestBar(悬浮卡片)。 */

export type ReplySuggestStyle = 'natural' | 'short' | 'formal' | 'humorous' | 'warm' | 'likeme'

export type ReplySuggestSettings = {
  enabled: boolean
  style: ReplySuggestStyle
  count: number
  /** 深度模式：把更多历史消息作为上下文（不走完整 Agent 工具循环） */
  deep: boolean
}

export const REPLY_SUGGEST_CONFIG_KEY = 'replySuggestSessions'

export const REPLY_SUGGEST_STYLES: Array<{ id: ReplySuggestStyle; label: string }> = [
  { id: 'natural', label: '自然' },
  { id: 'short', label: '简短' },
  { id: 'formal', label: '正式' },
  { id: 'humorous', label: '幽默' },
  { id: 'warm', label: '热情' },
  { id: 'likeme', label: '像我' },
]

export const REPLY_SUGGEST_COUNTS = [1, 2, 3, 4, 5]

export const DEFAULT_REPLY_SUGGEST_SETTINGS: ReplySuggestSettings = {
  enabled: false,
  style: 'natural',
  count: 3,
  deep: false,
}

type SettingsMap = Record<string, Partial<ReplySuggestSettings> | undefined>

const STYLE_IDS = new Set<string>(REPLY_SUGGEST_STYLES.map((s) => s.id))

export function normalizeReplySuggestSettings(raw: Partial<ReplySuggestSettings> | undefined): ReplySuggestSettings {
  return {
    enabled: raw?.enabled === true,
    style: raw?.style && STYLE_IDS.has(raw.style) ? raw.style : DEFAULT_REPLY_SUGGEST_SETTINGS.style,
    count: REPLY_SUGGEST_COUNTS.includes(Number(raw?.count)) ? Number(raw?.count) : DEFAULT_REPLY_SUGGEST_SETTINGS.count,
    deep: raw?.deep === true,
  }
}

export async function getReplySuggestSettings(username: string): Promise<ReplySuggestSettings> {
  const map = (await window.electronAPI.config.get(REPLY_SUGGEST_CONFIG_KEY)) as SettingsMap | null | undefined
  return normalizeReplySuggestSettings(map?.[username])
}

export async function updateReplySuggestSettings(
  username: string,
  patch: Partial<ReplySuggestSettings>,
): Promise<ReplySuggestSettings> {
  const map = ((await window.electronAPI.config.get(REPLY_SUGGEST_CONFIG_KEY)) as SettingsMap | null | undefined) ?? {}
  const next = { ...normalizeReplySuggestSettings(map[username]), ...patch }
  await window.electronAPI.config.set(REPLY_SUGGEST_CONFIG_KEY, { ...map, [username]: next })
  return next
}

/** 与 ChatHeader 的私聊判定保持一致：排除群聊/公众号/聚合会话 */
export function isReplySuggestSession(session: ChatSession): boolean {
  return !isGroupChat(session.username)
    && !session.username.startsWith('gh_')
    && !session.isOfficialAccount
    && !session.isOfficialFolder
}

/** 取最近消息作为对话上下文（从旧到新）。深度模式取更长历史。 */
export function buildSuggestContext(messages: Message[], deep: boolean): Array<{ fromMe: boolean; text: string }> {
  const take = deep ? 120 : 30
  return messages
    .filter((m) => m.parsedContent?.trim())
    .slice(-take)
    .map((m) => ({ fromMe: m.isSend === 1, text: m.parsedContent.trim() }))
}

/** "像我"风格的 few-shot：取"我"最近的文本发言，跳过 [图片] 这类占位。 */
export function buildMyRecentTexts(messages: Message[]): string[] {
  return messages
    .filter((m) => m.isSend === 1)
    .map((m) => m.parsedContent?.trim() ?? '')
    .filter((t) => t && !/^\[.+\]$/.test(t))
    .slice(-20)
}

/**
 * 自画像存储键：克隆我自己按联系人会话隔离（我对每个人说话方式不同，不共享）。
 * 主进程 buildPersonaFromSession(role='self') 用相同前缀落库。
 */
export function myPersonaStorageKey(contactSessionId: string): string {
  return `self:${contactSessionId}`
}

/** 加载"我"对某联系人的自画像；不存在返回 null。失败静默（likeme 退回 myRecentTexts 兜底）。 */
export async function loadMyPersona(contactSessionId: string): Promise<PersonaRecordInfo | null> {
  try {
    const res = await window.electronAPI.persona.get(myPersonaStorageKey(contactSessionId))
    return res.success && res.persona ? res.persona : null
  } catch {
    return null
  }
}

/**
 * 把自画像画像卡 + few-shot 渲染成给 LLM 的提示文本，供"像我"回复建议使用。
 * 自画像是按"我对该联系人"的说话风格提炼的，比 myRecentTexts 的纯 few-shot 更系统。
 */
export function buildMyPersonaContext(persona: PersonaRecordInfo): string {
  const lines: string[] = []
  const { card, fewShots } = persona
  if (card.tone) lines.push(`- 语气风格：${card.tone}`)
  if (card.personalityTraits?.length) lines.push(`- 性格特征：${card.personalityTraits.join('、')}`)
  if (card.catchphrases?.length) lines.push(`- 口头禅/高频用语：${card.catchphrases.join('、')}`)
  if (card.punctuationStyle) lines.push(`- 标点排版习惯：${card.punctuationStyle}`)
  if (card.addressing) lines.push(`- 称呼习惯：${card.addressing}`)
  if (card.topics?.length) lines.push(`- 常聊话题：${card.topics.join('、')}`)
  if (fewShots?.length) {
    lines.push('- 真实问答示例（模仿"我"的回复）：')
    for (const shot of fewShots.slice(0, 6)) {
      lines.push(`  · 对方：${shot.user}`)
      lines.push(`    我：${shot.replies.join('／')}`)
    }
  }
  return lines.join('\n')
}

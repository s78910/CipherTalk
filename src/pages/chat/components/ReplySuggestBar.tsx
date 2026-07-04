import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleDashed, Xmark } from '@gravity-ui/icons'
import type { ChatSession, Message } from '../../../types/models'
import {
  REPLY_SUGGEST_CONFIG_KEY,
  type ReplySuggestSettings,
  buildMyPersonaContext,
  buildMyRecentTexts,
  buildSuggestContext,
  getReplySuggestSettings,
  loadMyPersona,
} from '../replySuggest'
import { useTopToast } from '../hooks/useTopToast'

const QUIET_MS = 5000

/**
 * 悬浮回复建议栏：开启后，最后一条消息是对方发来且 5 秒内没有更新时，
 * 用最近上下文调一次轻量模型生成建议卡片；点击卡片复制到剪贴板。
 * 无建议时不渲染任何 DOM。
 */
export function ReplySuggestBar({ session, messages }: { session: ChatSession; messages: Message[] }) {
  const [settings, setSettings] = useState<ReplySuggestSettings | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const { showTopToast } = useTopToast()
  // 已生成过建议的触发消息 key，避免同一条消息反复触发（含失败后的重试风暴）
  const handledKeyRef = useRef<string | null>(null)
  const sessionRef = useRef(session.username)
  sessionRef.current = session.username

  // 会话级设置：加载 + 跟随 config 变更（ChatHeader 下拉里改动后这里立即生效）
  useEffect(() => {
    let cancelled = false
    void getReplySuggestSettings(session.username).then((s) => {
      if (!cancelled) setSettings(s)
    })
    const off = window.electronAPI.config.onChanged(({ key }) => {
      if (key !== REPLY_SUGGEST_CONFIG_KEY) return
      void getReplySuggestSettings(session.username).then((s) => {
        if (!cancelled) setSettings(s)
      })
    })
    return () => { cancelled = true; off() }
  }, [session.username])

  // 切会话/关闭功能：清空现有建议
  useEffect(() => {
    setSuggestions([])
    handledKeyRef.current = null
  }, [session.username])

  useEffect(() => {
    if (settings && !settings.enabled) setSuggestions([])
  }, [settings])

  const generate = useCallback(async (current: ReplySuggestSettings) => {
    const username = sessionRef.current
    setLoading(true)
    try {
      // likeme 模式优先用自画像（按"我对该联系人"说话风格提炼），无则退回最近发言 few-shot
      let myPersonaContext: string | undefined
      let myRecentTexts: string[] | undefined
      if (current.style === 'likeme') {
        const persona = await loadMyPersona(session.username)
        if (persona) {
          myPersonaContext = buildMyPersonaContext(persona)
        } else {
          myRecentTexts = buildMyRecentTexts(messages)
        }
      }
      const res = await window.electronAPI.agent.replySuggest({
        contactName: session.displayName || session.username,
        context: buildSuggestContext(messages, current.deep),
        style: current.style,
        count: current.count,
        myRecentTexts,
        myPersonaContext,
      })
      // 生成期间切走了会话就丢弃结果
      if (sessionRef.current !== username) return
      if (res.success && res.suggestions?.length) {
        setSuggestions(res.suggestions)
      } else if (!res.success) {
        console.warn('[ReplySuggest] 生成失败:', res.error)
      }
    } catch (e) {
      console.warn('[ReplySuggest] 生成失败:', e)
    } finally {
      setLoading(false)
    }
    // messages 刻意不进依赖：generate 只在触发定时器到点时调用，用当时闭包里的列表即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.displayName, session.username, messages])

  // 触发机制：最后一条是对方消息，5 秒静默后生成。新消息到达会重跑本 effect，
  // cleanup 清掉旧定时器，天然构成"5 秒内没有更新才触发"的防抖。
  useEffect(() => {
    if (!settings?.enabled) return
    const last = messages[messages.length - 1]
    if (!last || last.isSend === 1 || !last.parsedContent?.trim()) return
    const key = `${session.username}:${last.localId}:${last.createTime}`
    if (key === handledKeyRef.current) return
    // 有新消息进来，旧建议已过时
    setSuggestions([])
    const timer = setTimeout(() => {
      handledKeyRef.current = key
      void generate(settings)
    }, QUIET_MS)
    return () => clearTimeout(timer)
  }, [messages, settings, session.username, generate])

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => showTopToast('已复制，去微信粘贴发送'))
      .catch(() => showTopToast('复制失败', false))
  }, [showTopToast])

  if (!settings?.enabled) return null
  if (!loading && suggestions.length === 0) return null

  return (
    <div className="reply-suggest-bar" aria-live="polite">
      {loading ? (
        <div className="reply-suggest-bar__loading">
          <CircleDashed width={14} height={14} className="animate-spin" />
          <span>正在生成回复建议…</span>
        </div>
      ) : (
        <>
          <div className="reply-suggest-bar__cards">
            {suggestions.map((text, index) => (
              <button
                className="reply-suggest-bar__card"
                key={`${index}:${text}`}
                title="点击复制"
                type="button"
                onClick={() => handleCopy(text)}
              >
                {text}
              </button>
            ))}
          </div>
          <button
            aria-label="关闭建议"
            className="reply-suggest-bar__close"
            type="button"
            onClick={() => setSuggestions([])}
          >
            <Xmark width={14} height={14} />
          </button>
        </>
      )}
    </div>
  )
}

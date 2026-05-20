import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, Loader2, Sparkles, X } from 'lucide-react'
import type { ChatSession, Message } from '../../../types/models'
import { isGroupChat, isSystemMessage } from '../utils/messageGuards'
import { formatDateDivider, shouldShowDateDivider } from '../utils/time'
import {
  POSTER_THEMES,
  POSTER_THEME_SCOPE,
  createCustomThemeId,
  scopePosterCss,
  type CustomPosterTheme
} from '../posterThemes'

interface SenderInfo {
  name: string
  avatarUrl?: string
}

interface SharePosterModalProps {
  session: ChatSession
  messages: Message[]
  myAvatarUrl?: string
  onClose: () => void
  showTopToast: (text: string, success?: boolean) => void
}

function avatarLetter(name: string): string {
  const trimmed = (name || '?').trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

async function waitForImages(node: HTMLElement): Promise<void> {
  const imgs = Array.from(node.querySelectorAll('img'))
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true })
      img.addEventListener('error', () => resolve(), { once: true })
    })
  }))
}

export function SharePosterModal({ session, messages, myAvatarUrl, onClose, showTopToast }: SharePosterModalProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [senders, setSenders] = useState<Map<string, SenderInfo>>(new Map())
  const group = isGroupChat(session.username)

  const [themeId, setThemeId] = useState('default')
  const [customThemes, setCustomThemes] = useState<CustomPosterTheme[]>([])
  const [aiOpen, setAiOpen] = useState(false)
  const [aiDesc, setAiDesc] = useState('')
  const [aiBusy, setAiBusy] = useState(false)

  const ordered = useMemo(
    () => [...messages].sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq),
    [messages]
  )

  // 读取已保存的自定义样式库与上次选择的主题
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const savedThemes = await window.electronAPI.config.get('posterCustomThemes')
        const savedId = await window.electronAPI.config.get('posterThemeId')
        const legacyCss = await window.electronAPI.config.get('posterCustomCss')
        if (cancelled) return

        let themes: CustomPosterTheme[] = Array.isArray(savedThemes)
          ? (savedThemes as CustomPosterTheme[]).filter((t) => t && t.id && typeof t.css === 'string')
          : []

        // 旧版单槽位自定义样式迁移进样式库
        if (themes.length === 0 && typeof legacyCss === 'string' && legacyCss.trim()) {
          themes = [{ id: createCustomThemeId(), name: '我的定制', css: legacyCss, createdAt: Date.now() }]
          void window.electronAPI.config.set('posterCustomThemes', themes)
          void window.electronAPI.config.set('posterCustomCss', '')
        }

        setCustomThemes(themes)
        if (typeof savedId === 'string' && savedId) setThemeId(savedId)
      } catch {
        /* 使用默认主题 */
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 解析群聊发送者头像 / 昵称
  useEffect(() => {
    if (!group) {
      setSenders(new Map())
      return
    }
    const usernames = Array.from(new Set(
      ordered
        .filter((m) => m.isSend !== 1 && m.senderUsername)
        .map((m) => m.senderUsername as string)
    ))
    if (usernames.length === 0) {
      setSenders(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const map = new Map<string, SenderInfo>()
      for (const username of usernames) {
        try {
          const result = await window.electronAPI.chat.getContactAvatar(username)
          map.set(username, { name: result?.displayName || username, avatarUrl: result?.avatarUrl })
        } catch {
          map.set(username, { name: username })
        }
      }
      if (!cancelled) setSenders(map)
    })()
    return () => { cancelled = true }
  }, [ordered, group])

  const scopedThemeCss = useMemo(() => {
    const preset = POSTER_THEMES.find((t) => t.id === themeId)
    if (preset) return scopePosterCss(preset.css)
    const custom = customThemes.find((t) => t.id === themeId)
    return custom ? scopePosterCss(custom.css) : ''
  }, [themeId, customThemes])

  const resolveSender = (msg: Message): SenderInfo => {
    if (msg.isSend === 1) return { name: '我', avatarUrl: myAvatarUrl }
    if (group && msg.senderUsername) {
      return senders.get(msg.senderUsername) || { name: msg.senderUsername }
    }
    return { name: session.displayName || session.username, avatarUrl: session.avatarUrl }
  }

  const dateRange = useMemo(() => {
    if (ordered.length === 0) return ''
    const fmt = (ts: number) => {
      const d = new Date(ts * 1000)
      return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
    }
    const first = fmt(ordered[0].createTime)
    const last = fmt(ordered[ordered.length - 1].createTime)
    return first === last ? first : `${first} - ${last}`
  }, [ordered])

  const selectTheme = (id: string) => {
    setThemeId(id)
    void window.electronAPI.config.set('posterThemeId', id)
  }

  const persistCustomThemes = (list: CustomPosterTheme[]) => {
    setCustomThemes(list)
    void window.electronAPI.config.set('posterCustomThemes', list)
  }

  const deleteCustomTheme = (id: string) => {
    const list = customThemes.filter((t) => t.id !== id)
    persistCustomThemes(list)
    if (themeId === id) selectTheme('default')
  }

  const handleGenerate = async () => {
    const description = aiDesc.trim()
    if (!description || aiBusy) return
    setAiBusy(true)
    try {
      const res = await window.electronAPI.ai.generatePosterTheme({ description })
      if (res.success && res.css && scopePosterCss(res.css)) {
        const theme: CustomPosterTheme = {
          id: createCustomThemeId(),
          name: description.length > 14 ? `${description.slice(0, 14)}…` : description,
          css: res.css,
          createdAt: Date.now()
        }
        // 追加到样式库，不覆盖已有的自定义样式
        persistCustomThemes([...customThemes, theme])
        selectTheme(theme.id)
        setAiDesc('')
        showTopToast('已保存为新的自定义样式', true)
      } else if (res.success) {
        showTopToast('AI 返回的样式无效，请换个描述再试', false)
      } else {
        showTopToast(res.error || 'AI 生成失败，请检查 AI 配置', false)
      }
    } catch (e) {
      console.error('[SharePoster] AI 生成失败', e)
      showTopToast('AI 生成失败', false)
    } finally {
      setAiBusy(false)
    }
  }

  const handleSave = async () => {
    if (saving || copying) return
    const node = cardRef.current
    if (!node) return
    setSaving(true)
    try {
      await waitForImages(node)
      const domtoimage = (await import('dom-to-image-more')).default
      const dataUrl = await (domtoimage as any).toPng(node, { scale: 2 })
      const link = document.createElement('a')
      link.download = `密语聊天记录-${Date.now()}.png`
      link.href = dataUrl
      link.click()
      showTopToast('海报已保存', true)
    } catch (e) {
      console.error('[SharePoster] 生成失败', e)
      showTopToast('海报生成失败', false)
    } finally {
      setSaving(false)
    }
  }

  const handleCopy = async () => {
    if (saving || copying) return
    const node = cardRef.current
    if (!node) return
    setCopying(true)
    try {
      await waitForImages(node)
      const domtoimage = (await import('dom-to-image-more')).default
      const blob: Blob = await (domtoimage as any).toBlob(node, { scale: 2 })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      showTopToast('海报已复制到剪贴板', true)
    } catch (e) {
      console.error('[SharePoster] 复制失败', e)
      showTopToast('复制失败，请改用保存图片', false)
    } finally {
      setCopying(false)
    }
  }

  const busy = saving || copying

  return (
    <div className="poster-overlay" onMouseDown={onClose}>
      <div className="poster-dialog" onMouseDown={(e) => e.stopPropagation()}>
        {scopedThemeCss && <style>{scopedThemeCss}</style>}

        <div className="poster-dialog__toolbar">
          <span className="poster-dialog__hint">
            分享预览 · 共 {ordered.length} 条
            {ordered.length > 120 ? '（条数较多，生成可能稍慢）' : ''}
          </span>
          <div className="poster-dialog__actions">
            <button type="button" className="poster-btn" onClick={handleCopy} disabled={busy}>
              {copying ? <Loader2 size={14} className="poster-spin" /> : <Copy size={14} />}
              复制图片
            </button>
            <button type="button" className="poster-btn poster-btn--primary" onClick={handleSave} disabled={busy}>
              {saving ? <Loader2 size={14} className="poster-spin" /> : <Download size={14} />}
              保存图片
            </button>
            <button type="button" className="poster-btn poster-btn--icon" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="poster-theme-bar">
          {POSTER_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`poster-theme-chip${themeId === theme.id ? ' active' : ''}`}
              onClick={() => selectTheme(theme.id)}
            >
              {theme.name}
            </button>
          ))}
          {customThemes.map((theme) => (
            <div
              key={theme.id}
              className={`poster-theme-chip poster-theme-chip--custom${themeId === theme.id ? ' active' : ''}`}
              onClick={() => selectTheme(theme.id)}
              title={theme.name}
            >
              <span className="poster-theme-chip__name">{theme.name}</span>
              <span
                className="poster-theme-chip__del"
                role="button"
                aria-label="删除该样式"
                onClick={(e) => { e.stopPropagation(); deleteCustomTheme(theme.id) }}
              >
                <X size={11} />
              </span>
            </div>
          ))}
          <button
            type="button"
            className={`poster-theme-chip poster-theme-chip--ai${aiOpen ? ' active' : ''}`}
            onClick={() => setAiOpen((v) => !v)}
          >
            <Sparkles size={12} />
            AI 定制
          </button>
        </div>

        {aiOpen && (
          <div className="poster-ai-panel">
            <textarea
              className="poster-ai-input"
              placeholder="描述你想要的风格，例如：粉色渐变背景、圆润的大气泡、文艺手写感的标题。每次生成都会保存为一个新样式。"
              value={aiDesc}
              onChange={(e) => setAiDesc(e.target.value)}
              rows={2}
              disabled={aiBusy}
            />
            <button
              type="button"
              className="poster-btn poster-btn--primary poster-ai-gen"
              onClick={handleGenerate}
              disabled={aiBusy || !aiDesc.trim()}
            >
              {aiBusy ? <Loader2 size={14} className="poster-spin" /> : <Sparkles size={14} />}
              {aiBusy ? '生成中…' : '生成并保存'}
            </button>
          </div>
        )}

        <div className="poster-dialog__scroll">
          <div className={POSTER_THEME_SCOPE} ref={cardRef}>
            <div className="poster-card">
              <div className="poster-card__header">
                <div className="poster-card__title">{session.displayName || session.username}</div>
                {dateRange && <div className="poster-card__subtitle">{dateRange}</div>}
              </div>

              <div className="poster-card__body">
                {ordered.map((msg, index) => {
                  const prev = index > 0 ? ordered[index - 1] : undefined
                  const showDivider = shouldShowDateDivider(msg, prev)
                  const system = isSystemMessage(msg)
                  const sender = resolveSender(msg)
                  const sent = msg.isSend === 1
                  return (
                    <div key={`${msg.localId}-${msg.createTime}-${msg.sortSeq}`}>
                      {showDivider && (
                        <div className="poster-divider"><span>{formatDateDivider(msg.createTime)}</span></div>
                      )}
                      {system ? (
                        <div className="poster-system">{msg.parsedContent}</div>
                      ) : (
                        <div className={`poster-row ${sent ? 'sent' : 'received'}`}>
                          <div className="poster-avatar">
                            {sender.avatarUrl
                              ? <img src={sender.avatarUrl} alt="" referrerPolicy="no-referrer" />
                              : <span>{avatarLetter(sender.name)}</span>}
                          </div>
                          <div className="poster-msg">
                            {!sent && group && <div className="poster-name">{sender.name}</div>}
                            <div className="poster-bubble">{msg.parsedContent || ' '}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="poster-card__footer">由 密语 CipherTalk 导出</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

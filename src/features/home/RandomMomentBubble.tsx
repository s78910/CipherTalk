import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, Loader2, Mic } from 'lucide-react'
import type { Message } from '../../types/models'
import MessageContent from '../../components/MessageContent'
import { globalVoiceManager } from '../../pages/chat/components/messageBubble/mediaState'
import { MOMENT_EMOJI_TYPE, MOMENT_IMAGE_TYPE, MOMENT_TEXT_TYPE, MOMENT_VOICE_TYPE } from './randomMoment'

type Props = { sessionId: string; message: Message }

/** 回忆一刻气泡内：文本（含微信黄豆表情）或多媒体预览 */
export function RandomMomentBubble({ sessionId, message }: Props) {
  const lt = message.localType
  const [imgSrc, setImgSrc] = useState('')
  const [voiceSrc, setVoiceSrc] = useState('')
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const [emojiSrc, setEmojiSrc] = useState('')
  const [hint, setHint] = useState('')
  const voiceRef = useRef<HTMLAudioElement>(null)
  const voicePlayPendingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setImgSrc('')
    setVoiceSrc('')
    setVoiceLoading(false)
    setVoicePlaying(false)
    setVoiceError('')
    voicePlayPendingRef.current = false
    setEmojiSrc('')
    setHint('')

    if (lt === MOMENT_IMAGE_TYPE) {
      window.electronAPI.chat.getImageData(sessionId, String(message.localId), message.createTime).then((r) => {
        if (cancelled) return
        if (r.success && r.data) setImgSrc(`data:image/jpeg;base64,${r.data}`)
        else setHint(r.error || '图片暂无法显示')
      })
    } else if (lt === MOMENT_EMOJI_TYPE) {
      const cdn = message.emojiCdnUrl?.trim()
      if (cdn) {
        setEmojiSrc(cdn)
      } else if (message.emojiMd5 || message.productId) {
        window.electronAPI.chat
          .downloadEmoji(
            message.emojiCdnUrl || '',
            message.emojiMd5,
            message.productId,
            message.createTime,
            message.emojiEncryptUrl,
            message.emojiAesKey
          )
          .then((r) => {
            if (cancelled) return
            if (r.success && r.localPath) {
              const p = r.localPath.startsWith('file:') ? r.localPath : `file:///${r.localPath.replace(/\\/g, '/')}`
              setEmojiSrc(p)
            } else setHint('表情暂无法显示')
          })
      } else {
        setHint('[表情]')
      }
    }

    return () => {
      cancelled = true
      if (voiceRef.current) {
        voiceRef.current.pause()
        globalVoiceManager.stop(voiceRef.current)
      }
    }
  }, [
    sessionId,
    message.localId,
    message.localType,
    message.createTime,
    lt,
    message.emojiCdnUrl,
    message.emojiMd5,
    message.productId,
    message.emojiEncryptUrl,
    message.emojiAesKey
  ])

  const handleVoiceEnded = useCallback(() => {
    setVoicePlaying(false)
    if (voiceRef.current) globalVoiceManager.stop(voiceRef.current)
  }, [])

  const playLoadedVoice = useCallback(() => {
    const audio = voiceRef.current
    if (!audio) return false

    audio.currentTime = 0
    globalVoiceManager.play(audio, () => {
      voiceRef.current?.pause()
      setVoicePlaying(false)
    })
    audio.play()
      .then(() => setVoicePlaying(true))
      .catch(() => {
        setVoicePlaying(false)
        setVoiceError('播放失败')
        globalVoiceManager.stop(audio)
      })
    return true
  }, [])

  useEffect(() => {
    if (!voiceSrc || !voicePlayPendingRef.current) return

    voicePlayPendingRef.current = false
    requestAnimationFrame(() => {
      if (!playLoadedVoice()) voicePlayPendingRef.current = true
    })
  }, [playLoadedVoice, voiceSrc])

  const handlePlayVoice = useCallback(async () => {
    if (voiceLoading) return

    if (voiceSrc && voiceRef.current) {
      if (voicePlaying) {
        voiceRef.current.pause()
        setVoicePlaying(false)
        globalVoiceManager.stop(voiceRef.current)
      } else {
        playLoadedVoice()
      }
      return
    }

    setVoiceLoading(true)
    setVoiceError('')
    try {
      const r = await window.electronAPI.chat.getVoiceData(sessionId, String(message.localId), message.createTime)
      if (r.success && r.data) {
        voicePlayPendingRef.current = true
        setVoiceSrc(`data:audio/wav;base64,${r.data}`)
      } else {
        setVoiceError(r.error || '加载失败')
      }
    } catch (e) {
      setVoiceError(String(e))
    } finally {
      setVoiceLoading(false)
    }
  }, [message.createTime, message.localId, playLoadedVoice, sessionId, voiceLoading, voicePlaying, voiceSrc])

  const handleVoiceKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void handlePlayVoice()
    }
  }, [handlePlayVoice])

  if (lt === MOMENT_TEXT_TYPE) {
    const text = (message.parsedContent || '').trim()
    return text ? (
      <MessageContent content={text} disableLinks className="random-message-body-inner" />
    ) : (
      <span className="random-message-body-inner random-message-body-fallback">（空文本）</span>
    )
  }

  if (lt === MOMENT_IMAGE_TYPE) {
    return (
      <div className="random-moment-media random-moment-media--image">
        {imgSrc ? (
          <img src={imgSrc} alt="" />
        ) : (
          <span className="random-moment-media-hint">{hint || '加载图片…'}</span>
        )}
      </div>
    )
  }

  if (lt === MOMENT_VOICE_TYPE) {
    const duration = message.voiceDuration || 0
    const displayDuration = duration > 0 ? `${Math.round(duration)}"` : ''
    const width = Math.min(200, Math.max(60, 60 + duration * 10))

    const VoiceIcon = () => {
      if (voiceLoading) return <Loader2 size={18} className="spin" />
      if (voiceError) return <AlertCircle size={18} className="voice-error-icon" />
      if (voicePlaying) {
        return (
          <div className="voice-waves">
            <span />
            <span />
            <span />
          </div>
        )
      }
      return <Mic size={18} aria-hidden />
    }

    return (
      <div className="random-moment-media random-moment-media--voice">
        <div
          className={`random-moment-voice-message ${voicePlaying ? 'playing' : ''} ${voiceError ? 'error' : ''}`}
          style={{ minWidth: `${width}px` }}
          role="button"
          tabIndex={0}
          title={voiceError || '播放语音'}
          onClick={() => void handlePlayVoice()}
          onKeyDown={handleVoiceKeyDown}
        >
          <div className="voice-icon"><VoiceIcon /></div>
          <span className="voice-duration">{displayDuration}</span>
          {voiceSrc && (
            <audio
              ref={voiceRef}
              src={voiceSrc}
              preload="metadata"
              onEnded={handleVoiceEnded}
              onError={() => setVoiceError('播放失败')}
            />
          )}
        </div>
      </div>
    )
  }

  if (lt === MOMENT_EMOJI_TYPE) {
    return (
      <div className="random-moment-media random-moment-media--emoji">
        {emojiSrc ? (
          <img src={emojiSrc} alt="" referrerPolicy="no-referrer" onError={() => setHint('表情加载失败')} />
        ) : (
          <span className="random-moment-media-hint">{hint || '加载表情…'}</span>
        )}
      </div>
    )
  }

  return (
    <span className="random-message-body-inner random-message-body-fallback">
      {(message.parsedContent || '').trim() || `[类型 ${lt}]`}
    </span>
  )
}

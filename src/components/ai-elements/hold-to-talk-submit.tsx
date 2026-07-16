/**
 * 长按语音发送按钮：短按 = 正常提交（走表单 onSubmit），长按 ≥300ms = 按住说话，
 * 松开后经设置里的语音转文字(stt.transcribeBuffer)转写，结果交给 onTranscript。
 * Agent 页和克隆聊天页共用，保证两处交互一致。
 */
import { useRef, useState } from 'react'
import { CircleDashed, Microphone } from '@gravity-ui/icons'
import { cn } from '@/lib/utils'
import { startVoiceRecording, type ActiveRecorder } from '@/lib/voiceRecorder'
import { PromptInputSubmit, type PromptInputSubmitProps } from './prompt-input'

const HOLD_MS = 300

export type HoldToTalkSubmitProps = PromptInputSubmitProps & {
  /** 转写成功回调（文本非空） */
  onTranscript: (text: string) => void
  /** 转写/录音出错回调 */
  onVoiceError?: (message: string) => void
  /** true 时长按不可用（如正在生成中，短按仍是停止/提交） */
  holdDisabled?: boolean
}

export function HoldToTalkSubmit({
  onTranscript,
  onVoiceError,
  holdDisabled,
  className,
  children,
  ...props
}: HoldToTalkSubmitProps) {
  const [mode, setMode] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recorderRef = useRef<ActiveRecorder | null>(null)
  // 长按发生过：抑制松开后浏览器补发的 click，避免又触发一次表单提交
  const suppressClickRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const beginHold = () => {
    if (holdDisabled || mode !== 'idle') return
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      suppressClickRef.current = true
      void (async () => {
        try {
          recorderRef.current = await startVoiceRecording()
          setMode('recording')
        } catch (e) {
          onVoiceError?.(`无法打开麦克风：${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    }, HOLD_MS)
  }

  const endHold = (send: boolean) => {
    clearTimer()
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder) return
    if (!send) {
      recorder.cancel()
      setMode('idle')
      return
    }
    setMode('transcribing')
    void (async () => {
      try {
        const { wavBase64, durationSec } = await recorder.stop()
        if (durationSec < 0.4) return // 太短当误触
        const res = await window.electronAPI.stt.transcribeBuffer(wavBase64)
        const text = res.success ? String(res.transcript || '').trim() : ''
        if (!text) {
          onVoiceError?.(res.error || '没听清，请再说一次')
          return
        }
        onTranscript(text)
      } catch (e) {
        onVoiceError?.(e instanceof Error ? e.message : String(e))
      } finally {
        setMode('idle')
      }
    })()
  }

  return (
    <span
      className="inline-flex"
      onPointerDown={beginHold}
      onPointerUp={() => endHold(true)}
      onPointerLeave={() => { if (mode === 'recording') endHold(true); else clearTimer() }}
      onPointerCancel={() => endHold(false)}
      onClickCapture={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      title="长按说话，松开发送"
    >
      <PromptInputSubmit
        {...props}
        className={cn(className, mode === 'recording' && 'bg-danger text-white')}
        isDisabled={(props.isDisabled ?? props.disabled) || mode === 'transcribing'}
      >
        {mode === 'recording'
          ? <Microphone className="size-4 animate-pulse" />
          : mode === 'transcribing'
            ? <CircleDashed className="size-4 animate-spin" />
            : children}
      </PromptInputSubmit>
    </span>
  )
}

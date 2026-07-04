import { CircleCheck, CircleDashed, CircleExclamation, FaceRobot } from '@gravity-ui/icons'
import { useEffect, useState } from 'react'
import { Button, Label, Modal, ProgressBar } from '@heroui/react'
import type { ChatSession } from '../../../types/models'
import type { PersonaBuildProgressInfo } from '../../../types/electron'
import { SessionAvatar } from './SessionSidebar'
import { useTopToast } from '../hooks/useTopToast'

type Phase = 'confirm' | 'building' | 'done' | 'error'

/**
 * 克隆我自己浮层：在「回复建议」下拉里触发，用与克隆好友一致的 AI 管线提炼
 * "我"对该联系人的说话风格自画像（按 self: 前缀存储）。构建动画复刻 PersonaChatPage
 * 的呼吸光环 + ProgressBar 风格。
 */
export function CloneSelfModal({
  isOpen,
  onOpenChange,
  session,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  session: ChatSession
}) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [buildProgress, setBuildProgress] = useState<PersonaBuildProgressInfo | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const { showTopToast } = useTopToast()
  // 自画像存储键带 self: 前缀；主进程进度事件也用同一前缀的 sessionId 推回
  const progressSessionId = `self:${session.username}`

  // 重置：每次打开回到 confirm 态
  useEffect(() => {
    if (isOpen) {
      setPhase('confirm')
      setBuildProgress(null)
      setBuildError(null)
    }
  }, [isOpen, session.username])

  // 订阅构建进度，只收本会话的自画像事件
  useEffect(() => {
    if (!isOpen || phase !== 'building') return
    return window.electronAPI.persona.onBuildProgress((p) => {
      if (p.sessionId === progressSessionId) setBuildProgress(p)
    })
  }, [isOpen, phase, progressSessionId])

  const handleBuild = async () => {
    setPhase('building')
    setBuildError(null)
    setBuildProgress(null)
    try {
      const res = await window.electronAPI.persona.buildSelf({
        sessionId: session.username,
        displayName: session.displayName || session.username,
      })
      if (res.success) {
        setPhase('done')
        showTopToast('自画像已生成，"像我"建议会更像你')
        // 稍作停留再关闭，让用户看到完成态
        setTimeout(() => onOpenChange(false), 1200)
      } else {
        setBuildError(res.error || '克隆失败')
        setPhase('error')
      }
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  return (
    <Modal.Backdrop
      className="clone-self-backdrop"
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open && phase !== 'building') onOpenChange(false) }}
      variant="transparent"
    >
      <Modal.Container placement="center" size="md">
        <Modal.Dialog className="clone-self-dialog">
          <Modal.CloseTrigger isDisabled={phase === 'building'} />
          <Modal.Body className="px-6 py-8">
            {phase === 'confirm' && (
              <div className="flex flex-col items-center gap-4 px-2">
                <SessionAvatar session={session} size={64} />
                <h2 className="text-lg font-semibold text-foreground">克隆我自己（对「{session.displayName || session.username}」）</h2>
                <p className="text-center text-sm text-muted">
                  根据你和 TA 的聊天记录提炼<strong>你</strong>在跟 TA 聊天时的说话风格、口头禅和真实回复样本。
                  自画像按会话隔离存储（你对每个人说话方式不同，不共享），供「像我」回复建议使用，让建议更像你的语气。
                </p>
                <div className="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground">
                  <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                  <span>
                    克隆时，部分聊天记录会发送给你配置的 AI 模型服务商用于分析与生成。
                    如使用 Ollama 等本地模型则数据不出本机。自画像仅保存在本地，可随时删除。
                  </span>
                </div>
                {buildError && (
                  <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
                    <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                    <span>{buildError}</span>
                  </div>
                )}
                <Button onPress={handleBuild}>
                  <FaceRobot className="size-4" />
                  开始克隆
                </Button>
              </div>
            )}

            {phase === 'building' && (
              <div className="flex flex-col items-center gap-4 px-4">
                {/* 呼吸光环：AI 单次调用期间百分比不动，靠动画表明没卡死（复刻 PersonaChatPage 克隆动画） */}
                <div className="relative flex size-20 items-center justify-center">
                  <span className="absolute inset-0 animate-ping rounded-full bg-accent/20 animation-duration-[2.4s]" />
                  <span className="absolute inset-1 animate-pulse rounded-full bg-accent/15" />
                  <SessionAvatar session={session} size={64} />
                </div>
                <h2 className="text-base font-semibold text-foreground">正在克隆我自己</h2>
                <ProgressBar aria-label="克隆进度" className="w-full" value={buildProgress?.percent ?? 0} maxValue={100}>
                  <Label>{buildProgress?.title || '准备中…'}</Label>
                  <ProgressBar.Output />
                  <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
                </ProgressBar>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <CircleDashed width={14} height={14} className="shrink-0 animate-spin" />
                  <span className="text-center">
                    {buildProgress?.detail || '分析聊天记录并调用 AI 提炼你的说话画像与真实回复，通常需要几分钟'}
                  </span>
                </div>
              </div>
            )}

            {phase === 'done' && (
              <div className="flex flex-col items-center gap-4 px-4">
                <div className="relative flex size-20 items-center justify-center">
                  <span className="absolute inset-1 rounded-full bg-success/15" />
                  <CircleCheck width={56} height={56} className="text-success" />
                </div>
                <h2 className="text-base font-semibold text-foreground">自画像已生成</h2>
                <p className="text-center text-sm text-muted">
                  切到「像我」回复建议风格，新生成的建议会更贴近你跟 TA 聊天的语气。
                </p>
              </div>
            )}

            {phase === 'error' && (
              <div className="flex flex-col items-center gap-4 px-2">
                <div className="relative flex size-20 items-center justify-center">
                  <span className="absolute inset-1 rounded-full bg-danger/15" />
                  <CircleExclamation width={56} height={56} className="text-danger" />
                </div>
                <h2 className="text-base font-semibold text-foreground">克隆失败</h2>
                <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
                  <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                  <span>{buildError}</span>
                </div>
                <Button variant="ghost" onPress={handleBuild}>
                  <FaceRobot className="size-4" />
                  重试
                </Button>
              </div>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

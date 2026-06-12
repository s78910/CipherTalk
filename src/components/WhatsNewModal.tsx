import { Button, Modal } from '@heroui/react'
import { Quote, Send } from 'lucide-react'

interface WhatsNewModalProps {
  onClose: () => void
  version: string
}

type VisionSection = {
  key: 'memory' | 'evidence' | 'ownership'
  text: string
}

const VISION_SECTIONS: VisionSection[] = [
  {
    key: 'memory',
    text: '有人离开后，一句语音就是遗物；一段闲聊，可能是最后一次拥抱。CipherTalk 要把这些碎片从设备里救出来。'
  },
  {
    key: 'evidence',
    text: '被恶意、羞辱、威胁消耗时，聊天记录不该躺在黑盒里。它要能被快速找到、串起来、拿得出手。'
  },
  {
    key: 'ownership',
    text: '更多时候，它只是把你的数字人生还给你。不是平台的，不是某台设备的，是你的。'
  }
]

function WhatsNewModal({ onClose }: WhatsNewModalProps) {
  const handleTelegram = () => {
    window.electronAPI?.shell?.openExternal?.('https://t.me/+p7YzmRMBm-gzNzJl')
  }

  return (
    <Modal.Backdrop
      className="bg-black/55 backdrop-blur-xl"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      variant="blur"
    >
      <Modal.Container className="px-5 py-0 sm:px-10" placement="center" scroll="inside" size="full">
        <Modal.Dialog
          aria-label="开发者手记"
          className="mx-auto flex min-h-dvh w-full max-w-225 items-center overflow-hidden border-0! bg-transparent! p-0! text-white shadow-none!"
        >
          <Modal.CloseTrigger className="right-3 top-3 bg-white/10 text-white hover:bg-white/20" />
          <Modal.Body className="flex max-h-dvh w-full items-center overflow-y-auto p-0">
            <article className="mx-auto flex max-w-180 flex-col gap-5 text-[15px] leading-8 text-white/88 drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)]">
              <p className="m-0 text-xl font-semibold leading-9 text-white sm:text-2xl sm:leading-10">
                它不是聊天记录读取器。
                <span className="bg-gradient-to-r from-white via-cyan-100 to-fuchsia-200 bg-clip-text text-transparent">
                  它更像一把开刃的钥匙
                </span>
                ，从旧手机里撬出体温、证据和人生主权。
              </p>

              <p className="m-0">
                聊天记录不是冷数据。它可能是想念、证据、关系的暗线，也是一个人活过的痕迹。
              </p>

              {VISION_SECTIONS.map((section) => (
                <p className="m-0" key={section.key}>{section.text}</p>
              ))}

              <blockquote className="m-0 flex gap-3 border-l border-white/35 py-1 pl-4 text-white">
                <Quote className="mt-1 size-4 shrink-0 text-white/80" aria-hidden="true" />
                <div>
                  <p className="m-0 font-semibold">死亡不是生命的终点，遗忘才是。</p>
                  <cite className="mt-1 block text-sm not-italic text-white/65">《寻梦环游记》</cite>
                </div>
              </blockquote>

              <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="m-0 text-sm leading-6 text-white/72">想看项目动向和后续骚操作，进频道。</p>
                <Button className="shrink-0 justify-center border-white/28 bg-white/12 text-white hover:bg-white/20" onPress={handleTelegram} variant="outline">
                  <Send className="size-4" />
                  Telegram 频道
                </Button>
              </div>
            </article>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

export default WhatsNewModal

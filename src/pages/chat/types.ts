import type { ChatSession, Message } from '../../types/models'

export type QuoteStyle = 'default' | 'wechat'

export type MessageContextHandlers = {
  reTranscribe?: () => void
  editStt?: () => void
}

export type ContextMenuState = {
  x: number
  y: number
  message: Message
  session: ChatSession
  handlers?: MessageContextHandlers
}

export type BatchImageMessage = {
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

export type TopToastState = {
  text: string
  success: boolean
}

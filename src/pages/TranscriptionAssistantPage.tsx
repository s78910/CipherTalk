import { useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Chip, ScrollShadow, Spinner, TextArea, Typography } from '@heroui/react'
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCopy,
  FileAudio,
  Loader2,
  RotateCcw,
  Settings,
  Trash2,
  UploadCloud
} from 'lucide-react'
import * as configService from '../services/config'

type SttMode = 'cpu' | 'gpu' | 'online'
type TaskStatus = 'processing' | 'success' | 'failed'
type TranscriptionErrorCode = 'BAD_REQUEST' | 'STT_NOT_READY' | 'INTERNAL_ERROR'

type TranscriptionTask = {
  id: string
  fileName: string
  filePath: string
  createdAt: number
  status: TaskStatus
  transcript?: string
  error?: string
  errorCode?: TranscriptionErrorCode
  sttMode?: SttMode
}

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr']
const HISTORY_LIMIT = 20

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath || '未命名音频'
}

function getExtension(filePath: string): string {
  const fileName = getFileName(filePath)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
}

function isSupportedAudioPath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(getExtension(filePath))
}

function createTaskId(): string {
  return `stt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function formatTaskTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function getModeLabel(mode?: SttMode): string {
  if (mode === 'gpu') return 'GPU'
  if (mode === 'online') return '在线'
  if (mode === 'cpu') return 'CPU'
  return '读取中'
}

function getStatusLabel(status: TaskStatus): string {
  if (status === 'processing') return '处理中'
  if (status === 'success') return '成功'
  return '失败'
}

function getStatusColor(status: TaskStatus): 'accent' | 'success' | 'danger' {
  if (status === 'processing') return 'accent'
  if (status === 'success') return 'success'
  return 'danger'
}

function TranscriptionAssistantPage() {
  const navigate = useNavigate()
  const [history, setHistory] = useState<TranscriptionTask[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null)

  const activeTask = useMemo(() => {
    if (!activeTaskId) return history[0] || null
    return history.find(item => item.id === activeTaskId) || history[0] || null
  }, [activeTaskId, history])

  const isProcessing = history.some(item => item.status === 'processing')

  const pushTask = (task: TranscriptionTask) => {
    setHistory(prev => [task, ...prev.filter(item => item.id !== task.id)].slice(0, HISTORY_LIMIT))
    setActiveTaskId(task.id)
  }

  const pushFailedTask = (filePath: string, error: string, errorCode: TranscriptionErrorCode = 'BAD_REQUEST') => {
    pushTask({
      id: createTaskId(),
      fileName: getFileName(filePath),
      filePath,
      createdAt: Date.now(),
      status: 'failed',
      error,
      errorCode
    })
  }

  const openSttSettings = () => {
    navigate('/settings?tab=stt')
  }

  const transcribeFile = async (rawFilePath: string) => {
    const filePath = String(rawFilePath || '').trim()
    if (!filePath) {
      pushFailedTask('未选择文件', '未读取到音频文件路径')
      return
    }

    if (!isSupportedAudioPath(filePath)) {
      pushFailedTask(filePath, `不支持的音频格式: ${getExtension(filePath) || 'unknown'}`)
      return
    }

    if (isProcessing) return

    const taskId = createTaskId()
    let currentMode: SttMode | undefined
    try {
      currentMode = await configService.getSttMode()
    } catch {
      currentMode = undefined
    }

    pushTask({
      id: taskId,
      fileName: getFileName(filePath),
      filePath,
      createdAt: Date.now(),
      status: 'processing',
      sttMode: currentMode
    })

    try {
      const result = await window.electronAPI.stt.transcribeAudioFile(filePath)
      setHistory(prev => prev.map(item => item.id === taskId
        ? {
            ...item,
            status: result.success && result.transcript ? 'success' : 'failed',
            transcript: result.transcript,
            error: result.success ? undefined : (result.error || '转写失败'),
            errorCode: result.errorCode,
            sttMode: result.sttMode || currentMode
          }
        : item
      ))
    } catch (error) {
      setHistory(prev => prev.map(item => item.id === taskId
        ? {
            ...item,
            status: 'failed',
            error: String(error),
            errorCode: 'INTERNAL_ERROR',
            sttMode: currentMode
          }
        : item
      ))
    }
  }

  const openFileDialog = async () => {
    if (isProcessing) return
    const result = await window.electronAPI.dialog.openFile({
      title: '选择音频文件',
      filters: [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths?.[0]) return
    await transcribeFile(result.filePaths[0])
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    if (isProcessing) return

    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined
    const filePath = file?.path || ''
    if (!filePath) {
      pushFailedTask(file?.name || '拖入文件', '无法读取拖入文件的本地路径，请使用“选择音频”')
      return
    }
    await transcribeFile(filePath)
  }

  const handleDropzoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void openFileDialog()
  }

  const copyTranscript = async (task: TranscriptionTask) => {
    if (!task.transcript) return
    await navigator.clipboard.writeText(task.transcript)
    setCopiedTaskId(task.id)
    window.setTimeout(() => {
      setCopiedTaskId(current => current === task.id ? null : current)
    }, 1600)
  }

  const clearActiveTask = () => {
    if (!activeTask) return
    setHistory(prev => prev.filter(item => item.id !== activeTask.id))
    setActiveTaskId(null)
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-8 text-foreground">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <Typography.Heading level={1} className="text-2xl font-bold md:text-3xl">
            转文字助手
          </Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            选择本地音频文件，按当前语音转文字配置生成文本。
          </Typography.Paragraph>
        </div>
        <Button type="button" variant="secondary" onPress={openSttSettings}>
          <Settings size={18} />
          语音设置
        </Button>
      </header>

      <Card
        role="button"
        tabIndex={isProcessing ? -1 : 0}
        variant="default"
        aria-disabled={isProcessing}
        className={`min-h-48 cursor-pointer items-center justify-center gap-3 border border-dashed px-6 py-8 text-center transition-colors ${isDragging ? 'border-accent bg-accent/10' : ''} ${isProcessing ? 'cursor-not-allowed opacity-70' : ''}`}
        onClick={() => {
          if (!isProcessing) void openFileDialog()
        }}
        onKeyDown={handleDropzoneKeyDown}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!isProcessing) setIsDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => void handleDrop(event)}
      >
        <span className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <UploadCloud size={30} aria-hidden />
        </span>
        <span className="text-lg font-semibold">选择或拖入音频文件</span>
        <span className="text-sm font-normal text-muted-foreground">mp3 / wav / m4a / aac / flac / ogg / opus / amr</span>
        <Chip variant="soft" color={isProcessing ? 'accent' : 'default'}>
          <FileAudio size={16} />
          <Chip.Label>{isProcessing ? '转写中' : '选择音频'}</Chip.Label>
        </Chip>
      </Card>

      <Card>
        <Card.Header className="flex-row items-center justify-between gap-3">
          <Card.Title>当前任务</Card.Title>
          {activeTask && (
            <Chip size="sm" variant="soft" color={getStatusColor(activeTask.status)}>
              {activeTask.status === 'processing' && <Loader2 size={14} className="animate-spin" />}
              {activeTask.status === 'success' && <CheckCircle2 size={14} />}
              {activeTask.status === 'failed' && <AlertCircle size={14} />}
              <Chip.Label>{getStatusLabel(activeTask.status)}</Chip.Label>
            </Chip>
          )}
        </Card.Header>

        <Card.Content>
          {activeTask ? (
            <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <FileAudio size={22} className="shrink-0 text-accent" />
                <div className="min-w-0">
                  <Typography.Paragraph size="sm" weight="semibold" truncate>
                    {activeTask.fileName}
                  </Typography.Paragraph>
                  <Typography.Paragraph size="xs" color="muted" truncate>
                    {activeTask.filePath}
                  </Typography.Paragraph>
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-between gap-3 text-sm text-muted-foreground md:justify-start">
                <span>模式：{getModeLabel(activeTask.sttMode)}</span>
                <span>{formatTaskTime(activeTask.createdAt)}</span>
              </div>
            </div>
          ) : (
            <div className="flex min-h-24 items-center justify-center rounded-lg bg-default text-sm text-muted-foreground">
              暂无任务
            </div>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>转写结果</Card.Title>
        </Card.Header>

        <Card.Content>
          {activeTask?.status === 'success' ? (
            <div className="space-y-3">
              <TextArea
                aria-label="转写结果"
                className="min-h-56"
                fullWidth
                readOnly
                rows={10}
                value={activeTask.transcript || ''}
                variant="secondary"
                style={{ resize: 'vertical' }}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="primary" onPress={() => void copyTranscript(activeTask)}>
                  <ClipboardCopy size={17} />
                  {copiedTaskId === activeTask.id ? '已复制' : '复制文本'}
                </Button>
                <Button type="button" variant="secondary" onPress={clearActiveTask}>
                  <Trash2 size={17} />
                  清空结果
                </Button>
                <Button type="button" variant="secondary" onPress={() => void openFileDialog()} isDisabled={isProcessing}>
                  <RotateCcw size={17} />
                  重新选择
                </Button>
              </div>
            </div>
          ) : activeTask?.status === 'failed' ? (
            <Alert status="danger">
              <Alert.Indicator>
                <AlertCircle size={20} />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Title>{activeTask.errorCode || '转写失败'}</Alert.Title>
                <Alert.Description>{activeTask.error || '请稍后重试'}</Alert.Description>
                {activeTask.errorCode === 'STT_NOT_READY' && (
                  <Button type="button" className="mt-3" size="sm" variant="primary" onPress={openSttSettings}>
                    <Settings size={16} />
                    去语音转文字设置
                  </Button>
                )}
              </Alert.Content>
            </Alert>
          ) : activeTask?.status === 'processing' ? (
            <div className="flex min-h-24 items-center justify-center gap-2 rounded-lg bg-default text-sm font-semibold text-accent">
              <Spinner size="sm" />
              <span>正在转写音频</span>
            </div>
          ) : (
            <div className="flex min-h-24 items-center justify-center rounded-lg bg-default text-sm text-muted-foreground">
              选择音频后显示转写文本
            </div>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header className="flex-row items-center justify-between gap-3">
          <Card.Title>最近任务</Card.Title>
          <Typography.Paragraph size="xs" color="muted">
            {history.length}/{HISTORY_LIMIT}
          </Typography.Paragraph>
        </Card.Header>

        <Card.Content>
          {history.length > 0 ? (
            <ScrollShadow className="max-h-80" size={28}>
              <div className="flex flex-col gap-2">
                {history.map(task => (
                  <Button
                    type="button"
                    key={task.id}
                    className="grid h-auto min-h-12 w-full grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 text-left max-sm:grid-cols-[1.75rem_minmax(0,1fr)_auto]"
                    variant={activeTask?.id === task.id ? 'secondary' : 'ghost'}
                    onPress={() => setActiveTaskId(task.id)}
                  >
                    <Chip size="sm" variant="soft" color={getStatusColor(task.status)} className="size-7 justify-center p-0">
                      {task.status === 'processing' ? <Loader2 size={14} className="animate-spin" /> : null}
                      {task.status === 'success' ? <CheckCircle2 size={14} /> : null}
                      {task.status === 'failed' ? <AlertCircle size={14} /> : null}
                    </Chip>
                    <span className="min-w-0 truncate text-sm font-semibold">{task.fileName}</span>
                    <span className="text-xs text-muted-foreground max-sm:hidden">{getModeLabel(task.sttMode)}</span>
                    <span className="text-xs text-muted-foreground">{formatTaskTime(task.createdAt)}</span>
                  </Button>
                ))}
              </div>
            </ScrollShadow>
          ) : (
            <div className="flex min-h-24 items-center justify-center rounded-lg bg-default text-sm text-muted-foreground">
              暂无最近任务
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}

export default TranscriptionAssistantPage

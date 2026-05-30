import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Card, Chip, CloseButton, ComboBox, Description, Drawer, Input, Label, ListBox, Modal, Select as HeroSelect, useOverlayState, type Key } from '@heroui/react'
import { ArrowUpRight, Brain, Braces, Coins, Eye, EyeOff, FileText, Gauge, HelpCircle, Image as ImageIcon, Plus, RefreshCw, Settings2, Sparkles, Wrench } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getAIProviders, type AIModelInfo, type AIProviderInfo } from '../../types/ai'
import * as configService from '../../services/config'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../settings/settingsStore'
import AIProviderLogo from './AIProviderLogo'
import './AISummarySettings.scss'
import './markdown-content.scss'

type AiProviderProtocol = configService.AiProviderProtocol

interface AISummarySettingsProps {
  showMessage: (text: string, success: boolean) => void
}

interface PresetDraft {
  provider: string
  apiKey: string
  model: string
  baseURL: string
  protocol: AiProviderProtocol
}

interface SelectOption {
  value: string
  label: ReactNode
  description?: ReactNode
  content?: ReactNode
  disabled?: boolean
}

const DEEPSEEK_LEGACY_MODEL_MAP: Record<string, string> = {
  'DeepSeek V3': 'deepseek-v4-flash',
  'DeepSeek R1 (推理)': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash'
}

const LEGACY_CUSTOM_PROVIDER_MAP: Record<string, string> = {
  'openai-compatible': 'custom',
  'custom-responses': 'custom'
}

const CUSTOM_PROTOCOL_OPTIONS: Array<{ value: AiProviderProtocol; label: string }> = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' }
]

const PROTOCOL_LABELS: Record<AiProviderProtocol, string> = {
  'openai-responses': 'OpenAI Responses',
  'openai-compatible': 'OpenAI Compatible',
  anthropic: 'Anthropic',
  google: 'Google Gemini'
}

const inputCls = 'ai-hero-input text-foreground placeholder:text-muted-foreground'
const primaryBtnCls = 'ai-hero-button'
const ghostBtnCls = 'ai-hero-button'
const iconBtnCls = 'ai-hero-icon-button'
const cardCls = 'ai-hero-card'
const modalDialogCls = 'ai-hero-modal'

function normalizeProviderId(providerId: string) {
  return LEGACY_CUSTOM_PROVIDER_MAP[providerId] || providerId
}

function normalizeProviderModel(providerId: string, modelName: string) {
  return providerId === 'deepseek'
    ? DEEPSEEK_LEGACY_MODEL_MAP[modelName] || modelName
    : modelName
}

function normalizeProviderBaseURL(providerId: string, baseURL: string) {
  if (providerId === 'ollama') {
    return (baseURL || 'http://localhost:11434/v1').trim().replace(/\/+$/, '')
  }
  return baseURL.trim().replace(/\/+$/, '')
}

function canFetchProviderModelList(providerId: string, baseURL: string, providerInfo?: AIProviderInfo) {
  if (!providerId) return false
  if (providerInfo?.allowCustomBaseURL && !baseURL.trim()) return false
  return true
}

function formatTokenLimit(value?: number) {
  if (!value) return ''
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value)
}

function formatModelCost(modelDetail?: AIModelInfo) {
  if (modelDetail?.cost?.input === undefined || modelDetail.cost.output === undefined) return ''
  return `$${modelDetail.cost.input}/$${modelDetail.cost.output}`
}

function maskSecret(value: string) {
  const text = value.trim()
  if (!text) return '未填写'
  if (text.length <= 8) return `${text.slice(0, 2)}***`
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

function formatProtocolLabel(protocol?: AiProviderProtocol) {
  return protocol ? PROTOCOL_LABELS[protocol] || protocol : '未选择'
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="block text-sm font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function HeroSelectField({
  value,
  onChange,
  options,
  placeholder,
  className
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder: string
  className?: string
}) {
  const selectedOption = options.find(option => option.value === value)

  return (
    <HeroSelect
      selectedKey={value || null}
      onSelectionChange={(key: Key | null) => {
        if (key != null) onChange(String(key))
      }}
      placeholder={placeholder}
      variant="secondary"
      fullWidth
      className={cn('ai-hero-select', className)}
      disabledKeys={options.filter(option => option.disabled).map(option => option.value)}
    >
      <HeroSelect.Trigger>
        <HeroSelect.Value>
          {({ defaultChildren, isPlaceholder }) => (
            isPlaceholder
              ? defaultChildren
              : (selectedOption?.content ?? selectedOption?.label ?? defaultChildren)
          )}
        </HeroSelect.Value>
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover className="ai-hero-popover">
        <ListBox>
          {options.map(option => (
            <ListBox.Item
              key={option.value}
              id={option.value}
              textValue={String(option.label)}
              isDisabled={option.disabled}
            >
              {option.content ?? (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-foreground">{option.label}</span>
                  {option.description && (
                    <Description className="truncate text-xs text-muted-foreground">{option.description}</Description>
                  )}
                </span>
              )}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  )
}

function HeroModelComboBox({
  value,
  onChange,
  options,
  placeholder,
  adornment,
  className
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder: string
  adornment?: ReactNode
  className?: string
}) {
  const selectedKey = options.some(option => option.value === value) ? value : null

  return (
    <ComboBox
      allowsCustomValue
      selectedKey={selectedKey}
      inputValue={value}
      onInputChange={onChange}
      onSelectionChange={(key: Key | null) => {
        if (key != null) onChange(String(key))
      }}
      menuTrigger="focus"
      variant="secondary"
      fullWidth
      className={cn('ai-hero-combobox', className)}
      disabledKeys={options.filter(option => option.disabled).map(option => option.value)}
    >
      <ComboBox.InputGroup>
        <Input placeholder={placeholder} variant="secondary" />
        {adornment && <span className="ai-hero-combobox-adornment">{adornment}</span>}
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="ai-hero-popover">
        <ListBox>
          {options.map(option => (
            <ListBox.Item
              key={option.value}
              id={option.value}
              textValue={String(option.label)}
              isDisabled={option.disabled}
            >
              {option.content ?? option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  )
}

const CAPABILITY_ICON_TONE: Record<string, string> = {
  reasoning: 'bg-violet-500/15 text-violet-500',
  tool: 'bg-sky-500/15 text-sky-500',
  structured: 'bg-emerald-500/15 text-emerald-500',
  image: 'bg-amber-500/15 text-amber-500',
  pdf: 'bg-rose-500/15 text-rose-500'
}

function ModelCapabilityStrip({ modelDetail, compact = false }: { modelDetail?: AIModelInfo; compact?: boolean }) {
  if (!modelDetail) return null

  const context = formatTokenLimit(modelDetail.limits.context)
  const output = formatTokenLimit(modelDetail.limits.output)
  const price = formatModelCost(modelDetail)
  const capabilities = [
    { key: 'reasoning', label: '推理', enabled: modelDetail.capabilities.reasoning, icon: Brain },
    { key: 'tool', label: '工具调用', enabled: modelDetail.capabilities.toolCall, icon: Wrench },
    { key: 'structured', label: '结构化输出', enabled: modelDetail.capabilities.structuredOutput, icon: Braces },
    { key: 'image', label: '图像输入', enabled: modelDetail.modalities.input.includes('image'), icon: ImageIcon },
    { key: 'pdf', label: 'PDF', enabled: modelDetail.modalities.input.includes('pdf'), icon: FileText }
  ]

  const metricCls = (active: boolean) => cn(
    'inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground',
    !active && 'opacity-50'
  )

  return (
    <span className={cn('flex flex-wrap items-center', compact ? 'gap-1' : 'gap-1.5')}>
      <span className={metricCls(!!context)} title={context ? `上下文 ${context}` : '上下文未知'}>
        <Gauge size={13} />
        <span>{context || '--'}</span>
      </span>
      <span className={metricCls(!!output)} title={output ? `最大输出 ${output}` : '最大输出未知'}>
        <ArrowUpRight size={13} />
        <span>{output || '--'}</span>
      </span>
      {capabilities.map(item => {
        const Icon = item.icon
        return (
          <span
            key={item.key}
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded-md',
              item.enabled ? CAPABILITY_ICON_TONE[item.key] : 'bg-muted text-muted-foreground/40'
            )}
            title={`${item.label}: ${item.enabled ? '支持' : '不支持'}`}
          >
            <Icon size={13} />
          </span>
        )
      })}
      <span
        className={metricCls(!!price)}
        title={price ? `${modelDetail.cost?.input}/1M input, ${modelDetail.cost?.output}/1M output` : '价格未知'}
      >
        <Coins size={13} />
        <span>{price || '--'}</span>
      </span>
    </span>
  )
}

function ModelOptionContent({ modelId, modelDetail }: { modelId: string; modelDetail?: AIModelInfo }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="text-sm text-foreground">{modelDetail?.name || modelId}</span>
      <ModelCapabilityStrip modelDetail={modelDetail} compact />
    </span>
  )
}

function ProviderOptionContent({ providerInfo }: { providerInfo: AIProviderInfo }) {
  return (
    <span className="flex items-center gap-2.5">
      <AIProviderLogo providerId={providerInfo.id} logo={providerInfo.logo} alt={providerInfo.displayName} className="shrink-0" size={18} />
      <span className="flex min-w-0 flex-col">
        <strong className="truncate text-sm font-medium text-foreground">{providerInfo.displayName}</strong>
        <small className="truncate text-xs text-muted-foreground">{providerInfo.description}</small>
      </span>
    </span>
  )
}

function GuideModal({ title, html, onClose }: { title: string; html: string; onClose: () => void }) {
  const modalState = useOverlayState({
    defaultOpen: true,
    onOpenChange: (open) => {
      if (!open) onClose()
    }
  })

  return (
    <Modal state={modalState}>
      <Modal.Backdrop variant="blur">
        <Modal.Container size="lg" scroll="inside" placement="center">
          <Modal.Dialog className={modalDialogCls}>
            <Modal.Header className="items-center justify-between">
              <Modal.Heading className="text-base font-semibold text-foreground">{title}</Modal.Heading>
              <CloseButton aria-label="关闭指南" onPress={onClose} />
            </Modal.Header>
            <Modal.Body
              className="markdown-content"
              dangerouslySetInnerHTML={{ __html: html || '<p>加载中...</p>' }}
            />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function AISummarySettings({ showMessage }: AISummarySettingsProps) {
  const provider = useSettingsStore(s => s.config.aiProvider)
  const apiKey = useSettingsStore(s => s.config.aiApiKey)
  const model = useSettingsStore(s => s.config.aiModel)
  const setField = useSettingsStore(s => s.setField)

  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [providerConfigs, setProviderConfigs] = useState<Record<string, configService.AiProviderConfig>>({})
  const [baseURL, setBaseURL] = useState('')
  const [customProtocol, setCustomProtocol] = useState<AiProviderProtocol>('openai-responses')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [remoteModels, setRemoteModels] = useState<string[]>([])
  const [remoteModelDetails, setRemoteModelDetails] = useState<AIModelInfo[]>([])
  const [modelListError, setModelListError] = useState('')
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [showPresetDrawer, setShowPresetDrawer] = useState(false)
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetStep, setPresetStep] = useState(1)
  const [presetDraft, setPresetDraft] = useState<PresetDraft>({
    provider: '',
    apiKey: '',
    model: '',
    baseURL: '',
    protocol: 'openai-responses'
  })
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [showOllamaHelp, setShowOllamaHelp] = useState(false)
  const [showCustomHelp, setShowCustomHelp] = useState(false)
  const [ollamaGuideContent, setOllamaGuideContent] = useState('')
  const [customGuideContent, setCustomGuideContent] = useState('')
  const savePresetModalState = useOverlayState({
    isOpen: showSavePresetDialog,
    onOpenChange: setShowSavePresetDialog
  })
  const presetDrawerState = useOverlayState({
    isOpen: showPresetDrawer,
    onOpenChange: setShowPresetDrawer
  })

  const currentProvider = providers.find(p => p.id === provider)
  const currentProtocol: AiProviderProtocol = provider === 'custom'
    ? customProtocol
    : (currentProvider?.protocol || 'openai-responses')
  const modelDetails = remoteModelDetails.length > 0 ? remoteModelDetails : (currentProvider?.modelDetails || [])
  const modelDetailById = useMemo(() => new Map(modelDetails.map(item => [item.id, item])), [modelDetails])
  const currentModelDetail = modelDetailById.get(model)
  const modelOptions = useMemo(() => {
    const models = remoteModels.length > 0 ? remoteModels : (currentProvider?.models || [])
    return models.map(item => ({
      value: item,
      label: item,
      content: <ModelOptionContent modelId={item} modelDetail={modelDetailById.get(item)} />
    }))
  }, [currentProvider?.models, modelDetailById, remoteModels])
  const providerOptions = useMemo(() => providers.map(item => ({
    value: item.id,
    label: item.displayName,
    content: <ProviderOptionContent providerInfo={item} />
  })), [providers])
  const presetDraftProvider = providers.find(p => p.id === presetDraft.provider)
  const presetDraftModelDetailById = useMemo(() => {
    return new Map((presetDraftProvider?.modelDetails || []).map(item => [item.id, item]))
  }, [presetDraftProvider?.modelDetails])
  const presetDraftModelOptions = useMemo(() => {
    return (presetDraftProvider?.models || []).map(item => ({
      value: item,
      label: item,
      content: <ModelOptionContent modelId={item} modelDetail={presetDraftModelDetailById.get(item)} />
    }))
  }, [presetDraftModelDetailById, presetDraftProvider?.models])
  const presetDraftCurrentModelDetail = presetDraftModelDetailById.get(presetDraft.model)
  const currentBaseURLLabel = currentProvider?.allowCustomBaseURL
    ? (baseURL || '未填写')
    : (currentProvider?.baseURL || '固定服务地址')

  useEffect(() => {
    void loadProviders()
    void loadAllProviderConfigs()
    void loadPresets()
  }, [])

  useEffect(() => {
    if (!provider) return
    const config = providerConfigs[provider]
    if (provider === 'custom') {
      setCustomProtocol(config?.protocol || 'openai-responses')
    }
    if (currentProvider?.allowCustomBaseURL) {
      setBaseURL(config?.baseURL || (provider === 'ollama' ? 'http://localhost:11434/v1' : ''))
    } else {
      setBaseURL('')
    }

    if (config) {
      setField('aiApiKey', config.apiKey || '')
      setField('aiModel', normalizeProviderModel(provider, config.model || ''))
    } else if (currentProvider?.models?.length && !model) {
      setField('aiModel', normalizeProviderModel(provider, currentProvider.models[0]))
    }
    setRemoteModels([])
    setRemoteModelDetails([])
    setModelListError('')
  }, [provider, providerConfigs, currentProvider?.models])

  useEffect(() => {
    const normalized = normalizeProviderModel(provider, model)
    if (normalized !== model) {
      setField('aiModel', normalized)
    }
  }, [provider, model, setField])

  useEffect(() => {
    if (provider !== 'custom') return
    setRemoteModels([])
    setRemoteModelDetails([])
    setModelListError('')
  }, [provider, customProtocol])

  const loadProviders = async () => {
    const list = await getAIProviders()
    setProviders(list)
    const normalizedProvider = normalizeProviderId(provider)
    if (provider && normalizedProvider !== provider) {
      setField('aiProvider', normalizedProvider)
      await configService.setAiProvider(normalizedProvider)
    } else if (!provider && list[0]?.id) {
      setField('aiProvider', list[0].id)
    }
  }

  const loadAllProviderConfigs = async () => {
    const configs = await configService.getAllAiProviderConfigs()
    if (!configs.custom) {
      const legacyConfig = configs['custom-responses'] || configs['openai-compatible']
      if (legacyConfig) {
        configs.custom = {
          ...legacyConfig,
          protocol: configs['custom-responses'] ? 'openai-responses' : (legacyConfig.protocol || 'openai-compatible')
        }
        await configService.setAiProviderConfig('custom', configs.custom)
      }
    }
    setProviderConfigs(configs || {})
  }

  const loadPresets = async () => {
    setPresets(await configService.getAiConfigPresets())
  }

  const createPresetDraftFromProvider = (providerId: string): PresetDraft => {
    const nextProvider = normalizeProviderId(providerId || providers[0]?.id || '')
    const providerInfo = providers.find(item => item.id === nextProvider)
    const config = providerConfigs[nextProvider]
    const isCurrentProvider = nextProvider === provider

    return {
      provider: nextProvider,
      apiKey: config?.apiKey || (isCurrentProvider ? apiKey : ''),
      model: normalizeProviderModel(nextProvider, config?.model || (isCurrentProvider ? model : providerInfo?.models?.[0] || '')),
      baseURL: config?.baseURL || (isCurrentProvider ? baseURL : (nextProvider === 'ollama' ? 'http://localhost:11434/v1' : '')),
      protocol: config?.protocol || (isCurrentProvider && nextProvider === 'custom' ? customProtocol : 'openai-responses')
    }
  }

  const updatePresetDraft = (patch: Partial<PresetDraft>) => {
    setPresetDraft(prev => ({ ...prev, ...patch }))
  }

  const handlePresetNextStep = () => {
    if (presetStep === 1 && !presetName.trim()) {
      showMessage('请输入配置名称', false)
      return
    }
    if (presetStep === 2 && !presetDraft.provider) {
      showMessage('请选择服务商', false)
      return
    }
    setPresetStep(step => Math.min(3, step + 1))
  }

  const persistProviderConfig = async (
    nextProvider = provider,
    nextApiKey = apiKey,
    nextModel = model,
    nextBaseURL = baseURL,
    nextProtocol = customProtocol
  ) => {
    const payload = {
      apiKey: nextApiKey,
      model: normalizeProviderModel(nextProvider, nextModel),
      baseURL: providers.find(item => item.id === nextProvider)?.allowCustomBaseURL
        ? normalizeProviderBaseURL(nextProvider, nextBaseURL)
        : undefined,
      protocol: nextProvider === 'custom' ? nextProtocol : undefined
    }
    await configService.setAiProvider(nextProvider)
    await configService.setAiProviderConfig(nextProvider, payload)
    setProviderConfigs(prev => ({ ...prev, [nextProvider]: payload }))
  }

  const handleSelectProvider = async (providerId: string) => {
    const normalizedProviderId = normalizeProviderId(providerId)
    await persistProviderConfig()
    setField('aiProvider', normalizedProviderId)
    await configService.setAiProvider(normalizedProviderId)
  }

  const handleRefreshModels = async () => {
    if (!canFetchProviderModelList(provider, baseURL, currentProvider)) {
      showMessage('请先填写当前服务商所需的 API 配置', false)
      return
    }
    setIsLoadingModels(true)
    setModelListError('')
    try {
      const result = await window.electronAPI.ai.listModels({
        provider,
        apiKey,
        baseURL,
        protocol: provider === 'custom' ? customProtocol : undefined
      })
      if (!result.success || !result.models?.length) {
        const error = result.error || '模型列表为空'
        setModelListError(error)
        showMessage(error, false)
        return
      }
      setRemoteModels(result.models)
      setRemoteModelDetails(result.modelDetails || [])
      if (!result.models.includes(model)) {
        setField('aiModel', result.models[0])
      }
      showMessage('模型列表已刷新', true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setModelListError(message)
      showMessage(`刷新模型失败: ${message}`, false)
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleTestConnection = async () => {
    if (provider !== 'ollama' && !apiKey.trim()) {
      showMessage('请先填写 API 密钥', false)
      return
    }
    if (currentProvider?.allowCustomBaseURL && !baseURL.trim()) {
      showMessage('自定义服务需要填写服务地址', false)
      return
    }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.ai.testConnection(provider, apiKey, baseURL, provider === 'custom' ? customProtocol : undefined)
      showMessage(result.success ? '连接测试成功' : (result.error || '连接测试失败'), result.success)
      if (result.success) {
        await persistProviderConfig()
      }
    } finally {
      setIsTesting(false)
    }
  }

  const loadGuide = async (guideName: string) => {
    const result = await window.electronAPI.ai.readGuide(guideName)
    if (!result.success || !result.content) {
      showMessage(result.error || '指南加载失败', false)
      return ''
    }
    const html = await marked.parse(result.content)
    return DOMPurify.sanitize(html)
  }

  const openOllamaGuide = async () => {
    setShowOllamaHelp(true)
    if (!ollamaGuideContent) {
      setOllamaGuideContent(await loadGuide('Ollama使用指南.md'))
    }
  }

  const openCustomGuide = async () => {
    setShowCustomHelp(true)
    if (!customGuideContent) {
      setCustomGuideContent(await loadGuide('自定义AI服务使用指南.md'))
    }
  }

  const handleSavePreset = async () => {
    const name = presetName.trim()
    if (!name) {
      showMessage('请输入配置名称', false)
      return
    }
    if (!presetDraft.provider) {
      showMessage('请选择服务商', false)
      return
    }

    const draftProviderInfo = providers.find(item => item.id === presetDraft.provider)
    const payload = {
      name,
      provider: presetDraft.provider,
      apiKey: presetDraft.apiKey,
      model: normalizeProviderModel(presetDraft.provider, presetDraft.model),
      baseURL: draftProviderInfo?.allowCustomBaseURL ? (presetDraft.baseURL || undefined) : undefined,
      protocol: presetDraft.provider === 'custom' ? presetDraft.protocol : undefined
    }
    if (editingPresetId) {
      await configService.updateAiConfigPreset(editingPresetId, payload)
      showMessage('配置预设已更新', true)
    } else {
      await configService.saveAiConfigPreset(payload)
      showMessage('配置预设已保存', true)
    }
    setShowSavePresetDialog(false)
    setEditingPresetId(null)
    setPresetName('')
    await loadPresets()
  }

  const openPresetDialogFromCurrent = () => {
    setEditingPresetId(null)
    setPresetName(currentProvider?.displayName || provider)
    setPresetStep(1)
    setPresetDraft({
      provider: normalizeProviderId(provider || providers[0]?.id || ''),
      apiKey,
      model,
      baseURL,
      protocol: provider === 'custom' ? customProtocol : 'openai-responses'
    })
    setShowSavePresetDialog(true)
  }

  const handleLoadPreset = async (presetId: string) => {
    const preset = await configService.loadAiConfigPreset(presetId)
    if (!preset) {
      showMessage('配置预设不存在', false)
      return
    }
    const presetProvider = normalizeProviderId(preset.provider)
    setField('aiProvider', presetProvider)
    setField('aiApiKey', preset.apiKey)
    setField('aiModel', normalizeProviderModel(presetProvider, preset.model))
    setCustomProtocol(preset.protocol || 'openai-responses')
    setBaseURL(preset.baseURL || '')
    await persistProviderConfig(presetProvider, preset.apiKey, preset.model, preset.baseURL || '', preset.protocol || 'openai-responses')
    showMessage('配置预设已加载', true)
  }

  const handleEditPreset = (preset: configService.AiConfigPreset) => {
    setEditingPresetId(preset.id)
    setPresetName(preset.name)
    setPresetStep(1)
    const presetProvider = normalizeProviderId(preset.provider)
    setPresetDraft({
      provider: presetProvider,
      apiKey: preset.apiKey,
      model: normalizeProviderModel(presetProvider, preset.model),
      baseURL: preset.baseURL || '',
      protocol: preset.protocol || 'openai-responses'
    })
    setShowSavePresetDialog(true)
  }

  const handleDeletePreset = async (presetId: string) => {
    await configService.deleteAiConfigPreset(presetId)
    await loadPresets()
    showMessage('配置预设已删除', true)
  }

  const canFetchModels = canFetchProviderModelList(provider, baseURL, currentProvider)

  return (
    <div className="tab-content ai-summary-settings">
      <div className="mx-auto w-full max-w-[1160px] space-y-6 px-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">AI 接入配置</h2>
            <p className="mt-1 text-sm text-muted-foreground">管理第三方 AI 服务商、模型、API 密钥和代理连接。</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="primary" size="sm" className={primaryBtnCls} onPress={openPresetDialogFromCurrent}>
              <Plus size={16} /> 添加预设
            </Button>
            <Button type="button" variant="outline" size="sm" className={ghostBtnCls} onPress={() => setShowPresetDrawer(true)}>
              <Settings2 size={16} /> 预设管理
            </Button>
          </div>
        </div>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
          <Card className={cn(cardCls, 'space-y-5 p-5')}>
            <Card.Header className="flex items-start justify-between gap-4 border-b border-border px-0 pb-4 pt-0">
              <div>
                <Card.Title className="text-base font-semibold text-foreground">接入参数</Card.Title>
                <Card.Description className="mt-1 text-xs text-muted-foreground">选择服务商后填写密钥与模型。</Card.Description>
              </div>
              <AIProviderLogo providerId={provider} logo={currentProvider?.logo} alt={currentProvider?.displayName || provider} className="shrink-0" size={28} />
            </Card.Header>

            <Field label="服务商">
              <HeroSelectField
                value={provider}
                onChange={(value) => void handleSelectProvider(String(value))}
                options={providerOptions}
                placeholder="请选择服务商"
              />
              <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                <AIProviderLogo providerId={provider} logo={currentProvider?.logo} alt={currentProvider?.displayName || provider} className="shrink-0" size={16} />
                <span className="truncate">{currentProvider?.description || 'OpenAI 兼容接口'}</span>
              </div>
            </Field>

            <div className="grid gap-4 lg:grid-cols-2">
              {currentProvider?.allowCustomBaseURL && (
                <Field label="服务地址">
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={baseURL}
                      onChange={(event) => setBaseURL(event.target.value)}
                      placeholder={provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'}
                      fullWidth
                      variant="secondary"
                      className={cn(inputCls, 'min-w-0 flex-1')}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      isIconOnly
                      className={iconBtnCls}
                      onPress={provider === 'ollama' ? openOllamaGuide : openCustomGuide}
                      aria-label="查看接入指南"
                    >
                      <HelpCircle size={18} />
                    </Button>
                  </div>
                </Field>
              )}

              {!!currentProvider?.protocolOptions?.length && (
                <Field label="协议">
                  <HeroSelectField
                    value={customProtocol}
                    onChange={(value) => setCustomProtocol(value as AiProviderProtocol)}
                    options={CUSTOM_PROTOCOL_OPTIONS.filter(item => currentProvider.protocolOptions?.includes(item.value))}
                    placeholder="请选择协议"
                  />
                </Field>
              )}
            </div>

            <Field label="API 密钥">
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setField('aiApiKey', event.target.value)}
                  placeholder={provider === 'ollama' ? '本地服务无需密钥（可选）' : '请输入 API 密钥'}
                  fullWidth
                  variant="secondary"
                  className={cn(inputCls, 'pr-11')}
                />
                <Button
                  type="button"
                  variant="tertiary"
                  size="sm"
                  isIconOnly
                  className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  onPress={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </Button>
              </div>
            </Field>

            <Field label="模型">
              <div className="flex min-w-0 items-center gap-2">
                <HeroModelComboBox
                  value={model}
                  onChange={(value) => setField('aiModel', normalizeProviderModel(provider, String(value)))}
                  options={modelOptions}
                  placeholder="请选择或输入模型名称"
                  className="min-w-0 flex-1 [--ai-hero-list-max-height:320px]"
                  adornment={currentModelDetail ? <ModelCapabilityStrip modelDetail={currentModelDetail} compact /> : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  isIconOnly
                  className={iconBtnCls}
                  onPress={handleRefreshModels}
                  isDisabled={isLoadingModels || !canFetchModels}
                  aria-label="刷新模型列表"
                >
                  <RefreshCw size={16} className={isLoadingModels ? 'animate-spin' : ''} />
                </Button>
              </div>
              <p className={cn('pt-1 text-xs', modelListError ? 'text-destructive' : 'text-muted-foreground')}>
                {modelListError || (remoteModels.length > 0 ? '远程模型列表' : '在线模型列表')}
              </p>
            </Field>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
              <Button type="button" variant="outline" size="sm" className={ghostBtnCls} onPress={handleTestConnection} isDisabled={isTesting}>
                <Sparkles size={16} className={isTesting ? 'animate-spin' : ''} />
                {isTesting ? '测试中...' : '测试连接'}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className={primaryBtnCls}
                onPress={async () => {
                  await persistProviderConfig()
                  showMessage('AI 接入配置已保存', true)
                }}
              >
                保存当前服务商
              </Button>
            </div>
          </Card>

          <aside className="space-y-4">
            <Card className={cn(cardCls, 'p-5')}>
              <div className="flex items-center gap-3">
                <AIProviderLogo providerId={provider} logo={currentProvider?.logo} alt={currentProvider?.displayName || provider} className="shrink-0" size={34} />
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-foreground">{currentProvider?.displayName || provider || '未选择'}</h3>
                  <p className="truncate text-xs text-muted-foreground">{currentProvider?.description || 'OpenAI 兼容接口'}</p>
                </div>
              </div>

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">协议</dt>
                  <dd className="min-w-0">
                    <Chip size="sm" variant="soft" color="accent" className="max-w-full">
                      <Chip.Label className="truncate">{formatProtocolLabel(currentProtocol)}</Chip.Label>
                    </Chip>
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">模型</dt>
                  <dd className="truncate font-medium text-foreground">{model || '未选择'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">密钥</dt>
                  <dd className="truncate font-medium text-foreground">{maskSecret(apiKey)}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">地址</dt>
                  <dd className="min-w-0 truncate text-right font-medium text-foreground">{currentBaseURLLabel}</dd>
                </div>
              </dl>
            </Card>

            <Card variant="secondary" className="border border-border bg-muted/40 p-4 text-xs leading-5 text-muted-foreground">
              API 密钥仅保存在本地。连接测试与模型刷新会向当前服务商发起请求。
            </Card>
          </aside>
        </div>
      </div>

      {showOllamaHelp && (
        <GuideModal title="Ollama 本地 AI 使用指南" html={ollamaGuideContent} onClose={() => setShowOllamaHelp(false)} />
      )}

      {showCustomHelp && (
        <GuideModal title="自定义 AI 服务使用指南" html={customGuideContent} onClose={() => setShowCustomHelp(false)} />
      )}

      {showSavePresetDialog && (
        <Modal state={savePresetModalState}>
          <Modal.Backdrop variant="blur">
            <Modal.Container size="lg" scroll="inside" placement="center">
              <Modal.Dialog className={cn(modalDialogCls, 'max-w-[760px]')}>
                <Modal.Header className="items-center justify-between">
                  <Modal.Heading className="text-base font-semibold text-foreground">{editingPresetId ? '编辑配置预设' : '新增配置预设'}</Modal.Heading>
                  <CloseButton aria-label="关闭预设编辑" onPress={() => setShowSavePresetDialog(false)} />
                </Modal.Header>

                <Modal.Body className="space-y-6">
                  <div className="flex items-center justify-center gap-3" aria-label="预设配置步骤">
                    {[1, 2, 3].map(step => (
                      <span
                        key={step}
                        className={cn(
                          'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition',
                          presetStep === step
                            ? 'bg-primary text-primary-foreground'
                            : presetStep > step
                              ? 'bg-primary/20 text-primary'
                              : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {step}
                      </span>
                    ))}
                  </div>

                  {presetStep === 1 && (
                    <section className="space-y-3">
                      <h3 className="text-sm font-semibold text-foreground">设置名称</h3>
                      <Input
                        type="text"
                        value={presetName}
                        onChange={(event) => setPresetName(event.target.value)}
                        className={inputCls}
                        placeholder="例如：OpenAI 主力配置"
                        autoFocus
                        fullWidth
                        variant="secondary"
                      />
                    </section>
                  )}

                  {presetStep === 2 && (
                    <section className="space-y-3">
                      <h3 className="text-sm font-semibold text-foreground">选择提供商</h3>
                      <HeroSelectField
                        value={presetDraft.provider}
                        onChange={(value) => setPresetDraft(createPresetDraftFromProvider(String(value)))}
                        options={providerOptions}
                        placeholder="请选择服务商"
                      />
                    </section>
                  )}

                  {presetStep === 3 && (
                    <section className="space-y-3">
                      <h3 className="text-sm font-semibold text-foreground">配置接入</h3>
                      <div className="grid gap-4">
                        {!!presetDraftProvider?.protocolOptions?.length && (
                          <Field label="协议">
                            <HeroSelectField
                              value={presetDraft.protocol}
                              onChange={(value) => updatePresetDraft({ protocol: value as AiProviderProtocol })}
                              options={CUSTOM_PROTOCOL_OPTIONS.filter(item => presetDraftProvider.protocolOptions?.includes(item.value))}
                              placeholder="请选择协议"
                            />
                          </Field>
                        )}

                        {presetDraftProvider?.allowCustomBaseURL && (
                          <Field label="服务地址">
                            <Input
                              type="text"
                              value={presetDraft.baseURL}
                              onChange={(event) => updatePresetDraft({ baseURL: event.target.value })}
                              placeholder={presetDraft.provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'}
                              className={inputCls}
                              fullWidth
                              variant="secondary"
                            />
                          </Field>
                        )}

                        <Field label="API 密钥">
                          <Input
                            type="password"
                            value={presetDraft.apiKey}
                            onChange={(event) => updatePresetDraft({ apiKey: event.target.value })}
                            placeholder={presetDraft.provider === 'ollama' ? '本地服务无需密钥（可选）' : '请输入 API 密钥'}
                            className={inputCls}
                            fullWidth
                            variant="secondary"
                          />
                        </Field>

                        <Field label="模型">
                          <HeroModelComboBox
                            value={presetDraft.model}
                            onChange={(value) => updatePresetDraft({ model: normalizeProviderModel(presetDraft.provider, String(value)) })}
                            options={presetDraftModelOptions}
                            placeholder="请选择或输入模型名称"
                            adornment={presetDraftCurrentModelDetail ? <ModelCapabilityStrip modelDetail={presetDraftCurrentModelDetail} compact /> : undefined}
                          />
                        </Field>
                      </div>
                    </section>
                  )}
                </Modal.Body>

                <Modal.Footer className="justify-end">
                  <Button type="button" variant="outline" size="sm" className={ghostBtnCls} onPress={() => setShowSavePresetDialog(false)}>取消</Button>
                  {presetStep > 1 && (
                    <Button type="button" variant="outline" size="sm" className={ghostBtnCls} onPress={() => setPresetStep(step => Math.max(1, step - 1))}>上一步</Button>
                  )}
                  {presetStep < 3 ? (
                    <Button type="button" variant="primary" size="sm" className={primaryBtnCls} onPress={handlePresetNextStep}>下一步</Button>
                  ) : (
                    <Button type="button" variant="primary" size="sm" className={primaryBtnCls} onPress={handleSavePreset}>保存预设</Button>
                  )}
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}

      {showPresetDrawer && (
        <Drawer state={presetDrawerState}>
          <Drawer.Backdrop variant="blur">
            <Drawer.Content placement="right" className="w-full max-w-md">
              <Drawer.Dialog className="ai-hero-drawer">
                <Drawer.Header className="items-center justify-between">
                  <Drawer.Heading className="text-base font-semibold text-foreground">配置预设管理</Drawer.Heading>
                  <CloseButton aria-label="关闭预设管理" onPress={() => setShowPresetDrawer(false)} />
                </Drawer.Header>
                <Drawer.Body className="p-5">
                  {presets.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
                      <p className="text-sm text-foreground">暂无配置预设</p>
                      <p className="text-xs text-muted-foreground">保存当前服务商配置后可快速切换。</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {presets.map(preset => (
                        <Card key={preset.id} variant="secondary" className="flex items-center justify-between gap-3 border border-border bg-background/70 px-4 py-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">{preset.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{preset.provider} · {preset.model}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onPress={() => { void handleLoadPreset(preset.id); setShowPresetDrawer(false) }}
                            >
                              加载
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onPress={() => handleEditPreset(preset)}
                            >
                              编辑
                            </Button>
                            <Button
                              type="button"
                              variant="danger-soft"
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onPress={() => void handleDeletePreset(preset.id)}
                            >
                              删除
                            </Button>
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
                </Drawer.Body>
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
        </Drawer>
      )}
    </div>
  )
}

export default AISummarySettings

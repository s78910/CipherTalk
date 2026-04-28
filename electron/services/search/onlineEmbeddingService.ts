import OpenAI from 'openai'
import { createHash } from 'crypto'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import { ConfigService } from '../config'
import { proxyService } from '../ai/proxyService'
import type {
  EmbeddingInputType,
  EmbeddingMode,
  OnlineEmbeddingConfig,
  OnlineEmbeddingConfigInput,
  OnlineEmbeddingModelInfo,
  OnlineEmbeddingProviderInfo,
  OnlineEmbeddingTestResult
} from './onlineEmbeddingTypes'
import {
  getOnlineEmbeddingModel,
  getOnlineEmbeddingProvider,
  listOnlineEmbeddingProviders,
  ONLINE_EMBEDDING_COMMON_DIMS
} from './onlineEmbeddingRegistry'

const ONLINE_EMBEDDING_CONCURRENCY = 10
const ONLINE_EMBEDDING_BATCH_SIZE = 20
const ONLINE_EMBEDDING_MIN_CHARS_ON_413 = 512
const ONLINE_EMBEDDING_413_SHRINK_RATIO = 0.5

type EmbeddingRequestError = Error & {
  status?: number
}

type EmbeddingApiResponse = {
  data?: unknown
  embedding?: unknown
  message?: unknown
  error?: unknown
}

function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm) || 1
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function sanitizeVectorModelPart(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._/@:-]+/g, '_')
    .slice(0, 120)
}

function hashShort(value: string): string {
  return createHash('sha1').update(value || '').digest('hex').slice(0, 8)
}

function nowId(): string {
  return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error) {
    const record = error as Record<string, unknown>
    const status = Number(record.status || record.statusCode || record.code || 0)
    return Number.isFinite(status) ? status : 0
  }
  return 0
}

function normalizeErrorMessage(error: unknown): string {
  const status = getErrorStatus(error)
  const message = error instanceof Error ? error.message : String(error || '在线向量请求失败')
  return status && !message.startsWith(`${status}:`) ? `${status}: ${message}` : message
}

function createEmbeddingRequestError(error: unknown, fallbackMessage?: string): EmbeddingRequestError {
  const status = getErrorStatus(error)
  const wrapped = new Error(fallbackMessage || normalizeErrorMessage(error)) as EmbeddingRequestError
  if (status) wrapped.status = status
  return wrapped
}

function getVolcengineMultimodalEmbeddingUrl(baseURL: string): string {
  const trimmed = String(baseURL || '').trim().replace(/\/+$/, '')
  if (/\/embeddings\/multimodal$/i.test(trimmed)) return trimmed
  return `${trimmed}/embeddings/multimodal`
}

function extractResponseErrorMessage(response: EmbeddingApiResponse, rawBody: string): string {
  const error = response?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    return String(record.message || record.msg || record.code || rawBody || '在线向量请求失败')
  }
  return String(response?.message || rawBody || '在线向量请求失败')
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' || typeof item === 'string')
}

function readEmbeddingVector(value: unknown): Float32Array | null {
  if (isNumberArray(value)) {
    return Float32Array.from(value.map(Number))
  }
  return null
}

function limitEmbeddingText(text: string, maxChars: number): string {
  const value = String(text || '')
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 4000
  if (value.length <= limit) return value
  const head = Math.max(1, Math.floor(limit * 0.75))
  return `${value.slice(0, head)}\n${value.slice(-(limit - head))}`
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) break
      results[index] = await worker(items[index], index)
    }
  }))

  return results
}

async function postJsonWithProxy(
  urlString: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs = 60000
): Promise<EmbeddingApiResponse> {
  const target = new URL(urlString)
  const payload = JSON.stringify(body)
  const proxyAgent = await proxyService.createProxyAgent(urlString)
  const requestImpl = target.protocol === 'http:' ? httpRequest : httpsRequest

  return new Promise((resolve, reject) => {
    const req = requestImpl({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(payload).toString()
      },
      agent: proxyAgent,
      timeout: timeoutMs
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        let parsed: EmbeddingApiResponse = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch {
          parsed = { message: raw }
        }

        const status = Number(res.statusCode || 0)
        if (status >= 400) {
          const error = new Error(extractResponseErrorMessage(parsed, raw)) as EmbeddingRequestError
          error.status = status
          reject(error)
          return
        }

        resolve(parsed)
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('CONNECTION_TIMEOUT'))
    })
    req.write(payload)
    req.end()
  })
}

export class OnlineEmbeddingService {
  listProviders(): OnlineEmbeddingProviderInfo[] {
    return listOnlineEmbeddingProviders()
  }

  getProvider(providerId?: string): OnlineEmbeddingProviderInfo {
    return getOnlineEmbeddingProvider(providerId)
  }

  getModelInfo(providerId: string, modelId: string): OnlineEmbeddingModelInfo | null {
    return getOnlineEmbeddingModel(providerId, modelId)
  }

  getEmbeddingMode(): EmbeddingMode {
    const config = new ConfigService()
    try {
      return config.get('aiEmbeddingMode' as any) === 'online' ? 'online' : 'local'
    } finally {
      config.close()
    }
  }

  setEmbeddingMode(mode: string): EmbeddingMode {
    const nextMode: EmbeddingMode = mode === 'online' ? 'online' : 'local'
    const config = new ConfigService()
    try {
      config.set('aiEmbeddingMode' as any, nextMode as any)
      return nextMode
    } finally {
      config.close()
    }
  }

  listConfigs(): OnlineEmbeddingConfig[] {
    const config = new ConfigService()
    try {
      const value = config.get('aiOnlineEmbeddingConfigs' as any) as OnlineEmbeddingConfig[] | undefined
      return Array.isArray(value) ? value.map((item) => this.normalizeStoredConfig(item)).filter(Boolean) as OnlineEmbeddingConfig[] : []
    } finally {
      config.close()
    }
  }

  getCurrentConfigId(): string {
    const config = new ConfigService()
    try {
      return String(config.get('aiCurrentOnlineEmbeddingConfigId' as any) || '')
    } finally {
      config.close()
    }
  }

  getCurrentConfig(): OnlineEmbeddingConfig | null {
    const configs = this.listConfigs()
    const currentId = this.getCurrentConfigId()
    return configs.find((config) => config.id === currentId) || configs[0] || null
  }

  setCurrentConfig(configId: string): OnlineEmbeddingConfig | null {
    const configs = this.listConfigs()
    const selected = configs.find((config) => config.id === configId) || null
    if (!selected) return null

    const config = new ConfigService()
    try {
      config.set('aiCurrentOnlineEmbeddingConfigId' as any, selected.id as any)
      return selected
    } finally {
      config.close()
    }
  }

  async saveConfig(input: OnlineEmbeddingConfigInput): Promise<OnlineEmbeddingConfig> {
    const normalized = this.normalizeInputConfig(input)
    const test = await this.testConfig(normalized)
    if (!test.success) {
      throw new Error(test.error || '在线向量配置测试失败')
    }

    const configs = this.listConfigs()
    const now = Date.now()
    const existing = normalized.id ? configs.find((item) => item.id === normalized.id) : null
    const next: OnlineEmbeddingConfig = {
      ...normalized,
      id: existing?.id || normalized.id || nowId(),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
    const merged = existing
      ? configs.map((item) => item.id === next.id ? next : item)
      : [...configs, next]

    const config = new ConfigService()
    try {
      config.set('aiOnlineEmbeddingConfigs' as any, merged as any)
      config.set('aiCurrentOnlineEmbeddingConfigId' as any, next.id as any)
      return next
    } finally {
      config.close()
    }
  }

  deleteConfig(configId: string): { deleted: boolean; currentConfigId: string; configs: OnlineEmbeddingConfig[] } {
    const configs = this.listConfigs()
    const nextConfigs = configs.filter((config) => config.id !== configId)
    const currentId = this.getCurrentConfigId()
    const nextCurrentId = currentId === configId ? (nextConfigs[0]?.id || '') : currentId

    const config = new ConfigService()
    try {
      config.set('aiOnlineEmbeddingConfigs' as any, nextConfigs as any)
      config.set('aiCurrentOnlineEmbeddingConfigId' as any, nextCurrentId as any)
      return {
        deleted: nextConfigs.length !== configs.length,
        currentConfigId: nextCurrentId,
        configs: nextConfigs
      }
    } finally {
      config.close()
    }
  }

  async testConfig(input: OnlineEmbeddingConfigInput): Promise<OnlineEmbeddingTestResult> {
    try {
      const normalized = this.normalizeInputConfig(input)
      const vectors = await this.embedTextsWithConfig(normalized, ['在线向量测试'], { inputType: 'document' })
      const dim = vectors[0]?.length || 0
      return {
        success: dim === normalized.dim,
        vectorModelId: this.getVectorModelId(normalized),
        dim,
        model: normalized.model,
        error: dim === normalized.dim ? undefined : `返回向量维度 ${dim} 与配置维度 ${normalized.dim} 不一致`
      }
    } catch (error) {
      return {
        success: false,
        error: normalizeErrorMessage(error)
      }
    }
  }

  getVectorModelId(config = this.getCurrentConfig()): string {
    if (!config) return 'online:unconfigured@0d'
    const modelPart = sanitizeVectorModelPart(config.model)
    const basePart = config.providerId === 'volcengine' ? `:${hashShort(config.baseURL)}` : ''
    return `online:${config.providerId}:${modelPart}${basePart}@${config.dim}d`
  }

  getCurrentVectorDim(): number {
    return this.getCurrentConfig()?.dim || 0
  }

  getCurrentBatchSize(): number {
    const config = this.getCurrentConfig()
    if (!config) return 1
    return Math.max(1, Math.min(ONLINE_EMBEDDING_BATCH_SIZE, this.getModelInfo(config.providerId, config.model)?.maxBatchSize || ONLINE_EMBEDDING_BATCH_SIZE))
  }

  getCurrentConcurrency(): number {
    return ONLINE_EMBEDDING_CONCURRENCY
  }

  getCurrentProfile() {
    const config = this.getCurrentConfig()
    const provider = this.getProvider(config?.providerId)
    const model = config ? this.getModelInfo(config.providerId, config.model) : null
    return {
      id: this.getVectorModelId(config),
      displayName: config ? `${provider.displayName} · ${config.model}` : '在线向量未配置',
      dim: config?.dim || 0,
      dtype: 'online',
      sizeLabel: config ? '在线服务' : '未配置',
      performanceTier: 'quality',
      performanceLabel: model?.displayName || provider.displayName,
      enabled: Boolean(config?.apiKey && config.model && config.dim > 0),
      mode: 'online' as const,
      providerName: provider.displayName
    }
  }

  ensureReady(): void {
    const config = this.getCurrentConfig()
    if (!config) {
      throw new Error('未配置在线语义向量服务')
    }
    this.validateConfigShape(config)
  }

  async embedTexts(
    texts: string[],
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array[]> {
    const config = this.getCurrentConfig()
    if (!config) throw new Error('未配置在线语义向量服务')
    return this.embedTextsWithConfig(config, texts, options)
  }

  async embedText(
    text: string,
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array> {
    const [vector] = await this.embedTexts([text], { inputType: options.inputType || 'query' })
    return vector
  }

  buildDefaultConfig(providerId?: string): OnlineEmbeddingConfigInput {
    const provider = this.getProvider(providerId)
    const model = provider.models[0]
    return {
      name: `${provider.displayName} ${model.id}`,
      providerId: provider.id,
      baseURL: provider.defaultBaseURL,
      apiKey: '',
      model: model.id,
      dim: model.defaultDim
    }
  }

  private normalizeStoredConfig(raw: Partial<OnlineEmbeddingConfig> | null | undefined): OnlineEmbeddingConfig | null {
    if (!raw) return null
    try {
      const normalized = this.normalizeInputConfig(raw as OnlineEmbeddingConfigInput)
      return {
        ...normalized,
        id: String(raw.id || nowId()),
        createdAt: Number(raw.createdAt || Date.now()),
        updatedAt: Number(raw.updatedAt || raw.createdAt || Date.now())
      }
    } catch {
      return null
    }
  }

  private normalizeInputConfig(input: OnlineEmbeddingConfigInput): OnlineEmbeddingConfig {
    const provider = this.getProvider(input.providerId)
    let modelId = String(input.model || '').trim()
    let model = this.getModelInfo(provider.id, modelId)
    if (provider.id === 'volcengine' && !model) {
      model = provider.models[0] || null
      modelId = model?.id || modelId
    }
    let dim = Math.floor(Number(input.dim) || 0)
    if (provider.id === 'volcengine' && model && !model.supportedDims.includes(dim)) {
      dim = model.defaultDim
    }
    const baseURL = String(input.baseURL || provider.defaultBaseURL || '').trim().replace(/\/+$/, '')
    const now = Date.now()
    const normalized: OnlineEmbeddingConfig = {
      id: String(input.id || ''),
      name: String(input.name || `${provider.displayName} ${modelId}`).trim(),
      providerId: provider.id,
      baseURL,
      apiKey: String(input.apiKey || '').trim(),
      model: modelId,
      dim,
      createdAt: Number(input.createdAt || now),
      updatedAt: Number(input.updatedAt || now)
    }
    this.validateConfigShape(normalized, model)
    return normalized
  }

  private validateConfigShape(config: OnlineEmbeddingConfig, model = this.getModelInfo(config.providerId, config.model)): void {
    if (!config.baseURL) throw new Error('在线向量服务地址不能为空')
    if (!config.apiKey) throw new Error('在线向量 API Key 不能为空')
    if (!config.model) throw new Error('在线向量模型不能为空')
    if (!Number.isInteger(config.dim) || config.dim <= 0) throw new Error('在线向量维度无效')

    const provider = this.getProvider(config.providerId)
    if (!model && !provider.allowCustomModel) {
      throw new Error(`模型 ${config.model} 未在 ${provider.displayName} 白名单中`)
    }
    if (model && !model.allowCustomDim && !model.supportedDims.includes(config.dim)) {
      throw new Error(`模型 ${config.model} 不支持 ${config.dim} 维`)
    }
    if (!model && !ONLINE_EMBEDDING_COMMON_DIMS.includes(config.dim)) {
      throw new Error(`自定义模型维度必须为 ${ONLINE_EMBEDDING_COMMON_DIMS.join(' / ')} 之一`)
    }
  }

  private async embedTextsWithConfig(
    config: OnlineEmbeddingConfig,
    texts: string[],
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array[]> {
    this.validateConfigShape(config)
    if (texts.length === 0) return []

    const model = this.getModelInfo(config.providerId, config.model)
    const batchSize = Math.max(1, Math.min(model?.maxBatchSize || ONLINE_EMBEDDING_BATCH_SIZE, ONLINE_EMBEDDING_BATCH_SIZE, texts.length))
    const maxChars = model?.maxTokens ? Math.max(1000, model.maxTokens * 2) : 8000
    const batches: string[][] = []

    for (let index = 0; index < texts.length; index += batchSize) {
      batches.push(texts.slice(index, index + batchSize).map((text) => String(text || '')))
    }

    const batchVectors = await mapWithConcurrency(
      batches,
      this.getCurrentConcurrency(),
      (batch) => this.requestEmbeddingsWithPayloadRecovery(config, batch, maxChars)
    )

    return batchVectors.flat()
  }

  private async requestEmbeddingsWithPayloadRecovery(
    config: OnlineEmbeddingConfig,
    texts: string[],
    maxChars: number
  ): Promise<Float32Array[]> {
    const safeMaxChars = Math.max(1, Math.floor(maxChars))
    const cleaned = texts.map((text) => limitEmbeddingText(text, safeMaxChars))

    try {
      return await this.requestEmbeddings(config, cleaned)
    } catch (error) {
      if (getErrorStatus(error) !== 413) {
        throw error
      }

      if (texts.length > 1) {
        const midpoint = Math.max(1, Math.floor(texts.length / 2))
        const left = await this.requestEmbeddingsWithPayloadRecovery(config, texts.slice(0, midpoint), safeMaxChars)
        const right = await this.requestEmbeddingsWithPayloadRecovery(config, texts.slice(midpoint), safeMaxChars)
        return [...left, ...right]
      }

      if (safeMaxChars > ONLINE_EMBEDDING_MIN_CHARS_ON_413) {
        const nextMaxChars = Math.max(
          ONLINE_EMBEDDING_MIN_CHARS_ON_413,
          Math.floor(safeMaxChars * ONLINE_EMBEDDING_413_SHRINK_RATIO)
        )
        if (nextMaxChars < safeMaxChars) {
          return this.requestEmbeddingsWithPayloadRecovery(config, texts, nextMaxChars)
        }
      }

      throw createEmbeddingRequestError(
        error,
        `在线向量服务拒绝单条输入大小，已降到 ${safeMaxChars} 字符仍失败`
      )
    }
  }

  private async requestEmbeddings(config: OnlineEmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    if (config.providerId === 'volcengine') {
      return this.requestVolcengineEmbeddings(config, texts)
    }

    const model = this.getModelInfo(config.providerId, config.model)
    const body: Record<string, unknown> = {
      model: config.model,
      input: texts,
      encoding_format: 'float'
    }
    if (model?.supportsDimensions) {
      body.dimensions = config.dim
    }

    const run = async () => {
      const proxyAgent = await proxyService.createProxyAgent(config.baseURL)
      const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: 60000,
        httpAgent: proxyAgent
      } as any)
      return client.embeddings.create(body as any)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await run()
        const data = Array.isArray(response.data) ? [...response.data] : []
        const sorted = data.sort((a: any, b: any) => Number(a.index || 0) - Number(b.index || 0))
        if (sorted.length !== texts.length) {
          throw new Error(`在线向量返回数量不匹配：${sorted.length}/${texts.length}`)
        }
        return sorted.map((item: any, index) => {
          const vector = Array.isArray(item.embedding) ? Float32Array.from(item.embedding.map(Number)) : new Float32Array()
          if (vector.length !== config.dim) {
            throw new Error(`第 ${index + 1} 条返回向量维度 ${vector.length} 与配置维度 ${config.dim} 不一致`)
          }
          return normalizeVector(vector)
        })
      } catch (error) {
        lastError = error
        const status = getErrorStatus(error)
        if (status === 401 || status === 403 || (status >= 400 && status < 500 && status !== 429)) {
          break
        }
        if (attempt < 2) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
      }
    }

    throw createEmbeddingRequestError(lastError)
  }

  private async requestVolcengineEmbeddings(config: OnlineEmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    const model = this.getModelInfo(config.providerId, config.model)
    const body: Record<string, unknown> = {
      model: config.model,
      input: texts.map((text) => ({
        type: 'text',
        text
      }))
    }
    if (model?.supportsDimensions) {
      body.dimensions = config.dim
    }

    const run = () => postJsonWithProxy(
      getVolcengineMultimodalEmbeddingUrl(config.baseURL),
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body
    )

    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await run()
        const vectors = this.extractEmbeddingVectors(response, texts.length)
        return vectors.map((vector, index) => {
          if (vector.length !== config.dim) {
            throw new Error(`第 ${index + 1} 条返回向量维度 ${vector.length} 与配置维度 ${config.dim} 不一致`)
          }
          return normalizeVector(vector)
        })
      } catch (error) {
        lastError = error
        const status = getErrorStatus(error)
        if (status === 401 || status === 403 || (status >= 400 && status < 500 && status !== 429)) {
          break
        }
        if (attempt < 2) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
      }
    }

    throw createEmbeddingRequestError(lastError)
  }

  private extractEmbeddingVectors(response: EmbeddingApiResponse, expectedCount: number): Float32Array[] {
    if (Array.isArray(response.data)) {
      const sorted = [...response.data].sort((a: any, b: any) => Number(a?.index || 0) - Number(b?.index || 0))
      if (sorted.length !== expectedCount) {
        throw new Error(`在线向量返回数量不匹配：${sorted.length}/${expectedCount}`)
      }
      return sorted.map((item: any) => {
        const vector = readEmbeddingVector(item?.embedding || item?.dense_embedding || item?.vector)
        if (!vector) throw new Error('在线向量返回格式缺少 embedding')
        return vector
      })
    }

    const data = response.data && typeof response.data === 'object'
      ? response.data as Record<string, unknown>
      : null
    const vector = readEmbeddingVector(data?.embedding)
      || readEmbeddingVector(data?.dense_embedding)
      || readEmbeddingVector(data?.vector)
      || readEmbeddingVector(response.embedding)

    const vectors = vector ? [vector] : []
    if (vectors.length !== expectedCount) {
      throw new Error(`在线向量返回数量不匹配：${vectors.length}/${expectedCount}`)
    }
    return vectors
  }
}

export const onlineEmbeddingService = new OnlineEmbeddingService()

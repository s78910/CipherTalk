import { cpus } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../../../config'
import { agentDataRepository } from './repository'

type AgentEmbeddingProfile = {
  id: string
  displayName: string
  modelId: string
  revision: string
  dim: number
  baseDim: number
  supportedDims: number[]
  maxTokens: number
  maxTextChars: number
  dtype: 'q8' | 'fp32'
  pooling: 'mean' | 'last_token'
  queryInstruction?: string
}

const CPU_THREADS = Math.max(1, Math.min(2, Math.floor((cpus().length || 2) / 2)))

const PROFILES: AgentEmbeddingProfile[] = [
  {
    id: 'qwen3-embedding-0.6b-onnx-q8',
    displayName: 'Qwen3 Embedding 0.6B',
    modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'main',
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024, 768, 512, 256],
    maxTokens: 8192,
    maxTextChars: 2400,
    dtype: 'q8',
    pooling: 'last_token',
    queryInstruction: 'Given a chat history search query, retrieve relevant conversation messages that answer the query'
  },
  {
    id: 'bge-large-zh-v1.5-int8',
    displayName: 'BGE Large 中文',
    modelId: 'Xenova/bge-large-zh-v1.5',
    revision: 'main',
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024],
    maxTokens: 512,
    maxTextChars: 480,
    dtype: 'q8',
    pooling: 'mean'
  },
  {
    id: 'bge-large-zh-v1.5-fp32',
    displayName: 'BGE Large 中文 FP32',
    modelId: 'Xenova/bge-large-zh-v1.5',
    revision: 'main',
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024],
    maxTokens: 512,
    maxTextChars: 480,
    dtype: 'fp32',
    pooling: 'mean'
  },
  {
    id: 'bge-m3',
    displayName: 'BGE-M3',
    modelId: 'Xenova/bge-m3',
    revision: 'main',
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024],
    maxTokens: 8192,
    maxTextChars: 2400,
    dtype: 'q8',
    pooling: 'mean'
  }
]

function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm) || 1
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function resizeVector(vector: Float32Array, targetDim: number): Float32Array {
  if (targetDim <= 0 || targetDim === vector.length) return vector
  if (targetDim > vector.length) throw new Error(`Embedding 输出维度不足：${vector.length}/${targetDim}`)
  return normalizeVector(Float32Array.from(vector.slice(0, targetDim)))
}

function meanPoolNormalize(output: any, attentionMask: any, expectedCount: number): Float32Array[] {
  const hidden = output?.last_hidden_state || output?.token_embeddings || output?.logits
  const data = hidden?.data
  const dims = Array.isArray(hidden?.dims) ? hidden.dims.map((item: unknown) => Number(item)) : []
  const mask = attentionMask?.data
  if (!data || dims.length !== 3 || !mask) throw new Error('Embedding 模型输出为空')
  const [batchSize, seqLength, dim] = dims
  if (batchSize !== expectedCount) throw new Error(`Embedding 输出数量不匹配：${batchSize}/${expectedCount}`)

  const vectors: Float32Array[] = []
  for (let batch = 0; batch < batchSize; batch += 1) {
    const vector = new Float32Array(dim)
    let tokenCount = 0
    for (let token = 0; token < seqLength; token += 1) {
      const weight = Number(mask[batch * seqLength + token] || 0)
      if (weight <= 0) continue
      tokenCount += weight
      const offset = (batch * seqLength + token) * dim
      for (let index = 0; index < dim; index += 1) {
        vector[index] += Number(data[offset + index] || 0) * weight
      }
    }
    const divisor = tokenCount || 1
    for (let index = 0; index < dim; index += 1) vector[index] /= divisor
    vectors.push(normalizeVector(vector))
  }
  return vectors
}

function lastTokenPoolNormalize(output: any, attentionMask: any, expectedCount: number): Float32Array[] {
  const hidden = output?.last_hidden_state || output?.token_embeddings || output?.logits
  const data = hidden?.data
  const dims = Array.isArray(hidden?.dims) ? hidden.dims.map((item: unknown) => Number(item)) : []
  const mask = attentionMask?.data
  if (!data || dims.length !== 3 || !mask) throw new Error('Embedding 模型输出为空')
  const [batchSize, seqLength, dim] = dims
  if (batchSize !== expectedCount) throw new Error(`Embedding 输出数量不匹配：${batchSize}/${expectedCount}`)

  const vectors: Float32Array[] = []
  for (let batch = 0; batch < batchSize; batch += 1) {
    let tokenIndex = seqLength - 1
    for (let index = seqLength - 1; index >= 0; index -= 1) {
      if (Number(mask[batch * seqLength + index] || 0) > 0) {
        tokenIndex = index
        break
      }
    }
    const offset = (batch * seqLength + tokenIndex) * dim
    const vector = new Float32Array(dim)
    for (let index = 0; index < dim; index += 1) vector[index] = Number(data[offset + index] || 0)
    vectors.push(normalizeVector(vector))
  }
  return vectors
}

function float32ArrayToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.max(1, Math.floor(maxChars * 0.75))
  return `${text.slice(0, head)}\n${text.slice(-(maxChars - head))}`
}

export class AgentEmbeddingRuntime {
  private pipelines = new Map<string, Promise<{ tokenizer: any; model: any }>>()

  getCurrentProfile(): AgentEmbeddingProfile {
    const config = new ConfigService()
    try {
      const id = String(config.get('aiEmbeddingModelProfile' as any) || 'bge-large-zh-v1.5-int8')
      const base = PROFILES.find((profile) => profile.id === id) || PROFILES[1]
      const dims = config.get('aiEmbeddingVectorDims' as any) as Record<string, unknown> | undefined
      const configuredDim = Number(dims?.[base.id] || base.dim)
      const dim = base.supportedDims.includes(configuredDim) ? configuredDim : base.dim
      return { ...base, dim }
    } finally {
      config.close()
    }
  }

  getVectorModelId(profile = this.getCurrentProfile()): string {
    return profile.dim === profile.baseDim ? profile.id : `${profile.id}@${profile.dim}d`
  }

  getProfileDir(profileId: string): string {
    return join(agentDataRepository.getCacheBasePath(), 'models', 'embeddings', profileId)
  }

  hasModelFiles(profile = this.getCurrentProfile()): boolean {
    const dir = this.getProfileDir(profile.id)
    if (!existsSync(dir)) return false
    return true
  }

  async embedQuery(text: string): Promise<{ embedding: Buffer; vectorModel: string; dim: number }> {
    const profile = this.getCurrentProfile()
    if (!this.hasModelFiles(profile)) {
      throw new Error(`本地语义模型未下载：${profile.displayName}`)
    }
    const input = profile.queryInstruction
      ? `Instruct: ${profile.queryInstruction}\nQuery: ${limitText(text, profile.maxTextChars)}`
      : limitText(text, profile.maxTextChars)
    const runtime = await this.getPipeline(profile)
    const modelInputs = runtime.tokenizer([input], {
      padding: true,
      truncation: true,
      max_length: profile.maxTokens
    })
    const output = await runtime.model(modelInputs)
    const vectors = profile.pooling === 'last_token'
      ? lastTokenPoolNormalize(output, modelInputs.attention_mask, 1)
      : meanPoolNormalize(output, modelInputs.attention_mask, 1)
    return {
      embedding: float32ArrayToBuffer(resizeVector(vectors[0], profile.dim)),
      vectorModel: this.getVectorModelId(profile),
      dim: profile.dim
    }
  }

  private async getPipeline(profile: AgentEmbeddingProfile): Promise<{ tokenizer: any; model: any }> {
    const key = `${profile.id}:cpu`
    const existing = this.pipelines.get(key)
    if (existing) return existing
    const promise = (async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.allowLocalModels = true
      transformers.env.allowRemoteModels = false
      transformers.env.cacheDir = this.getProfileDir(profile.id)
      const wasm = (transformers.env.backends?.onnx as any)?.wasm
      if (wasm && typeof wasm === 'object') wasm.numThreads = CPU_THREADS
      const options = {
        cache_dir: this.getProfileDir(profile.id),
        local_files_only: true,
        revision: profile.revision
      }
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(profile.modelId, options as any)
      const model = await transformers.AutoModel.from_pretrained(profile.modelId, {
        ...options,
        device: 'cpu',
        dtype: profile.dtype,
        session_options: {
          executionMode: 'sequential',
          interOpNumThreads: 1,
          intraOpNumThreads: CPU_THREADS
        }
      } as any)
      return { tokenizer, model }
    })()
    this.pipelines.set(key, promise)
    try {
      return await promise
    } catch (error) {
      this.pipelines.delete(key)
      throw error
    }
  }
}

export const agentEmbeddingRuntime = new AgentEmbeddingRuntime()

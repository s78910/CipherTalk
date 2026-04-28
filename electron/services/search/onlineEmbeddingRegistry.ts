import type {
  OnlineEmbeddingModelInfo,
  OnlineEmbeddingProviderId,
  OnlineEmbeddingProviderInfo
} from './onlineEmbeddingTypes'

export const ONLINE_EMBEDDING_COMMON_DIMS = [4096, 2560, 2048, 1536, 1024, 768, 512, 256, 128, 64]

const PROVIDERS: OnlineEmbeddingProviderInfo[] = [
  {
    id: 'aliyun',
    displayName: '阿里云百炼',
    description: 'DashScope 百炼 OpenAI 兼容文本向量服务，推荐 text-embedding-v4。',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    website: 'https://help.aliyun.com/zh/model-studio/',
    models: [
      {
        id: 'text-embedding-v4',
        displayName: 'text-embedding-v4',
        supportedDims: [2048, 1536, 1024, 768, 512, 256, 128, 64],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 8192,
        supportsDimensions: true
      },
      {
        id: 'text-embedding-v3',
        displayName: 'text-embedding-v3',
        supportedDims: [1024, 768, 512, 256, 128, 64],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 8192,
        supportsDimensions: true
      },
      {
        id: 'text-embedding-v2',
        displayName: 'text-embedding-v2',
        supportedDims: [1536],
        defaultDim: 1536,
        maxBatchSize: 20,
        maxTokens: 2048,
        supportsDimensions: false
      }
    ]
  },
  {
    id: 'siliconflow',
    displayName: '硅基流动',
    description: '硅基流动 OpenAI 兼容向量接口，适合使用 Qwen3 Embedding / BGE 系列。',
    defaultBaseURL: 'https://api.siliconflow.cn/v1',
    website: 'https://docs.siliconflow.cn/',
    models: [
      {
        id: 'Qwen/Qwen3-VL-Embedding-8B',
        displayName: 'Qwen3 VL Embedding 8B（收费）',
        supportedDims: [4096, 2560, 2048, 1536, 1024, 768, 512, 256, 128, 64],
        defaultDim: 4096,
        maxBatchSize: 20,
        maxTokens: 32768,
        supportsDimensions: true
      },
      {
        id: 'Qwen/Qwen3-Embedding-8B',
        displayName: 'Qwen3 Embedding 8B（收费）',
        supportedDims: [4096, 2560, 2048, 1536, 1024, 768, 512, 256, 128, 64],
        defaultDim: 4096,
        maxBatchSize: 20,
        maxTokens: 32768,
        supportsDimensions: true
      },
      {
        id: 'Qwen/Qwen3-Embedding-4B',
        displayName: 'Qwen3 Embedding 4B（收费）',
        supportedDims: [2560, 2048, 1536, 1024, 768, 512, 256, 128, 64],
        defaultDim: 2560,
        maxBatchSize: 20,
        maxTokens: 32768,
        supportsDimensions: true
      },
      {
        id: 'Qwen/Qwen3-Embedding-0.6B',
        displayName: 'Qwen3 Embedding 0.6B（收费）',
        supportedDims: [1024, 768, 512, 256, 128, 64],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 32768,
        supportsDimensions: true
      },
      {
        id: 'BAAI/bge-m3',
        displayName: 'BAAI bge-m3（免费）',
        supportedDims: [1024],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 8192,
        supportsDimensions: false
      },
      {
        id: 'netease-youdao/bce-embedding-base_v1',
        displayName: 'netease-youdao bce-embedding-base_v1（免费）',
        supportedDims: [768],
        defaultDim: 768,
        maxBatchSize: 20,
        maxTokens: 512,
        supportsDimensions: false
      },
      {
        id: 'BAAI/bge-large-zh-v1.5',
        displayName: 'BAAI bge-large-zh-v1.5（免费）',
        supportedDims: [1024],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 512,
        supportsDimensions: false
      },
      {
        id: 'BAAI/bge-large-en-v1.5',
        displayName: 'BAAI bge-large-en-v1.5（免费）',
        supportedDims: [1024],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 512,
        supportsDimensions: false
      },
      {
        id: 'Pro/BAAI/bge-m3',
        displayName: 'Pro BAAI bge-m3（免费）',
        supportedDims: [1024],
        defaultDim: 1024,
        maxBatchSize: 20,
        maxTokens: 8192,
        supportsDimensions: false
      }
    ]
  },
  {
    id: 'volcengine',
    displayName: '火山引擎',
    description: '火山方舟原生多模态向量接口，使用 /embeddings/multimodal。',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    website: 'https://www.volcengine.com/product/ark',
    models: [
      {
        id: 'doubao-embedding-vision-251215',
        displayName: 'doubao-embedding-vision-251215',
        supportedDims: [2048, 1024],
        defaultDim: 2048,
        maxBatchSize: 20,
        maxTokens: 131072,
        supportsDimensions: true
      }
    ]
  }
]

export function listOnlineEmbeddingProviders(): OnlineEmbeddingProviderInfo[] {
  return PROVIDERS.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model }))
  }))
}

export function getOnlineEmbeddingProvider(providerId?: string): OnlineEmbeddingProviderInfo {
  const id = safeOnlineEmbeddingProviderId(providerId)
  return listOnlineEmbeddingProviders().find((provider) => provider.id === id)!
}

export function getOnlineEmbeddingModel(providerId: string, modelId: string): OnlineEmbeddingModelInfo | null {
  const provider = getOnlineEmbeddingProvider(providerId)
  return provider.models.find((model) => model.id === modelId) || null
}

export function safeOnlineEmbeddingProviderId(value: unknown): OnlineEmbeddingProviderId {
  const id = String(value || '').trim() as OnlineEmbeddingProviderId
  return PROVIDERS.some((provider) => provider.id === id) ? id : 'aliyun'
}

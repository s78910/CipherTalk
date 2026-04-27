import { parentPort, workerData } from 'worker_threads'
import { ConfigService } from './services/config'
import { aiDatabase } from './services/ai/aiDatabase'
import { memoryBuildService } from './services/memory/memoryBuildService'

type MemoryBuildWorkerData = {
  sessionId: string
}

const data = workerData as MemoryBuildWorkerData

function initWorkerDatabases() {
  const configService = new ConfigService()
  try {
    const cachePath = configService.getCacheBasePath()
    const wxid = String(configService.get('myWxid') || '').trim()
    if (cachePath && wxid) {
      aiDatabase.init(cachePath, wxid)
    }
  } finally {
    configService.close()
  }
}

async function run() {
  try {
    initWorkerDatabases()
    const state = await memoryBuildService.prepareSessionMemory(data.sessionId, (progress) => {
      parentPort?.postMessage({
        type: 'progress',
        sessionId: data.sessionId,
        progress
      })
    })
    parentPort?.postMessage({
      type: 'completed',
      sessionId: data.sessionId,
      state
    })
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      sessionId: data.sessionId,
      error: String(error)
    })
  }
}

void run()

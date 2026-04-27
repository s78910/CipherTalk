/**
 * QA 联系人显示名映射。
 */
import { agentDataRepository } from '../data/repository'

export async function loadSessionContactMap(sessionId: string): Promise<Map<string, string>> {
  try {
    return agentDataRepository.loadDisplayNameMap(sessionId)
  } catch (error) {
    console.warn('[SessionQAAgent] 加载 Agent 联系人映射失败:', error)
    return new Map()
  }
}

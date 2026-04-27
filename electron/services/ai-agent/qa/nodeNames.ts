import type {
  SessionQAProgressSource,
  SessionQAProgressStage,
  SessionQAToolName
} from './types'

export const AGENT_TOOL_NODE_NAMES: Record<SessionQAToolName, string> = {
  read_summary_facts: '读取摘要事实',
  read_latest: '读取最近消息',
  read_by_time_range: '按时间读取',
  resolve_participant: '解析参与者',
  search_messages: '语义搜索',
  read_context: '读取上下文',
  aggregate_messages: '整理聚合',
  get_session_statistics: '运行统计',
  get_keyword_statistics: '关键词统计',
  answer: '生成回答',
  get_session_context: '读取上下文',
  prepare_vector_index: '准备语义索引'
}

export const AGENT_STAGE_NODE_NAMES: Record<SessionQAProgressStage, string> = {
  intent: '识别意图',
  tool: '运行工具',
  context: '整理依据',
  answer: '生成回答',
  thought: '规划下一步'
}

export const AGENT_SOURCE_NODE_NAMES: Record<SessionQAProgressSource, string> = {
  summary: '摘要事实',
  chat: '原始消息',
  search_index: '检索索引',
  vector: '语义向量',
  aggregate: '聚合统计',
  model: '模型推理'
}

export function getAgentNodeName(input: {
  toolName?: SessionQAToolName
  stage?: SessionQAProgressStage
  title?: string
}): string {
  if (input.toolName) return AGENT_TOOL_NODE_NAMES[input.toolName]
  if (input.stage) return AGENT_STAGE_NODE_NAMES[input.stage]
  return input.title || '运行节点'
}


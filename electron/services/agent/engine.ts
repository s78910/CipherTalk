/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { ToolLoopAgent, stepCountIs, type ProviderOptions, type UIMessageChunk } from 'ai'
import { createLanguageModel } from './provider'
import { buildSystemPrompt } from './prompts'
import { buildTools } from './tools'
import type { AgentRunInput } from './types'

const MAX_STEPS = 24

function toCamelCase(value: string): string {
  return value.replace(/[-_\s]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function buildReasoningProviderOptions(input: AgentRunInput): ProviderOptions | undefined {
  const effort = input.providerConfig.reasoningEffort
  if (!effort || effort === 'auto') return undefined
  if (input.providerConfig.providerKind !== 'openai-responses' && input.providerConfig.providerKind !== 'openai-compatible') {
    return undefined
  }

  const option = { reasoningEffort: effort }
  const keys = new Set(['openai'])
  if (input.providerConfig.providerKind === 'openai-compatible') {
    keys.add(input.providerConfig.name)
    keys.add(toCamelCase(input.providerConfig.name))
  }

  return Object.fromEntries([...keys].map((key) => [key, option])) as ProviderOptions
}

export async function runAgent(
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const agent = new ToolLoopAgent({
    model: createLanguageModel(input.providerConfig),
    instructions: buildSystemPrompt(input.scope),
    tools: buildTools(input.scope),
    stopWhen: stepCountIs(MAX_STEPS),
    providerOptions: buildReasoningProviderOptions(input),
  })

  const result = await agent.stream({ messages: input.messages, abortSignal: signal })
  for await (const chunk of result.toUIMessageStream()) {
    onChunk(chunk)
  }
}

/**
 * Agent 错误分类
 *
 * 将不同来源的错误分类为可重试/不可重试/降级三种，
 * 让编排器能做出正确的错误处理决策。
 */
import type { ClassifiedAgentError, AgentErrorSeverity } from './types'

/**
 * 分类 Agent 运行时错误
 */
export function classifyAgentError(error: unknown): ClassifiedAgentError {
  const message = error instanceof Error ? error.message : String(error || '未知错误')
  const lowerMessage = message.toLowerCase()

  // 网络错误（可重试）
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('fetch failed') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('socket hang up')
  ) {
    return {
      severity: 'retryable',
      category: 'network',
      message: `网络错误：${message}`,
      originalError: error,
      shouldRetry: true,
      retryDelayMs: 1000
    }
  }

  // 模型服务限流（可重试，需退避）
  if (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('too many requests') ||
    lowerMessage.includes('429') ||
    lowerMessage.includes('quota exceeded') ||
    lowerMessage.includes('throttl')
  ) {
    return {
      severity: 'retryable',
      category: 'rate_limit',
      message: `模型服务限流：${message}`,
      originalError: error,
      shouldRetry: true,
      retryDelayMs: 3000
    }
  }

  // 认证错误（不可重试）
  if (
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('401') ||
    lowerMessage.includes('403') ||
    lowerMessage.includes('invalid key') ||
    lowerMessage.includes('authentication')
  ) {
    return {
      severity: 'non_retryable',
      category: 'auth',
      message: `认证错误：${message}`,
      originalError: error,
      shouldRetry: false
    }
  }

  // 解析错误（降级，使用兜底值）
  if (
    lowerMessage.includes('json') ||
    lowerMessage.includes('parse') ||
    lowerMessage.includes('unexpected token') ||
    lowerMessage.includes('syntax error')
  ) {
    return {
      severity: 'degraded',
      category: 'parse',
      message: `解析错误：${message}`,
      originalError: error,
      shouldRetry: false
    }
  }

  // 数据库错误（不可重试）
  if (
    lowerMessage.includes('sqlite') ||
    lowerMessage.includes('database') ||
    lowerMessage.includes('enoent') ||
    lowerMessage.includes('no such file')
  ) {
    return {
      severity: 'non_retryable',
      category: 'database',
      message: `数据库错误：${message}`,
      originalError: error,
      shouldRetry: false
    }
  }

  // 超时错误（可重试一次）
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('aborted')
  ) {
    return {
      severity: 'retryable',
      category: 'timeout',
      message: `超时：${message}`,
      originalError: error,
      shouldRetry: true,
      retryDelayMs: 500
    }
  }

  // 未知错误
  return {
    severity: 'non_retryable',
    category: 'unknown',
    message: `未知错误：${message}`,
    originalError: error,
    shouldRetry: false
  }
}

/**
 * 判断是否应重试工具调用
 */
export function shouldRetryToolCall(error: unknown, attemptCount: number, maxRetries = 1): boolean {
  const classified = classifyAgentError(error)
  if (!classified.shouldRetry) return false
  return attemptCount < maxRetries
}

/**
 * 获取重试延迟时间
 */
export function getRetryDelayMs(error: unknown): number {
  return classifyAgentError(error).retryDelayMs || 1000
}

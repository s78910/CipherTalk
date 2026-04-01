import { z } from 'zod'
import { createToolError, createToolSuccess } from './result'
import { getMcpConfigSnapshot, getMcpHealthPayload, getMcpStatusPayload } from './runtime'
import { McpReadService } from './service'

const readService = new McpReadService()

export function registerCipherTalkMcpTools(server: any) {
  server.registerTool('health_check', {
    title: 'Health Check',
    description: 'Return CipherTalk MCP health information.'
  }, async () => {
    try {
      const payload = getMcpHealthPayload()
      return createToolSuccess('CipherTalk MCP health is available.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_status', {
    title: 'Get Status',
    description: 'Return CipherTalk MCP runtime and configuration status.'
  }, async () => {
    try {
      const payload = getMcpStatusPayload()
      return createToolSuccess('CipherTalk MCP status loaded.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List chat sessions with search and pagination.',
    inputSchema: {
      q: z.string().optional().describe('Optional search keyword.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      unreadOnly: z.boolean().optional().describe('Only return sessions with unread messages.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.listSessions((args || {}) as any)
      return createToolSuccess(`Loaded ${payload.items.length} sessions.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_messages', {
    title: 'Get Messages',
    description: 'List messages from one chat session with filters and pagination.',
    inputSchema: {
      sessionId: z.string().trim().min(1).describe('Required session identifier / username.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      order: z.enum(['asc', 'desc']).optional().describe('Message sort order by time.'),
      keyword: z.string().optional().describe('Optional content keyword filter.'),
      startTime: z.number().int().positive().optional().describe('Start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('End timestamp in seconds or milliseconds.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    }
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getMessages((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(`Loaded ${payload.items.length} messages.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })
}

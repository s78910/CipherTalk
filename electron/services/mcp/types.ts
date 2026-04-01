export const MCP_TOOL_NAMES = [
  'health_check',
  'get_status',
  'list_sessions',
  'get_messages'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export type McpLaunchMode = 'dev' | 'packaged'
export type McpLauncherMode = 'dev-runner' | 'packaged-launcher' | 'direct'

export interface McpLaunchConfig {
  command: string
  args: string[]
  cwd: string
  mode: McpLaunchMode
}

export type McpErrorCode =
  | 'BAD_REQUEST'
  | 'DB_NOT_READY'
  | 'SESSION_NOT_FOUND'
  | 'INTERNAL_ERROR'

export interface McpErrorShape {
  code: McpErrorCode
  message: string
  hint?: string
}

export interface McpHealthPayload {
  ok: boolean
  service: string
  version: string
  warnings: string[]
}

export interface McpStatusPayload {
  runtime: {
    pid: number
    platform: NodeJS.Platform
    appMode: McpLaunchMode
    launcherMode: McpLauncherMode
  }
  config: {
    mcpEnabled: boolean
    mcpExposeMediaPaths: boolean
    dbReady: boolean
  }
  capabilities: {
    tools: McpToolName[]
  }
  warnings: string[]
}

export interface McpSessionItem {
  sessionId: string
  displayName: string
  kind: 'friend' | 'group' | 'official' | 'other'
  lastMessagePreview: string
  unreadCount: number
  lastTimestamp: number
}

export interface McpSessionsPayload {
  items: McpSessionItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpMessageMedia {
  type: string
  localPath?: string | null
  md5?: string | null
  durationSeconds?: number | null
  fileName?: string | null
  fileSize?: number | null
  exists?: boolean | null
  isLivePhoto?: boolean | null
}

export interface McpMessageItem {
  messageId: number
  timestamp: number
  direction: 'in' | 'out'
  kind: string
  text: string
  sender: {
    username: string | null
    isSelf: boolean
  }
  media?: McpMessageMedia
  raw?: string
}

export interface McpMessagesPayload {
  items: McpMessageItem[]
  offset: number
  limit: number
  hasMore: boolean
}

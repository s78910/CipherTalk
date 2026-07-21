import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import {
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
  OPENAI_OAUTH_REDIRECT_URI,
  OPENAI_OAUTH_SCOPE,
  createPkceCodes,
  credentialsFromTokens,
  deleteCodexSubscriptionCredentials,
  exchangeOpenAIAuthorizationCode,
  readCodexSubscriptionCredentials,
  refreshOpenAIAccessToken,
  writeCodexSubscriptionCredentials,
} from './codexSubscriptionAuth'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export type CodexSubscriptionStatus = {
  available: boolean
  authenticated: boolean
  email?: string
  planType?: string
  requiresOpenaiAuth?: boolean
  error?: string
}

export type CodexSubscriptionModel = {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  defaultReasoningEffort?: string
}

const LOGIN_TIMEOUT_MS = 5 * 60_000
const OAUTH_PORT = 1455

export const CODEX_SUBSCRIPTION_MODELS: CodexSubscriptionModel[] = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', description: '最新通用 Codex 模型', isDefault: true, hidden: false, defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', description: '通用推理与工具调用模型', isDefault: false, hidden: false, defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', description: '更快的轻量模型', isDefault: false, hidden: false, defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', description: '低延迟 Codex 模型', isDefault: false, hidden: false, defaultReasoningEffort: 'medium' },
]

type PendingLogin = {
  loginId: string
  verifier: string
  state: string
  timeout: NodeJS.Timeout
}

function callbackHtml(success: boolean, message: string): string {
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character)
  const title = success ? 'ChatGPT 登录完成' : 'ChatGPT 登录失败'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f8;color:#202123}.box{max-width:520px;padding:32px}.title{font-size:22px;font-weight:650;margin-bottom:12px}.desc{line-height:1.6;color:#565869}</style></head><body><main class="box"><div class="title">${escapeHtml(title)}</div><div class="desc">${escapeHtml(message)}</div></main><script>setTimeout(()=>window.close(),1200)</script></body></html>`
}

class CodexSubscriptionService {
  private server: Server | null = null
  private pendingLogin: PendingLogin | null = null
  private statusListeners = new Set<(status: CodexSubscriptionStatus) => void>()

  onStatusChanged(listener: (status: CodexSubscriptionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async getStatus(refreshToken = false): Promise<CodexSubscriptionStatus> {
    try {
      let credentials = await readCodexSubscriptionCredentials()
      if (credentials && refreshToken && credentials.expiresAt <= Date.now() + 60_000) {
        const tokens = await refreshOpenAIAccessToken(credentials.refreshToken, createProxyFetch(getResolvedProxyUrl()))
        credentials = credentialsFromTokens(tokens, credentials)
        await writeCodexSubscriptionCredentials(credentials)
      }
      return {
        available: true,
        authenticated: Boolean(credentials?.accessToken && credentials?.refreshToken),
        email: credentials?.email,
        planType: credentials?.planType,
        requiresOpenaiAuth: !credentials,
      }
    } catch (error) {
      return {
        available: true,
        authenticated: false,
        requiresOpenaiAuth: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    await this.ensureServer()
    this.cancelPendingLogin()

    const loginId = randomBytes(16).toString('hex')
    const state = randomBytes(32).toString('base64url')
    const pkce = createPkceCodes()
    const timeout = setTimeout(() => {
      if (this.pendingLogin?.loginId !== loginId) return
      this.pendingLogin = null
      this.closeServer()
      void this.emitCurrentStatus('ChatGPT 登录超时，请重新尝试')
    }, LOGIN_TIMEOUT_MS)
    this.pendingLogin = { loginId, verifier: pkce.verifier, state, timeout }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OPENAI_OAUTH_CLIENT_ID,
      redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
      scope: OPENAI_OAUTH_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'ciphertalk',
      state,
    })
    return {
      loginId,
      authUrl: `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`,
    }
  }

  async logout(): Promise<void> {
    this.cancelPendingLogin()
    this.closeServer()
    await deleteCodexSubscriptionCredentials()
    this.emitStatus(await this.getStatus())
  }

  async listModels(): Promise<CodexSubscriptionModel[]> {
    const status = await this.getStatus(true)
    if (!status.authenticated) throw new Error(status.error || '请先登录 ChatGPT 账号')
    return CODEX_SUBSCRIPTION_MODELS.map((model) => ({ ...model }))
  }

  shutdown(): void {
    this.cancelPendingLogin()
    this.closeServer()
    this.statusListeners.clear()
  }

  private async ensureServer(): Promise<void> {
    if (this.server?.listening) return
    if (this.server) {
      this.server.close()
      this.server = null
    }
    const server = createServer((request, response) => {
      void this.handleCallback(request.url || '/', response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(new Error(`无法启动 ChatGPT 登录回调服务（端口 ${OAUTH_PORT}）：${error.message}`))
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(OAUTH_PORT, '127.0.0.1')
    })
    this.server = server
  }

  private async handleCallback(requestUrl: string, response: import('http').ServerResponse): Promise<void> {
    const url = new URL(requestUrl, `http://localhost:${OAUTH_PORT}`)
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const pending = this.pendingLogin
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!pending || state !== pending.state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(false, '登录状态无效或已经过期，请回到密语重新登录。'))
      return
    }

    this.cancelPendingLogin()
    if (oauthError || !code) {
      const message = oauthError || 'OpenAI 未返回授权码'
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(false, message))
      this.closeServer()
      await this.emitCurrentStatus(message)
      return
    }

    try {
      const tokens = await exchangeOpenAIAuthorizationCode(code, pending.verifier, createProxyFetch(getResolvedProxyUrl()))
      const credentials = credentialsFromTokens(tokens)
      if (!credentials.refreshToken) throw new Error('OpenAI OAuth 响应缺少 refresh_token')
      await writeCodexSubscriptionCredentials(credentials)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(true, '授权信息已保存到密语，可以关闭这个页面。'))
      this.closeServer()
      this.emitStatus(await this.getStatus())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(false, message))
      this.closeServer()
      await this.emitCurrentStatus(message)
    }
  }

  private cancelPendingLogin(): void {
    if (this.pendingLogin) clearTimeout(this.pendingLogin.timeout)
    this.pendingLogin = null
  }

  private closeServer(): void {
    this.server?.close()
    this.server = null
  }

  private async emitCurrentStatus(error?: string): Promise<void> {
    const status = await this.getStatus()
    this.emitStatus(error && !status.authenticated ? { ...status, error } : status)
  }

  private emitStatus(status: CodexSubscriptionStatus): void {
    for (const listener of this.statusListeners) {
      try { listener(status) } catch { /* ignore listener failures */ }
    }
  }
}

export const codexSubscriptionService = new CodexSubscriptionService()

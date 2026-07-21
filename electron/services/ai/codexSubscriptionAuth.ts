import { createHash, randomBytes } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { getCipherTalkCodexHome } from '../runtimePaths.ts'

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access'
export const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_SUBSCRIPTION_DUMMY_API_KEY = 'ciphertalk-oauth-dummy-key'

const TOKEN_REFRESH_MARGIN_MS = 60_000
const refreshPromises = new Map<string, Promise<CodexSubscriptionCredentials>>()

export type OpenAITokenResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export type CodexSubscriptionCredentials = {
  version: 1
  accessToken: string
  refreshToken: string
  expiresAt: number
  idToken?: string
  accountId?: string
  email?: string
  planType?: string
}

export type OpenAIJwtClaims = {
  email?: string
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  'https://api.openai.com/profile.email'?: string
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth.chatgpt_account_id'?: string
  'https://api.openai.com/auth.chatgpt_plan_type'?: string
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
  }
}

export type CodexSubscriptionFetchOptions = {
  authFilePath: string
  baseFetch?: typeof globalThis.fetch
  forceRefresh?: boolean
  now?: () => number
  refreshTokens?: (refreshToken: string) => Promise<OpenAITokenResponse>
  userAgent?: string
}

export function getCodexSubscriptionAuthPath(): string {
  const authFilePath = path.resolve(getCipherTalkCodexHome(), 'auth.json')
  const sharedCodexAuthPath = path.resolve(os.homedir(), '.codex', 'auth.json')
  if (authFilePath.toLowerCase() === sharedCodexAuthPath.toLowerCase()) {
    throw new Error('密语的 ChatGPT 登录目录不能指向电脑上的 ~/.codex/auth.json')
  }
  return authFilePath
}

export function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

export function createPkceCodes(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function parseJwtClaims(token?: string): OpenAIJwtClaims | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as OpenAIJwtClaims : undefined
  } catch {
    return undefined
  }
}

export function extractOpenAIAccountInfo(tokens: Pick<OpenAITokenResponse, 'id_token' | 'access_token'>): {
  accountId?: string
  email?: string
  planType?: string
} {
  const claims = [parseJwtClaims(tokens.id_token), parseJwtClaims(tokens.access_token)].filter(Boolean) as OpenAIJwtClaims[]
  let accountId: string | undefined
  let email: string | undefined
  let planType: string | undefined
  for (const claim of claims) {
    accountId ||= claim.chatgpt_account_id
      || claim['https://api.openai.com/auth.chatgpt_account_id']
      || claim['https://api.openai.com/auth']?.chatgpt_account_id
      || claim.organizations?.[0]?.id
    email ||= claim.email || claim['https://api.openai.com/profile.email'] || claim['https://api.openai.com/profile']?.email
    planType ||= claim['https://api.openai.com/auth.chatgpt_plan_type'] || claim['https://api.openai.com/auth']?.chatgpt_plan_type
  }
  return { accountId, email, planType }
}

export function credentialsFromTokens(
  tokens: OpenAITokenResponse,
  previous?: CodexSubscriptionCredentials | null,
  now = Date.now(),
): CodexSubscriptionCredentials {
  const account = extractOpenAIAccountInfo(tokens)
  return {
    version: 1,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || previous?.refreshToken || '',
    expiresAt: now + Math.max(1, tokens.expires_in ?? 3600) * 1000,
    ...(tokens.id_token || previous?.idToken ? { idToken: tokens.id_token || previous?.idToken } : {}),
    ...(account.accountId || previous?.accountId ? { accountId: account.accountId || previous?.accountId } : {}),
    ...(account.email || previous?.email ? { email: account.email || previous?.email } : {}),
    ...(account.planType || previous?.planType ? { planType: account.planType || previous?.planType } : {}),
  }
}

export async function readCodexSubscriptionCredentials(authFilePath = getCodexSubscriptionAuthPath()): Promise<CodexSubscriptionCredentials | null> {
  try {
    const parsed = JSON.parse(await readFile(authFilePath, 'utf8')) as Partial<CodexSubscriptionCredentials>
    if (parsed.version !== 1 || !parsed.accessToken || !parsed.refreshToken || !Number.isFinite(parsed.expiresAt)) return null
    return parsed as CodexSubscriptionCredentials
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeCodexSubscriptionCredentials(
  credentials: CodexSubscriptionCredentials,
  authFilePath = getCodexSubscriptionAuthPath(),
): Promise<void> {
  const directory = path.dirname(authFilePath)
  await mkdir(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.auth-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, authFilePath)
}

export async function deleteCodexSubscriptionCredentials(authFilePath = getCodexSubscriptionAuthPath()): Promise<void> {
  await rm(authFilePath, { force: true })
}

async function requestTokens(body: URLSearchParams, baseFetch?: typeof globalThis.fetch): Promise<OpenAITokenResponse> {
  const tokenFetch = baseFetch ?? globalThis.fetch
  const response = await tokenFetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim()
    throw new Error(`OpenAI OAuth token 请求失败 (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  return response.json() as Promise<OpenAITokenResponse>
}

export function exchangeOpenAIAuthorizationCode(code: string, verifier: string, baseFetch?: typeof globalThis.fetch): Promise<OpenAITokenResponse> {
  return requestTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  }), baseFetch)
}

export function refreshOpenAIAccessToken(refreshToken: string, baseFetch?: typeof globalThis.fetch): Promise<OpenAITokenResponse> {
  return requestTokens(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  }), baseFetch)
}

export async function getValidCodexSubscriptionCredentials(options: CodexSubscriptionFetchOptions): Promise<CodexSubscriptionCredentials> {
  const current = await readCodexSubscriptionCredentials(options.authFilePath)
  if (!current) throw new Error('请先登录 ChatGPT 账号')
  const now = (options.now ?? Date.now)()
  if (!options.forceRefresh && current.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) return current

  let pending = refreshPromises.get(options.authFilePath)
  if (!pending) {
    const refresh = options.refreshTokens ?? ((refreshToken: string) => refreshOpenAIAccessToken(refreshToken, options.baseFetch))
    pending = refresh(current.refreshToken)
      .then(async (tokens) => {
        const credentials = credentialsFromTokens(tokens, current, now)
        if (!credentials.refreshToken) throw new Error('OpenAI OAuth 刷新响应缺少 refresh_token')
        await writeCodexSubscriptionCredentials(credentials, options.authFilePath)
        return credentials
      })
      .finally(() => refreshPromises.delete(options.authFilePath))
    refreshPromises.set(options.authFilePath, pending)
  }
  return pending
}

function responseRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

async function sanitizeResponsesBody(input: RequestInfo | URL, init?: RequestInit): Promise<BodyInit | null | undefined> {
  const directBody = init?.body
  let text: string | null = typeof directBody === 'string' ? directBody : null
  if (text === null && typeof Request !== 'undefined') {
    try {
      text = await new Request(input, init).clone().text()
    } catch {
      return directBody
    }
  }
  if (!text) return directBody
  try {
    const payload = JSON.parse(text) as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(payload, 'max_output_tokens')) return directBody ?? text
    delete payload.max_output_tokens
    return JSON.stringify(payload)
  } catch {
    return directBody
  }
}

export function createCodexSubscriptionFetch(options: CodexSubscriptionFetchOptions): typeof globalThis.fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sourceUrl = responseRequestUrl(input)
    if (!sourceUrl.pathname.includes('/v1/responses')) return baseFetch(input, init)

    const credentials = await getValidCodexSubscriptionCredentials(options)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.delete('authorization')
    headers.set('Authorization', `Bearer ${credentials.accessToken}`)
    headers.set('originator', 'ciphertalk')
    headers.set('User-Agent', options.userAgent || `CipherTalk/${process.platform}-${process.arch}`)
    if (credentials.accountId) headers.set('ChatGPT-Account-Id', credentials.accountId)
    else headers.delete('ChatGPT-Account-Id')

    const body = await sanitizeResponsesBody(input, init)
    if (body !== init?.body) headers.delete('content-length')
    return baseFetch(CHATGPT_CODEX_RESPONSES_URL, {
      ...init,
      method: init?.method || (input instanceof Request ? input.method : 'POST'),
      headers,
      body,
    })
  }) as typeof globalThis.fetch
}

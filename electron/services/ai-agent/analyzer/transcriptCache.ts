import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../../config'

class AgentTranscriptCache {
  private db: Database.Database | null | undefined

  getCachedTranscript(sessionId: string, createTime: number): string | null {
    const db = this.openDb()
    if (!db) return null
    try {
      const row = db.prepare('SELECT transcript FROM transcript_cache WHERE cache_key = ?')
        .get(`${sessionId}:${createTime}`) as { transcript?: string } | undefined
      return row?.transcript || null
    } catch {
      return null
    }
  }

  private openDb(): Database.Database | null {
    if (this.db !== undefined) return this.db
    const config = new ConfigService()
    try {
      const cachePath = String(config.get('cachePath') || '').trim()
      if (!cachePath) {
        this.db = null
        return null
      }
      const dbPath = join(cachePath, 'stt-cache.db')
      if (!existsSync(dbPath)) {
        this.db = null
        return null
      }
      this.db = new Database(dbPath, { readonly: true })
      return this.db
    } catch {
      this.db = null
      return null
    } finally {
      config.close()
    }
  }
}

export const agentTranscriptCache = new AgentTranscriptCache()


import type Database from 'better-sqlite3'

export type VectorCollectionOptions = {
  dim: number
}

export type VectorUpsertItem = {
  vectorId: number
  sessionKey: number
  sessionId: string
  modelId: string
  embedding: Buffer
}

export type VectorSearchOptions = {
  sessionKey: number
  queryEmbedding: Buffer
  limit: number
}

export type VectorSearchHit = {
  vectorId: number
  distance: number
}

export interface VectorStore {
  name: string
  load(db: Database.Database): void
  isAvailable(): boolean
  getError(): string
  ensureCollection(db: Database.Database, options: VectorCollectionOptions): void
  upsert(db: Database.Database, item: VectorUpsertItem): void
  deleteByVectorId(db: Database.Database, vectorId: number): void
  deleteByVectorIds(db: Database.Database, vectorIds: number[]): void
  clearModel(db: Database.Database, modelId: string): void
  search(db: Database.Database, options: VectorSearchOptions): VectorSearchHit[]
}

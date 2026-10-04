import { type DBSchema, openDB, deleteDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'imp-translate'
const DB_VERSION = 1

const MAX_ENTRIES = 10000
const MAX_AGE = 30 * 24 * 60 * 60 * 1000

interface CacheSchema extends DBSchema {
  translations: {
    key: string
    value: {
      key: string
      text: string
      ts: number
    }
    indexes: { ts: number }
  }
}

let dbPromise: Promise<IDBPDatabase<CacheSchema>> | undefined

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<CacheSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('translations', { keyPath: 'key' })
        store.createIndex('ts', 'ts')
      },
    })
  }
  return dbPromise
}

/**
 * Prompt revision, part of every cache key.
 *
 * A stored translation records what the provider said under a *particular*
 * system prompt. Once that changes, older entries stop being representative —
 * reusing one would make a new instruction look like it does nothing. Bumping
 * this retires them in one step: no migration, no delete, and the orphaned rows
 * age out on the existing MAX_AGE/MAX_ENTENTS schedule.
 *
 * Bump it when a change to `prompt.md`, `renderSystemPrompt`, the request
 * shape, or the marker wire form would change how a block ought to come back.
 * The cache stores the provider's raw response, so a new wire form makes every
 * entry written under the old one wrong — not merely stale.
 */
const PROMPT_REVISION = 2

function cacheKey(text: string, targetLang: string): string {
  return `${PROMPT_REVISION}:${targetLang}:${text}`
}

export async function getCached(
  text: string,
  targetLang: string,
): Promise<string | undefined> {
  const db = await getDB()
  const entry = await db.get('translations', cacheKey(text, targetLang))
  if (!entry) return undefined
  if (Date.now() - entry.ts > MAX_AGE) return undefined
  return entry.text
}

export async function setCached(
  text: string,
  targetLang: string,
  translated: string,
): Promise<void> {
  const db = await getDB()
  await db.put('translations', {
    key: cacheKey(text, targetLang),
    text: translated,
    ts: Date.now(),
  })
}

export async function clearCache(): Promise<void> {
  const db = await getDB()
  await db.clear('translations')
}

export async function evictOldEntries(): Promise<void> {
  const db = await getDB()
  const cutoff = Date.now() - MAX_AGE
  const tx = db.transaction('translations', 'readwrite')
  const index = tx.store.index('ts')
  let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }

  const count = await tx.store.count()
  if (count > MAX_ENTRIES) {
    let excess = count - MAX_ENTRIES
    let oldest = await index.openCursor()
    while (oldest && excess > 0) {
      await oldest.delete()
      excess--
      oldest = await oldest.continue()
    }
  }

  await tx.done
  // Legacy DB from idb-keyval era; safe to remove once most users have upgraded
  await deleteDB('imp-translate-cache')
}

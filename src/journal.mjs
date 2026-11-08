import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SAFE_ID = /^[A-Za-z0-9_-]+$/

function checkId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new TypeError(`invalid id: ${id}`)
  return id
}

/**
 * Append-only per-Bot transcript. A cursor is a sequence number; readers ask for
 * entries after it. Every model-visible and user-visible fact goes through here.
 */
export class Journal {
  constructor(dataDir) {
    this.root = join(dataDir, 'journal')
    mkdirSync(this.root, { recursive: true })
    this.entries = new Map()
    this.nonces = new Map()
  }

  #path(botId) {
    return join(this.root, `${checkId(botId)}.jsonl`)
  }

  #load(botId) {
    if (this.entries.has(botId)) return this.entries.get(botId)
    const list = []
    const seen = new Set()
    const file = this.#path(botId)
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        list.push(entry)
        if (entry.clientNonce) seen.add(entry.clientNonce)
      }
    }
    this.entries.set(botId, list)
    this.nonces.set(botId, seen)
    return list
  }

  hasNonce(botId, nonce) {
    if (!nonce) return false
    this.#load(botId)
    return this.nonces.get(botId).has(nonce)
  }

  findByNonce(botId, nonce) {
    if (!nonce) return undefined
    return this.#load(botId).find((e) => e.clientNonce === nonce)
  }

  append(botId, kind, payload = {}, meta = {}) {
    checkId(botId)
    const list = this.#load(botId)
    const entry = {
      seq: (list.at(-1)?.seq ?? 0) + 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      ...payload,
      ...meta,
    }
    appendFileSync(this.#path(botId), `${JSON.stringify(entry)}\n`, 'utf8')
    list.push(entry)
    if (entry.clientNonce) this.nonces.get(botId).add(entry.clientNonce)
    this.emit?.(botId, entry)
    return entry
  }

  read(botId, cursor = 0, limit = 200) {
    checkId(botId)
    const list = this.#load(botId)
    const items = list.filter((e) => e.seq > cursor).slice(0, limit)
    return { items, nextCursor: items.at(-1)?.seq ?? cursor, hasMore: list.length > 0 && (list.at(-1)?.seq ?? 0) > (items.at(-1)?.seq ?? cursor) }
  }

  /** Bounded read from the tail. The timeline is the agent's context source,
   *  so every turn reads only a small window instead of copying all history. */
  tail(botId, limit = 80) {
    const list = this.#load(checkId(botId))
    return list.slice(-Math.max(1, limit))
  }

  all(botId) {
    return [...this.#load(checkId(botId))]
  }
}

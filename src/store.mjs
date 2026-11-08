import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SAFE_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
function checkId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new TypeError(`invalid id: ${id}`)
  return id
}

/** Small durable key-value store. Writes are atomic (tmp + rename). */
export class Store {
  constructor(dataDir) {
    this.root = dataDir
    this.files = join(dataDir, 'state')
    this.artifactFiles = join(dataDir, 'artifacts')
    mkdirSync(this.files, { recursive: true })
    mkdirSync(this.artifactFiles, { recursive: true })
  }

  #path(name) { return join(this.files, `${checkId(name)}.json`) }

  read(name, fallback) {
    const p = this.#path(name)
    if (!existsSync(p)) return structuredClone(fallback)
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return structuredClone(fallback) }
  }

  write(name, value) {
    const p = this.#path(name)
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, p)
    return value
  }

  newId(prefix) { return `${prefix}_${randomUUID().slice(0, 8)}` }

  // bots
  listBots() { return Object.values(this.read('bots', {})) }
  getBot(id) { return this.read('bots', {})[checkId(id)] }
  saveBot(bot) {
    const bots = this.read('bots', {})
    bots[checkId(bot.id)] = bot
    this.write('bots', bots)
    return bot
  }

  // turns
  getTurn(id) { return this.read(`turn.${checkId(id)}`, null) }
  saveTurn(turn) { return this.write(`turn.${checkId(turn.id)}`, turn) }
  listTurns() {
    return Object.keys(this.read('turnIndex', {}))
      .map((id) => this.getTurn(id))
      .filter(Boolean)
  }
  indexTurn(id) {
    const idx = this.read('turnIndex', {})
    idx[checkId(id)] = true
    this.write('turnIndex', idx)
  }

  // approvals
  getApproval(id) { return this.read(`approval.${checkId(id)}`, null) }
  saveApproval(a) { return this.write(`approval.${checkId(a.id)}`, a) }

  // secrets: values live here, never in the journal
  saveSecret(ref, value) { return this.write(`secret.${checkId(ref)}`, { ref, value, at: new Date().toISOString() }) }
  getSecret(ref) { return this.read(`secret.${checkId(ref)}`, null) }

  // artifacts
  saveArtifact(a) { return this.write(`artifact.${checkId(a.id)}`, a) }
  getArtifact(id) { return this.read(`artifact.${checkId(id)}`, null) }
  writeArtifactFile(id, content) {
    const p = join(this.artifactFiles, `${checkId(id)}`)
    writeFileSync(p, content, 'utf8')
    return p
  }
  readArtifactFile(id) {
    const p = join(this.artifactFiles, `${checkId(id)}`)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }
}

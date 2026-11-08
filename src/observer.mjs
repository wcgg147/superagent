import { createHash } from 'node:crypto'
import { Errors } from './providers.mjs'

const NOISE_SOURCES = new Set(['agent-self', 'heartbeat', 'system-noise'])
const fingerprint = (source, text) =>
  createHash('sha256').update(`${source}\0${text}`).digest('hex').slice(0, 16)

/**
 * Super-agent trait #1: proactivity.
 *
 * Four gates, cheapest first, so a weak/cheap model is never trusted with the
 * whole decision: deterministic fast path -> low-effort coarse judgement ->
 * observe-by-default (a card, no turn) -> high-effort recheck in auto mode.
 */
export class ObservationLoop {
  constructor(engine, {
    mode = process.env.OBSERVER_MODE || 'observe',
    intervalMs = Math.max(100, Number(process.env.OBSERVER_INTERVAL_MS) || 2000),
    maxPerTick = 3,
  } = {}) {
    this.engine = engine
    this.mode = ['observe', 'auto', 'off'].includes(mode) ? mode : 'observe'
    this.intervalMs = intervalMs
    this.maxPerTick = maxPerTick
    this.timer = null
    this.running = false
    this.queue = []
    this.seen = new Set(engine.store.read('observationSeen', []))
    this.stats = { received: 0, filtered: 0, judgedNo: 0, offered: 0, delegated: 0, rateLimited: 0 }
  }

  #defaultBotId() {
    const bot = this.engine.listBots().find((b) => b.kind !== 'room')
    if (!bot) throw Errors.invalid('观察目标（先创建一个 Bot）')
    return bot.id
  }

  /** Fast Path: no model call for empty, noisy, self-generated or duplicate events. */
  observe({ source = 'external', text = '', botId, meta = {} } = {}) {
    this.stats.received += 1
    if (this.mode === 'off') return { accepted: false, reason: 'observer-off' }
    const s = String(source || 'external').trim() || 'external'
    const t = String(text || '').trim()
    if (NOISE_SOURCES.has(s) || t.length < 4 || !/\p{L}/u.test(t)) {
      this.stats.filtered += 1
      return { accepted: false, reason: 'fast-path' }
    }
    const fp = fingerprint(s, t)
    if (this.seen.has(fp)) {
      this.stats.filtered += 1
      return { accepted: false, reason: 'duplicate', fingerprint: fp }
    }
    this.seen.add(fp)
    this.engine.store.write('observationSeen', [...this.seen].slice(-500))
    const id = this.engine.store.newId('obs')
    this.queue.push({
      id, fingerprint: fp, source: s, text: t,
      botId: botId || this.#defaultBotId(), meta, at: new Date().toISOString(),
    })
    return { accepted: true, observationId: id, fingerprint: fp }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { this.#tick().catch(() => {}) }, this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Process one batch. Errors are recorded on the timeline, never thrown out
   *  of the loop (a single bad event must not fail the whole drain). */
  async #drain(limit) {
    const batch = this.queue.splice(0, limit)
    for (const item of batch) {
      try { await this.#process(item) } catch (err) {
        this.engine.journal.append(item.botId, 'observation/error', {
          observationId: item.id, code: err.code || 'AGENT_FAILED', detail: String(err.message || err),
        })
      }
    }
    return batch.length
  }

  async #tick() {
    if (this.running) return
    this.running = true
    try { await this.#drain(this.maxPerTick) } finally { this.running = false }
  }

  /** Manually drive the queue. Serialized with the resident loop: a flush must
   *  never issue a second judge() while the timer's batch is still in flight,
   *  otherwise two real-model calls race and amplify gateway rate limits. */
  async flush() {
    while (this.running) await new Promise((r) => setTimeout(r, 25))
    this.running = true
    try { return await this.#drain(this.maxPerTick) } finally { this.running = false }
  }

  /** Judge with fail-safe on any transient model trouble: re-queue instead of
   *  dropping the event (a dropped observation is a silent miss). A gateway
   *  can fail with USAGE_LIMIT *or* a plain fetch/timeout error; both are worth
   *  another try. Caps retries so permanent trouble fails closed. */
  async #judgeSafe(item, effort) {
    try {
      return await this.engine.model.judge({ text: item.text, source: item.source, effort })
    } catch (err) {
      const transient = err?.code === 'USAGE_LIMIT'
        || (err?.code === 'AGENT_FAILED'
          && /不可达|fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|network|abort|socket hang|429|限流/i.test(String(err?.message || '')))
      if (!transient) throw err
      item.retries = (item.retries || 0) + 1
      if (item.retries <= 5) {
        this.queue.unshift(item)
        this.stats.rateLimited += 1
        return { requeued: true }
      }
      return { worthwhile: false, reason: 'transient-giveup' }
    }
  }

  async #process(item) {
    const coarse = await this.#judgeSafe(item, 'low')
    if (coarse.requeued) return
    if (!coarse.worthwhile) { this.stats.judgedNo += 1; return }

    this.engine.journal.append(item.botId, 'observation', {
      observationId: item.id, source: item.source,
      summary: `${item.source} · 有新情况`,
      detail: item.text.slice(0, 120), reason: coarse.reason,
    })

    if (this.mode === 'observe') {
      this.stats.offered += 1
      this.engine.cards?.offerObservation(item)
      return
    }

    const fine = await this.#judgeSafe(item, 'high')
    if (fine.requeued) return
    if (!fine.worthwhile) { this.stats.judgedNo += 1; return }
    this.stats.delegated += 1
    this.engine.sendMessage({ botId: item.botId, text: item.text, clientNonce: `observation:${item.id}` })
  }

  status() {
    return { mode: this.mode, queued: this.queue.length, seen: this.seen.size, ...this.stats }
  }
}

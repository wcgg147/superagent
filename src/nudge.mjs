import { Errors } from './providers.mjs'

/**
 * Super-agent trait #1b: proactivity over its OWN unfinished work.
 *
 * The observation loop reacts to the environment. This reacts to what the
 * agent itself left hanging: a card the human never answered. It never
 * invents work — every nudge points at a fact that is already in the
 * timeline, and it stays quiet unless the fact is old enough to matter.
 *
 * Low-interruption rules, all enforced here in code:
 *   - at most ONE nudge per scan, so it can never spam the timeline;
 *   - a per-Bot cooldown, so it does not nag;
 *   - never while that Bot is busy with something else;
 *   - each hanging item is mentioned once (until it changes).
 */

const PENDING_CARD_TYPES = new Set(['resume-offer', 'observation-offer', 'approval'])
// Only these two need a fresh card; an approval card is already on screen.
const NEEDS_CARD_TYPES = new Set(['resume-offer', 'observation-offer'])

export class ProactiveNudge {
  constructor(engine, {
    minAgeMs = envMs('NUDGE_MIN_AGE_MS', 15 * 60 * 1000),
    cooldownMs = envMs('NUDGE_COOLDOWN_MS', 30 * 60 * 1000),
    intervalMs = Math.max(100, envMs('NUDGE_INTERVAL_MS', 60 * 1000)),
    scanWindow = 300,
    enabled = process.env.NUDGE_MODE !== 'off',
  } = {}) {
    this.engine = engine
    this.minAgeMs = minAgeMs
    this.cooldownMs = cooldownMs
    this.intervalMs = intervalMs
    this.scanWindow = scanWindow
    this.enabled = enabled
    this.timer = null
    this.running = false
    this.seen = new Set(engine.store.read('nudgeSeen', []))
    this.stats = { scanned: 0, offeredTotal: 0, skippedBusy: 0, skippedCooldown: 0, skippedSeen: 0 }
  }

  start() {
    if (this.timer || !this.enabled) return
    this.timer = setInterval(() => { this.scan().catch(() => {}) }, this.intervalMs)
    this.timer.unref?.()
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  /** Hanging cards the human never answered, oldest first. */
  #pending() {
    const engine = this.engine
    const now = Date.now()
    const out = []
    for (const bot of engine.listBots()) {
      if (bot.kind === 'room') continue
      const tail = engine.journal.tail(bot.id, this.scanWindow)
      const resolved = new Set(tail.filter((e) => e.kind === 'card/resolved').map((e) => e.cardId))
      for (const e of tail) {
        if (e.kind !== 'card') continue
        const type = e.cardType
        if (!PENDING_CARD_TYPES.has(type)) continue
        // Approval cards carry an approvalId, not a cardId.
        const id = e.cardId || e.approvalId
        if (!id) continue
        if (type === 'approval') {
          const decided = tail.some((x) => x.kind === 'approval' && x.approvalId === id)
          if (decided) continue
        } else if (resolved.has(id)) continue
        const age = now - (Date.parse(e.at) || now)
        if (age < this.minAgeMs) continue
        out.push({
          kind: 'card', botId: bot.id, cardId: e.cardId || null, sourceCardId: e.cardId || null,
          sourceCardType: type, turnId: e.turnId || null, age,
          key: `${type}:${id}`,
          title: e.title || '有一件事等你点头',
          detail: e.detail || e.summary || '',
        })
      }
    }
    return out.sort((a, b) => b.age - a.age)
  }

  #cooldownOk(botId) {
    const last = this.engine.store.read(`nudge.last.${botId}`, null)
    if (!last?.at) return true
    return Date.now() - (Date.parse(last.at) || 0) >= this.cooldownMs
  }

  /** The wording is the model's job; the fallback is ours, so a weak model
   *  never leaves the user with an empty or vague nudge. */
  #phrase(item, bot) {
    const fallback = defaultPhrase(item)
    if (typeof this.engine.model.nudge !== 'function') return fallback
    return Promise.resolve(this.engine.model.nudge({ text: item.detail, bot, kind: item.kind }))
      .then((text) => {
        const t = String(text || '').trim()
        return t && t.length <= 80 ? t : fallback
      })
      .catch(() => fallback)
  }

  /** Look for something worth saying. Safe to call by hand or on a timer. */
  async scan({ botId } = {}) {
    if (!this.enabled) return { skipped: 'disabled', offered: 0 }
    if (this.running) return { skipped: 'busy-scanner', offered: 0 }
    this.running = true
    try {
      const pending = this.#pending()
      this.stats.scanned += pending.length
      let offeredNow = 0
      for (const item of pending) {
        if (botId && item.botId !== botId) continue
        if (this.seen.has(item.key)) { this.stats.skippedSeen += 1; continue }
        if (this.engine.busy(item.botId)) { this.stats.skippedBusy += 1; continue }
        if (!this.#cooldownOk(item.botId)) { this.stats.skippedCooldown += 1; continue }
        const bot = this.engine.getBot(item.botId)
        const text = await this.#phrase(item, bot)
        this.engine.outbox.emit({
          botId: item.botId, turnId: item.turnId || null, text, nudge: true,
        })
        if (NEEDS_CARD_TYPES.has(item.sourceCardType)) {
          this.engine.cards?.offerNudge({
            botId: item.botId,
            title: item.title,
            summary: text,
            sourceTurnId: item.turnId || null,
            sourceCardId: item.sourceCardId,
            sourceCardType: item.sourceCardType,
          })
        }
        this.seen.add(item.key)
        this.engine.store.write('nudgeSeen', [...this.seen].slice(-200))
        this.engine.store.write(`nudge.last.${item.botId}`, {
          at: new Date().toISOString(), key: item.key,
        })
        this.stats.offeredTotal += 1
        offeredNow += 1
        // One nudge per scan. It must not become a stream of chatter.
        break
      }
      return { ...this.stats, offered: offeredNow, pending: pending.length }
    } finally {
      this.running = false
    }
  }

  status() {
    return { enabled: this.enabled, minAgeMs: this.minAgeMs, cooldownMs: this.cooldownMs, ...this.stats }
  }
}

function envMs(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function defaultPhrase(item) {
  if (item.sourceCardType === 'approval') {
    return '刚才那条命令还等你点头，你点头我就接着跑。'
  }
  if (item.sourceCardType === 'observation-offer') {
    return '之前注意到的那件事还摊在那儿，要不要现在做掉？'
  }
  // The card summary already names the task and the step: use it rather than
  // a vague "that thing".
  const detail = String(item.detail || '').trim()
  return detail && detail.length <= 80 ? detail : '上次那件事还停着，要接着做吗？'
}

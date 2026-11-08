/** Bounded parallelism for one Bot: many turns in flight, a hard slot ceiling. */
export class TurnCoordinator {
  constructor({ maxConcurrent = 3 } = {}) {
    const n = Number(maxConcurrent)
    this.maxConcurrent = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3
    this.active = new Set()
    this.waiting = []
    this.stats = { started: 0, enqueued: 0, peak: 0 }
  }

  /** Admit a turn now, or queue its start closure until a slot frees. */
  request(id, start) {
    if (this.active.has(id)) return { started: false, position: 0, duplicate: true }
    if (this.active.size < this.maxConcurrent) {
      this.active.add(id)
      this.stats.started += 1
      this.stats.peak = Math.max(this.stats.peak, this.active.size)
      start()
      return { started: true, position: 0 }
    }
    this.waiting.push({ id, start })
    this.stats.enqueued += 1
    return { started: false, position: this.waiting.length }
  }

  release(id) {
    const had = this.active.delete(id)
    const queuedIndex = this.waiting.findIndex((item) => item.id === id)
    if (queuedIndex >= 0) this.waiting.splice(queuedIndex, 1)
    while (this.active.size < this.maxConcurrent && this.waiting.length) {
      const next = this.waiting.shift()
      this.active.add(next.id)
      this.stats.started += 1
      this.stats.peak = Math.max(this.stats.peak, this.active.size)
      next.start()
    }
    return had
  }

  /** Drop a queued turn that was cancelled before it ever got a slot. */
  cancel(id) {
    const i = this.waiting.findIndex((item) => item.id === id)
    if (i < 0) return false
    this.waiting.splice(i, 1)
    return true
  }

  status() {
    return {
      ...this.stats,
      maxConcurrent: this.maxConcurrent,
      active: this.active.size,
      queued: this.waiting.length,
      activeTurns: [...this.active],
    }
  }
}

/**
 * Single outbound voice. Workers never write assistant messages directly;
 * every reply goes through here so parallel turns still look like one agent.
 */
export class ReplyOutbox {
  constructor(engine) {
    this.engine = engine
    this.emitted = 0
  }

  emit({ botId, turnId, text, taskLabel, ...meta }) {
    this.emitted += 1
    return this.engine.journal.append(botId, 'assistant/message', {
      turnId, text, viaOutbox: true,
      ...(taskLabel ? { taskLabel } : {}),
      ...meta,
    })
  }
}

/**
 * Lightweight watchdog — deliberately NOT a separate semantic session.
 *
 * It never decides what the agent should do and never kills work on its own.
 * It only (a) emits one low-key heartbeat when a step runs long and (b) offers
 * ONE typed card when a step looks stalled, so a human can stop or keep waiting.
 * Progress itself is written by the engine per step; this loop only inspects
 * persisted turn state, so a restart cannot leave it holding stale beliefs.
 */
export class Watchdog {
  constructor(engine, {
    intervalMs = Number(process.env.WATCHDOG_INTERVAL_MS) || 5000,
    heartbeatMs = Number(process.env.WATCHDOG_HEARTBEAT_MS) || 15000,
    stallMs = Number(process.env.WATCHDOG_STALL_MS) || 30000,
  } = {}) {
    this.engine = engine
    this.intervalMs = Math.max(100, intervalMs)
    this.heartbeatMs = Math.max(100, heartbeatMs)
    this.stallMs = Math.max(this.heartbeatMs, stallMs)
    this.heartbeats = new Set()
    this.notified = new Set()
    this.ticks = 0
    this.alerts = 0
    this.timer = null
  }

  start() {
    if (this.timer) return this
    this.timer = setInterval(() => { this.tick() }, this.intervalMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this
  }

  /** A resumed turn gets a fresh chance to report a long step. */
  forget(turnId) {
    this.heartbeats.delete(turnId)
    this.notified.delete(turnId)
  }

  status() {
    return {
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      heartbeatMs: this.heartbeatMs,
      stallMs: this.stallMs,
      ticks: this.ticks,
      totalAlerts: this.alerts,
      watching: [...this.engine.running].length,
    }
  }

  /** Inspect every turn that has actually started executing a step. */
  tick(now = Date.now()) {
    this.ticks += 1
    let inspected = 0
    let alerts = 0
    for (const t of this.engine.store.listTurns()) {
      if (t.status !== 'running' || !(t.step >= 1) || !this.engine.running.has(t.id)) continue
      inspected += 1
      const started = Date.parse(t.startedAt || t.createdAt) || now
      const last = Date.parse(t.lastProgressAt || t.startedAt || t.createdAt) || now
      const idle = Math.max(0, now - last)

      if (idle >= this.heartbeatMs && !this.heartbeats.has(t.id)) {
        this.heartbeats.add(t.id)
        this.engine.journal.append(t.botId, 'watchdog', {
          turnId: t.id, level: 'heartbeat', taskLabel: t.taskLabel,
          step: t.step, total: t.total, idleMs: idle,
          summary: `还在做第 ${t.step}/${t.total} 步「${t.stepSummary || '处理中'}」，已用 ${Math.round((now - started) / 1000)}s`,
        })
      }
      if (idle >= this.stallMs && !this.notified.has(t.id)) {
        this.notified.add(t.id)
        this.alerts += 1
        alerts += 1
        if (this.engine.cards) this.engine.cards.offerWatchdog(t, idle)
      }
    }
    return { ...this.status(), inspected, alerts }
  }
}

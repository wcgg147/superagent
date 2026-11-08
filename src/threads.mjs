import { createHash } from 'node:crypto'
import { Errors } from './providers.mjs'

const MAX_EVENTS = 30
const MAX_TEXT = 160

function clean(value, label) {
  const s = String(value ?? '').trim()
  if (!s) throw Errors.invalid(label)
  return s
}

/**
 * Minimal thread chaining.
 *
 * Grouping is program-side (source + entity), never model-generated: a weak
 * model is not trusted to decide which events belong together. Related events
 * accumulate on ONE thread with ONE offer card and ONE delegated turn, instead
 * of one turn per event. Recall is a seq-watermarked delta (`afterSeq` ...
 * `throughSeq`) so a turn only sees what changed since the last delivered one.
 */
export class ThreadBook {
  constructor(engine, { maxEvents = MAX_EVENTS } = {}) {
    this.engine = engine
    this.maxEvents = maxEvents
  }

  #all() { return this.engine.store.read('threads', {}) }
  #save(all) { return this.engine.store.write('threads', all) }
  #pending(t) { return t.events.filter((ev) => ev.seq > t.deliveredSeq) }

  /** Deterministic, model-free grouping key. Same source+entity always chains. */
  static key({ botId, source, entity }) {
    return `thr_${createHash('sha256').update(`${botId}|${source}|${entity}`).digest('hex').slice(0, 10)}`
  }

  list() { return Object.values(this.#all()) }

  get(id) {
    const t = this.#all()[id]
    if (!t) throw Errors.notFound('线索')
    return t
  }

  status() {
    const items = this.list()
    return {
      total: items.length,
      openCards: items.filter((t) => t.openCardId).length,
      events: items.reduce((n, t) => n + t.events.length, 0),
    }
  }

  open({ botId, source, entity, title } = {}) {
    const b = clean(botId, 'Bot')
    const s = clean(source, '来源')
    const e = clean(entity, '线索标识')
    this.engine.getBot(b)
    const id = ThreadBook.key({ botId: b, source: s, entity: e })
    const all = this.#all()
    if (all[id]) return all[id]
    const now = new Date().toISOString()
    const t = {
      id, botId: b, source: s, entity: e,
      title: String(title || `${s} / ${e}`).trim().slice(0, 120),
      createdAt: now, updatedAt: now,
      events: [], throughSeq: 0, deliveredSeq: 0, openCardId: null, turnIds: [],
    }
    all[id] = t
    this.#save(all)
    return t
  }

  /** Events not yet consumed by a delivered turn. */
  pending(id) { return this.#pending(this.get(id)) }

  /** Minimal chain recall: only events in (afterSeq, boundSeq]. The upper bound
   *  is captured when a turn is delegated, so events arriving mid-flight are
   *  left for the next turn instead of being swallowed by this one. */
  recall(id, afterSeq = 0, boundSeq) {
    const t = this.get(id)
    const from = Number.isFinite(Number(afterSeq)) ? Math.max(0, Math.floor(Number(afterSeq))) : 0
    const cap = boundSeq === null || boundSeq === undefined || !Number.isFinite(Number(boundSeq))
      ? t.throughSeq
      : Math.max(0, Math.floor(Number(boundSeq)))
    const all = t.events.filter((ev) => ev.seq > from && ev.seq <= cap)
    const items = all.slice(-this.maxEvents).map((ev) => ({
      seq: ev.seq, source: ev.source, text: ev.text, at: ev.at,
    }))
    return {
      threadId: t.id, title: t.title,
      afterSeq: from, throughSeq: cap,
      items, truncated: all.length > items.length,
    }
  }

  /** Ingest one event. No model judgement, no turn: the card asks a human. */
  ingest({ botId, source, entity, title, text, kind } = {}) {
    const body = clean(text, '事件内容')
    const opened = this.open({ botId, source, entity, title })
    const all = this.#all()
    const t = all[opened.id]
    const short = body.slice(0, MAX_TEXT)
    const last = t.events.at(-1)
    if (last && last.text === short) {
      return {
        threadId: t.id, duplicate: true, coalesced: true, offered: false,
        cardId: t.openCardId, pending: this.#pending(t).length,
        throughSeq: t.throughSeq, deliveredSeq: t.deliveredSeq,
      }
    }
    const coalesced = Boolean(t.openCardId)
    const count = this.#pending(t).length + 1
    const entry = this.engine.journal.append(t.botId, 'thread/event', {
      threadId: t.id, source: t.source, entity: t.entity,
      text: short, eventKind: String(kind || 'event').slice(0, 40),
      count, coalesced,
    })
    t.events.push({ seq: entry.seq, source: t.source, text: short, at: entry.at })
    if (t.events.length > this.maxEvents) t.events = t.events.slice(-this.maxEvents)
    t.throughSeq = entry.seq
    t.updatedAt = entry.at

    let offered = false
    if (!t.openCardId && this.engine.cards) {
      const card = this.engine.cards.offerThread(t)
      t.openCardId = card.cardId
      offered = true
    }
    this.#save(all)
    return {
      threadId: t.id, seq: entry.seq, duplicate: false,
      coalesced: !offered, offered, cardId: t.openCardId,
      pending: this.#pending(t).length,
      throughSeq: t.throughSeq, deliveredSeq: t.deliveredSeq,
    }
  }

  /** A turn consumed the chain up to `throughSeq`; advance the watermark. */
  deliver(id, turnId, throughSeq) {
    const all = this.#all()
    const t = all[id]
    if (!t) return null
    const to = Number(throughSeq) || t.throughSeq
    t.deliveredSeq = Math.max(t.deliveredSeq, to)
    if (turnId && !t.turnIds.includes(turnId)) t.turnIds.push(turnId)
    t.openCardId = null
    t.updatedAt = new Date().toISOString()
    this.#save(all)
    return t
  }

  /** A card handed the chain to a turn; new events may open a fresh chain.
   *  Distinct from `deliver`: the model may still fail, so the watermark stays. */
  beginDelegation(id) {
    const all = this.#all()
    const t = all[id]
    if (!t) return null
    t.openCardId = null
    t.updatedAt = new Date().toISOString()
    this.#save(all)
    return t
  }

  /** Human said "不用了": drop the pending chain without delegating a turn. */
  close(id) {
    const all = this.#all()
    const t = all[id]
    if (!t) return null
    t.deliveredSeq = t.throughSeq
    t.openCardId = null
    t.updatedAt = new Date().toISOString()
    this.#save(all)
    return t
  }
}

// De-emphasise a repeated hiccup on the timeline.
//
// A proxy blip can produce a run of identical error events inside one turn.
// The words are already human (see error-copy.js), but a column of identical
// rows still reads as "the whole thing is on fire". Low attention says the
// same fact ONCE loudly; repeats become a nearly invisible whisper.
//
// Deliberately NOT a fold: every timeline event keeps its own row. The pinned
// cursor / seen / SSE contract requires DOM and API visible entries to be
// neither lost, duplicated nor invented; dropping rows would make the
// timeline look like it swallowed events. Only visual weight changes.
//
// Pure module: no DOM, no network, no timeline writes. Safe to unit-test with Node.

export const MAX_ERROR_GROUPS = 64

/** Only self-retryable (quiet) errors are de-emphasised on repetition.
 *  A quota limit or a deliberate refusal is a distinct fact and always
 *  gets its full row. */
export function errorGroupKey(botId, turnId, copy) {
  if (!copy || copy.quiet !== true) return null
  return [botId, turnId, copy.title, copy.detail]
    .map((v) => String(v ?? ''))
    .join('|')
}

/** Decide whether this event is a repeat of a group whose first row is still
 *  on screen. `alive` is supplied by the caller (no DOM access in here). */
export function errorRepeat({ key, previous, alive } = {}) {
  if (!key || !previous || !alive) return { repeat: false, count: 1 }
  const base = Number(previous.count)
  const count = (Number.isFinite(base) && base >= 1 ? Math.floor(base) : 1) + 1
  return { repeat: true, count }
}

/** What a repeat says: short, honest, Chinese, no internal identifiers. */
export function repeatedLine(count) {
  const n = Math.max(2, Number(count) || 2)
  return `· 同样的问题，第 ${n} 次`
}

/** Bounded UI bookkeeping: forget the oldest group instead of growing
 *  forever across turns. This is render state, not a second memory. */
export function rememberErrorGroup(map, key, value) {
  if (!key || !map || typeof map.set !== 'function') return
  if (map.size >= MAX_ERROR_GROUPS && !map.has(key)) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

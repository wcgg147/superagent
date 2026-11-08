/**
 * The one place that decides what the agent knows at the start of a turn.
 *
 * The timeline is the single context source. We do not maintain a second
 * memory store, do not extract "facts" from it (so there is nothing to get
 * polluted), and do not let it grow without bound. Everything here is a
 * bounded read of the append-only journal plus the skills the user explicitly
 * saved. Adding another kind of thing to remember means changing this file,
 * not wiring another side channel into the planner.
 *
 * Two layers, both read from the same timeline:
 *   - `recent`: the tail, for continuity (what just happened).
 *   - `related`: history located by what the human referred back to ("再看看
 *     package.json 那件事"), so a long-running topic is not pushed out of the
 *     window by unrelated chatter.
 *   - `openWork`: what the agent still has unfinished, so it knows how many
 *     things are on its plate.
 */

const MAX_RECENT = 12
const MAX_SKILLS = 8
const MAX_TEXT = 120
const SCAN_WINDOW = 80
const RECALL_WINDOW = 300
const MAX_RELATED = 6
const MAX_OPEN_WORK = 3
const MAX_PRIOR_DOCS = 2
const MAX_PRIOR_CHARS = 4000

// A file name is the handle people actually refer back to. Unicode letters
// matter: Chinese filenames like 项目现状.md are just as common as README.md.
const FILE_TOKEN = /[\p{L}\p{N}./\\_-]+\.(?:md|markdown|json|txt|csv|log|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|html|css|sh)\b/giu

function short(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}

/** The concrete handles in a line: file names, by base name. */
export function entitiesOf(text) {
  const out = new Set()
  for (const m of String(text || '').matchAll(FILE_TOKEN)) {
    const base = m[0].replace(/^.*[/\\]/, '').toLowerCase()
    if (base.length >= 5) out.add(base)
  }
  return [...out]
}

/** Project a timeline entry into a compact, model-visible fact. */
function project(entry) {
  const base = { seq: entry.seq }
  switch (entry.kind) {
    case 'user/message':
      return { ...base, kind: 'user', text: short(entry.text) }
    case 'assistant/message':
      return { ...base, kind: 'assistant', text: short(entry.text) }
    case 'card/resolved':
      return { ...base, kind: 'decision', text: short(entry.actionId) }
    case 'artifact':
      return { ...base, kind: 'artifact', text: short(entry.filename) }
    case 'error':
      return { ...base, kind: 'error', text: short(entry.detail || entry.title) }
    case 'result':
      return { ...base, kind: 'result', text: short(entry.summary) }
    case 'resume':
    case 'interrupt':
      return { ...base, kind: 'status', text: short(entry.summary) }
    case 'observation':
      return { ...base, kind: 'observation', text: short(entry.summary || entry.detail) }
    default:
      return null
  }
}

/** Which handles does this entry mention? */
function entitiesInEntry(entry) {
  switch (entry.kind) {
    case 'user/message':
    case 'assistant/message':
      return entitiesOf(entry.text)
    case 'tool/call':
      return [...entitiesOf(entry.detail || ''), ...entitiesOf(entry.name || '')]
    case 'artifact':
      return entitiesOf(entry.filename || '')
    case 'card':
      return [...entitiesOf(entry.title || ''), ...entitiesOf(entry.summary || '')]
    default:
      return []
  }
}

/** A recalled fact, in the same shape the model already understands. */
function relatedFact(entry) {
  switch (entry.kind) {
    case 'user/message':
      return { seq: entry.seq, kind: 'user', text: short(entry.text) }
    case 'assistant/message':
      return { seq: entry.seq, kind: 'assistant', text: short(entry.text) }
    case 'artifact':
      return { seq: entry.seq, kind: 'artifact', text: short(entry.filename) }
    case 'tool/call':
      return { seq: entry.seq, kind: 'tool', text: short(entry.detail || entry.name) }
    case 'result':
      return { seq: entry.seq, kind: 'result', text: short(entry.summary) }
    default:
      return null
  }
}

/** History about the thing the human just referred to. */
function recallRelated(tail, text, excludeSeqs) {
  const wanted = entitiesOf(text)
  if (!wanted.length) return []
  const hits = []
  const seen = new Set()
  for (const entry of tail) {
    if (excludeSeqs?.includes(entry.seq)) continue
    if (!entitiesInEntry(entry).some((e) => wanted.includes(e))) continue
    const fact = relatedFact(entry)
    if (!fact || !fact.text) continue
    const key = `${fact.kind}:${fact.text}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(fact)
  }
  return hits.slice(-MAX_RELATED)
}

/** Deliverables the agent already produced, located from the timeline and read
 *  back from disk. Still one context source: the journal points at the file,
 *  the file is the same artifact the human downloaded. No second memory. */
function priorDeliverables(tail, store) {
  if (!store || typeof store.readArtifactFile !== 'function') return []
  const out = []
  const seen = new Set()
  for (let i = tail.length - 1; i >= 0 && out.length < MAX_PRIOR_DOCS; i -= 1) {
    const e = tail[i]
    if (e.kind !== 'artifact' || !e.artifactId || seen.has(e.artifactId)) continue
    seen.add(e.artifactId)
    let text = ''
    try { text = String(store.readArtifactFile(e.artifactId) || '') } catch { continue }
    if (!text.trim()) continue
    out.push({
      filename: short(e.filename || '交付物'),
      text: text.slice(0, MAX_PRIOR_CHARS),
      ...(text.length > MAX_PRIOR_CHARS ? { truncated: true } : {}),
    })
  }
  return out.reverse()
}

/** What is still unfinished on this Bot's plate. */
function openWork(turns, botId, excludeTurnId) {
  return (turns || [])
    .filter((t) => t.botId === botId && t.id !== excludeTurnId)
    .filter((t) => t.text && !['completed', 'denied'].includes(t.status))
    .slice(-MAX_OPEN_WORK)
    .map((t) => ({
      taskLabel: t.taskLabel || '',
      status: t.status,
      text: short(t.text),
      step: (t.index || 0) + 1,
      total: (t.actions || []).length || 0,
    }))
}

/**
 * @param {object}  args
 * @param {object}  args.journal  Journal instance (read-only here)
 * @param {string}  args.botId
 * @param {Array}  [args.skills] saved skills from SkillBook.list()
 * @param {number} [args.limit]  max recent facts
 * @param {string} [args.text]  what the human asked this turn (for recall)
 * @param {Array}  [args.turns]  known turns (for open work)
 */
export function buildTurnContext({
  journal, botId, skills = [], limit = MAX_RECENT, interjection = null,
  text = '', turns = [], excludeSeqs = [], excludeTurnId = null, store = null,
} = {}) {
  if (!journal || !botId) return { recent: [], skills: [], interjection: null }
  const tail = journal.tail(botId, SCAN_WINDOW)
  const recent = []
  for (let i = tail.length - 1; i >= 0 && recent.length < limit; i -= 1) {
    const fact = project(tail[i])
    if (fact && fact.text) recent.push(fact)
  }
  recent.reverse()
  // Recall looks further back than the continuity window: a long-running topic
  // must survive unrelated chatter in between.
  const recallTail = journal.tail(botId, RECALL_WINDOW)
  const related = recallRelated(recallTail, text, excludeSeqs)
  const work = openWork(turns, botId, excludeTurnId)
  const prior = priorDeliverables(recallTail, store)
  return {
    recent,
    skills: (skills || []).slice(0, MAX_SKILLS).map((s) => ({
      name: short(s.name),
      description: short(s.description || s.instruction),
    })),
    ...(related.length ? { related } : {}),
    ...(work.length ? { openWork: work } : {}),
    ...(prior.length ? { priorDeliverables: prior } : {}),
    ...(interjection ? { interjection } : {}),
  }
}

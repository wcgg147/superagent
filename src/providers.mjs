import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const MATERIAL_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.sh', '.sql', '.html', '.css',
])
const MAX_MATERIAL_FILES = 40
const MAX_MATERIAL_BYTES = 256 * 1024
const MAX_SNIPPET = 800
// Naming a file means "I want that document", not "show me the line with the
// keyword". Give the whole file, within a hard budget, so a summary task can
// actually see every section. Keyword hits still get a short located snippet.
export const BROWSE_PAGE_CHARS = 16000
const FULL_FILE_CHARS = BROWSE_PAGE_CHARS
export const COMPOSE_BUDGET = 16000

/** Split a browse query into a material filename and an optional page offset.
 *  A long file is still read one bounded page at a time; the caller has to ask
 *  for the next page explicitly (`long.md @16000`). Nothing is cached: every
 *  page is re-read from disk, so the journal stays the only context source.
 *  Offsets are floored to a page boundary so a stray number can never produce
 *  an arbitrary slice of the document. */
export function parseBrowseQuery(query) {
  const q = String(query || '').trim()
  let pageOffset = 0
  const page = q.match(/(?:^|[\s,，、])@(\d+)(?=$|[\s,，、])/)
  if (page) {
    const n = Number(page[1])
    if (Number.isSafeInteger(n) && n >= 0) pageOffset = Math.floor(n / BROWSE_PAGE_CHARS) * BROWSE_PAGE_CHARS
  }
  let wanted = ''
  for (const tok of q.replace(/\\/g, '/').split(/[\s,，、]+/).filter(Boolean)) {
    if (/^@\d+$/.test(tok)) continue
    const base = tok.split('/').filter(Boolean).pop() || ''
    if (MATERIAL_EXTS.has(extname(base).toLowerCase())) { wanted = base; break }
  }
  return { wanted, pageOffset }
}

export const Family = { TRANSPORT: 'transport', ENTITLEMENT: 'entitlement', AGENT: 'agent' }

/** Errors carry a family so the UI can show a truthful title instead of a generic "failed". */
export class AppError extends Error {
  constructor(family, code, title, detail, status = 400) {
    super(detail || title)
    this.family = family
    this.code = code
    this.title = title
    this.status = status
  }
  toJSON() { return { family: this.family, code: this.code, title: this.title, detail: this.message, status: this.status } }
}

export const Errors = {
  notFound: (what) => new AppError(Family.TRANSPORT, 'NOT_FOUND', `找不到${what}`, `${what}不存在或已被删除`, 404),
  invalid: (what) => new AppError(Family.TRANSPORT, 'BAD_REQUEST', '请求不完整', `缺少或无效的${what}`, 400),
  noCredential: () => new AppError(Family.ENTITLEMENT, 'NO_CREDENTIAL', '还没有配置模型密钥', '设置 DEEPSEEK_API_KEY 后即可使用真实模型，当前为本地模拟模式', 402),
  usageLimit: () => new AppError(Family.ENTITLEMENT, 'USAGE_LIMIT', '用量已用完', '本周额度已用尽，请升级或等待重置', 402),
  agentFailed: (msg) => new AppError(Family.AGENT, 'AGENT_FAILED', 'Bot 没能完成这一步', msg, 500),
  commandNotAllowed: (bin) => new AppError(Family.AGENT, 'COMMAND_NOT_ALLOWED', '这条命令没被允许', `本机执行器只允许白名单命令，收到：${bin || '(空)'}`, 403),
  notImplemented: (what) => new AppError(Family.AGENT, 'NOT_IMPLEMENTED', `${what}尚未接入`, `${what}是预留的执行面 provider，请切换到 LocalExecutor 或完成接入`, 501),
}

const SECRET_REF = /@secret:([A-Za-z0-9_-]+)/g

/** Replace secret references before anything reaches the transcript. */
export function sanitizeSecrets(text) {
  const refs = []
  const clean = String(text ?? '').replace(SECRET_REF, (_m, ref) => {
    refs.push(ref)
    return '[已提供]'
  })
  return { clean, refs }
}

// ---------------------------------------------------------------- model
export const JUDGE_SYSTEM = [
  '你是常驻 Agent 的观察哨。只输出 json 对象，不要 markdown 围栏。',
  '格式：{"worthwhile":true|false,"reason":"简短原因"}。',
  '只有当环境事件出现缺陷、报错、失败、告警、超时、明确待办、需要修复或需要人决策时，worthwhile 才为 true。',
  '闲聊、通知、状态播报、重复信息、纯确认一律 false。一般用户提问（如「怎么用」「可以吗」「能帮我…吗」）若无缺陷/告警/失败/待办/需人决策信号，也属噪音，可批量处理、不打断用户。不要输出解释文字。',
].join('')

function parseJudge(content) {
  let s = String(content || '').trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) s = fence[1].trim()
  try {
    const value = JSON.parse(s)
    return { worthwhile: value.worthwhile === true, reason: String(value.reason || '').slice(0, 200) }
  } catch { return { worthwhile: false, reason: 'unparseable' } }
}

// A second, independent stable prefix: composing a deliverable from retrieved
// material. Dynamic material always goes in the trailing user turn.
const COMPOSE_SYSTEM = [
  '你是常驻 Agent 的交付物撰写器。只输出 json 对象，不要 markdown 围栏。',
  '格式：{"content":"交付物全文"}。content 是要写入文件的完整正文。',
  '只能依据提供的 materials 写，不要编造事实；材料不足就在正文里说明缺什么。',
  '如果给了 prior（之前交付过的文件正文），必须保留原有内容并在此基础上补充，不要从零重写、不要只写新增部分。',
  '用户要求可运行脚本时，content 必须是能直接运行的完整代码，不要解释文字。',
].join('')

function parseCompose(content) {
  let s = String(content || '').trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) s = fence[1].trim()
  try {
    const v = JSON.parse(s)
    return String(v.content || '').trim()
  } catch { return '' }
}

/** A third stable prefix: one short sentence to reopen a hanging topic. */
const NUDGE_SYSTEM = [
  '你是常驻 Agent。用一句不超过 30 字的中文告诉用户：有一件事还悬着、你希望他做什么。',
  '只输出 json 对象：{"text":"..."}。',
  '要具体（说清是哪件事），不要客套，不要说“我会”“稍后”“正在”。',
].join('')

function parseNudge(content) {
  let s = String(content || '').trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) s = fence[1].trim()
  try {
    const v = JSON.parse(s)
    return String(v.text || '').trim()
  } catch { return '' }
}
/** Compact the retrieved material for the trailing user turn, under a hard budget.
 *  Truncation is explicit: the model must know it is seeing a partial file. */
function composeUser({ text, materials, prior }) {
  const picked = []
  let used = 0
  for (const i of (materials || [])) {
    const snippet = String(i.snippet || '')
    if (used + snippet.length > COMPOSE_BUDGET && picked.length) break
    const room = Math.max(0, COMPOSE_BUDGET - used)
    const kept = snippet.slice(0, room)
    picked.push({ title: i.title, snippet: kept, ...(i.truncated ? { truncated: true } : {}),
      ...(kept.length < snippet.length ? { truncated: true } : {}) })
    used += kept.length
    if (used >= COMPOSE_BUDGET) break
  }
  const body = { text, materials: picked }
  if (prior?.length) body.prior = prior.slice(0, 2)
  return JSON.stringify(body)
}

/** The catalog of local files the model may read, carried in the trailing user
 *  turn (system prefix stays stable). Without it the model either invents file
 *  contents or claims it read something it never saw. */
function planUser({ text, memory, thread, catalog, materials, skills, interjection, related, openWork, priorDeliverables }) {
  const user = { text, memory: memory || [] }
  // Skills the human explicitly saved: visible at planning time so a taught
  // task can actually be reused instead of being re-explained every turn.
  if (skills?.length) user.skills = skills
  if (thread) user.thread = thread
  // History about the thing the human just referred back to.
  if (related?.length) {
    user.related = related.slice(0, 6)
    user.how_to_use_related = 'related 是同一件事以前的相关记录（用户这次提到的东西）。如果用户在接着做同一件事，基于它继续，不要从零重做。'
  }
  // What the agent still has unfinished.
  if (openWork?.length) {
    user.open_work = openWork.slice(0, 3)
    user.how_to_use_open_work = 'open_work 是这个 Bot 手上还没做完的事。如果用户的话和其中一件有关，先接上那件；不要重复已经做完的事。'
  }
  // The bodies of deliverables it already handed over, read back from the
  // timeline. "接着补上次那份" must continue the SAME document, not restart.
  if (priorDeliverables?.length) {
    user.prior_deliverables = priorDeliverables.slice(0, 2)
    user.how_to_use_prior = 'prior_deliverables 是之前交付过的文件正文。用户说「上次那份」「接着补」时，必须保留原有内容并在此基础上补充，不要从零重写或只写新增部分。'
  }
  // An interjection is layered on top of tasks still running. Tell the model
  // concretely which tasks are in flight so it keeps them separate and never
  // finalizes work it did not do this turn.
  if (interjection?.length) {
    user.interjection = interjection
    user.how_to_handle = '这是用户最新插进来的请求。上下文里可能还有其他“进行中”的任务——它们仍在跑，不要替它们收尾，也不要把它们当成已完成；这一轮只处理用户最新这条。'
  }
  if (catalog?.length) {
    user.available_files = catalog.map((c) => c.name)
    user.how_to_read = '先用一个 browse 动作读取需要的文件（query 填文件名或关键词），拿到内容后再回答；不要在没读到内容时假装已经读过。'
      + '指名文件一次最多给 16000 字：长文件请按顺序多给几个 browse 动作，第二个起 query 写成「文件名 @16000」「文件名 @32000」依次读下一页，读完再答；不要凭猜测补没读到的内容。'
  }
  if (materials?.length) {
    user.materials = materials.slice(0, 8).map((m) => ({
      title: m.title, snippet: m.snippet,
      ...(m.truncated ? { truncated: true, offset: m.offset || 0 } : {}),
      ...(m.nextOffset !== undefined ? { nextOffset: m.nextOffset } : {}),
    }))
    user.how_to_answer = '你已经读到了上面的材料。现在基于材料真正作答或产出交付物，不要只是说「我读了」。'
      + '标了 truncated 的材料只是文件的一部分：缺什么就明确说缺什么，不要编造没看到的内容。'
      + '标了 nextOffset 的材料后面还有内容：可以再发一个 browse 动作，query 写成「文件名 @nextOffset」读下一段，读完再答；不要凭猜测补没读到的部分。'
  }
  return JSON.stringify(user)
}

/** Offline hint for "one message, several jobs". Deliberately conservative:
 *  only an explicit conjunction splits, and a second clause that signals a
 *  dependency ("基于/根据/接着/然后/再") is NOT split into parallel work. */
export function splitIntents(text) {
  const t = String(text || '').trim()
  const m = t.match(/^(.{8,}?)(?:并且|同时|另外|还有)(.{8,})$/)
  if (!m) return []
  const left = m[1].trim()
  const right = m[2].trim()
  if (/^(?:基于|根据|接着|然后|再|据此|在此基础上)/.test(right)) return []
  return [left, right]
}

/** Deterministic offline model. Keeps the product loop testable without an API key. */
export class MockModel {
  constructor() { this.name = 'mock' }

  async plan(args) {
    const text = String(args?.text || '').trim()
    const parts = splitIntents(text)
    const actions = await this.#single(args)
    if (parts.length < 2) return actions
    const branches = []
    for (const part of parts) {
      const branchActions = await this.#single({ ...args, text: part })
      branches.push({ label: part.slice(0, 20), text: part, actions: branchActions })
    }
    actions.branches = branches
    return actions
  }

  /** One job, one action list. */
  async #single({ text, bot, memory, thread, catalog }) {
    const t = String(text).trim()
    if (catalog?.length && !/搜索|查|读|解释/.test(t)) {
      const actions = [{ kind: 'activity', summary: '正在理解这件事' }]
      actions.push({ kind: 'browse', query: catalog[0].name, summary: `读取 ${catalog[0].name}` })
      actions.push({ kind: 'reply', text: `先读了 ${catalog[0].name}，接着往下做。` })
      return actions
    }
    const actions = [{ kind: 'activity', summary: thread?.items?.length
      ? `接续同一条线索：新增 ${thread.items.length} 条（seq ${thread.afterSeq + 1}–${thread.throughSeq}）`
      : '正在理解这件事' }]

    if (/运行|执行|命令|shell|cmd/i.test(t)) {
      const m = t.match(/`([\s\S]+?)`/)
      actions.push({
        kind: 'run_command',
        command: m ? m[1] : 'node --version',
        requiresApproval: true,
        summary: '准备在本机执行一条命令',
        detail: m ? m[1] : 'node --version',
      })
    } else if (/写|生成|报告|文档|导出|保存|整理/i.test(t)) {
      actions.push({
        kind: 'write_artifact',
        filename: 'result.md',
        content: `# ${t}\n\n由 ${bot.name} 生成的交付物。\n\n- 输入：${t}\n- 已知记忆条数：${memory.length}\n`,
        summary: '正在起草交付物',
      })
    } else if (/搜索|查一下|检索|浏览|上网/i.test(t)) {
      actions.push({ kind: 'browse', query: t, summary: '正在检索资料' })
    }

    actions.push({
      kind: 'reply',
      text: `我是 ${bot.name}，这件事我接着往下做。${memory.length ? `我记得之前有 ${memory.length} 条上下文。` : ''}${actions.length > 2 ? '结果已经放在下面，需要改动直接说。' : '还需要我做什么，直接告诉我就行。'}`,
      summary: '整理回复',
    })
    return actions
  }

  /** Cheap coarse judgement; never calls an external API. */
  async judge({ text, source, effort = 'low' }) {
    const t = String(text || '')
    const worthwhile = /报错|失败|异常|超时|告警|缺陷|待办|修复|需要|error|fail|bug|needs repro|alert/i.test(t)
    return { worthwhile, reason: worthwhile ? '包含疑似需处理信号' : '日常信息', effort }
  }

  /** Deterministic second pass: write a deliverable from REAL material. */
  async compose({ text, materials }) {
    const items = materials || []
    return `# 基于本机材料生成\n\n> 任务：${String(text || '').slice(0, 120)}\n\n`
      + items.map((i) => `## ${i.title}\n\n${i.snippet}\n`).join('\n')
  }

  /** Offline wording for a hanging topic. */
  async nudge({ text }) {
    const t = String(text || '').trim().replace(/[「」“”"'「」]/g, '').trim()
    return t ? `${t.slice(0, 28)} 还等着你点一下。` : '上次那件事还停着，要接着做吗？'
  }
}

/** Real model adapter (OpenAI-compatible). Used when DEEPSEEK_API_KEY is set. */
export class DeepSeekModel {
  constructor({
    apiKey = process.env.DEEPSEEK_API_KEY,
    baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model = process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    reasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT || 'high',
    timeoutMs = 60000,
  } = {}) {
    this.name = 'deepseek'
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.timeoutMs = timeoutMs
  }

  /** Stable system prefix: dynamic context belongs in the trailing user turn. */
  #system(bot) {
    return [
      `你是常驻 Bot「${bot.name}」，职责：${bot.job || '协助用户'}。只输出 json 对象，不要 markdown 围栏。`,
      '格式：{"actions":[...]}。可用 kind：',
      'activity{summary}；reply{text}；',
      'write_artifact{filename,content,summary}（需要交付文件时）；',
      'browse{query,summary}；',
      'run_command{command,detail,summary,requiresApproval:true}（确实要在本机执行命令时）。',
      '规则：有后果的动作必须设 requiresApproval:true；至少包含一个 reply；不要输出解释文字。',
      '当用户明确要求生成文件、文档、导出或保存时，必须用 write_artifact 产出文件，不要只在 reply 里贴内容。',
      'write_artifact 的 content 必须是可直接交付的完整正文，不能是「待填写」「TODO」「根据读取内容填写」这类占位文字；写不出来就留空，系统会带材料再写一次。',
      '如果 timeline 里还有其他“进行中”的任务，它们仍在执行，不要替它们收尾或标记为完成；这一轮只处理用户最新这条请求。',
      '如果用户这一条消息里交代了多件互不相干的事（一口气说了几件事），不要一件件串行做完：',
      '输出 branches 形如 {"branches":[{"label":"短标题","text":"这一件事的独立描述","actions":[...]}]}，',
      '组与组之间并行执行、组内按顺序执行；只有一件事时不要输出 branches。',
      '例：用户说「读一下 README，并且看看 package.json 里有哪些脚本」——',
      '这是两件事，必须输出 {"branches":[{"label":"读 README","text":"读一下 README","actions":[{"kind":"browse","query":"README.md","summary":"读取 README"}]},',
      '{"label":"看 package.json","text":"看看 package.json 里有哪些脚本","actions":[{"kind":"browse","query":"package.json","summary":"读取 package.json"}]}]}。',
    ].join('')
  }

  /** One completion path; effort is a top-level sidecar field, never inside messages. */
  async #complete({ system, user, effort }) {
    if (!this.apiKey) throw Errors.noCredential()
    const body = {
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
    if (effort) body.reasoning_effort = effort
    let data = await this.#request(body)
    if (data.__status === 400 && /response_format|json_object|reasoning_effort/i.test(data.__body || '')) {
      delete body.response_format
      delete body.reasoning_effort
      data = await this.#request(body)
    }
    if (data.__status === 401 || data.__status === 403) {
      throw new AppError(Family.ENTITLEMENT, 'NO_CREDENTIAL', '模型密钥未被接受', '请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配', 402)
    }
    // A gateway under load answers 429; that is transient, so back off and retry
    // instead of failing the whole turn.
    if (data.__status === 429) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await new Promise((r) => setTimeout(r, 800 * attempt))
        data = await this.#request(body)
        if (data.__status !== 429) break
      }
    }
    if (data.__status === 402 || data.__status === 429) throw Errors.usageLimit()
    if (data.__status !== 200) {
      throw Errors.agentFailed(`模型服务返回 ${data.__status}：${String(data.__body || '').slice(0, 200)}`)
    }
    const message = data.choices?.[0]?.message || {}
    return String(message.content || message.reasoning_content || '')
  }

  async plan({ text, bot, memory, effort, thread, catalog, materials, skills, interjection, related, openWork, priorDeliverables }) {
    const content = await this.#complete({
      system: this.#system(bot),
      user: planUser({ text, memory, thread, catalog, materials, skills, interjection, related, openWork, priorDeliverables }),
      effort: effort || this.reasoningEffort,
    })
    const parsed = parsePlan(content)
    const actions = normalizeActions(parsed.actions, bot)
    const branches = normalizeBranches(parsed.branches, bot)
    // Parallel branches ride along on the action list: the plan contract stays
    // an array of actions, so nothing downstream has to learn a new shape.
    if (branches.length) actions.branches = branches
    return actions
  }

  async judge({ text, source, effort = 'low' }) {
    const content = await this.#complete({
      system: JUDGE_SYSTEM,
      user: JSON.stringify({ source, text }),
      effort,
    })
    return parseJudge(content)
  }

  /** Second pass: write the actual file body from retrieved material.
   *  Stable system prefix, dynamic material in the trailing user turn. */
  async compose({ text, materials, effort, prior }) {
    const content = await this.#complete({
      system: COMPOSE_SYSTEM,
      user: composeUser({ text, materials, prior }),
      effort: effort || this.reasoningEffort,
    })
    return parseCompose(content)
  }

  /** One short line to reopen a topic the human left hanging. */
  async nudge({ text, bot }) {
    const content = await this.#complete({
      system: NUDGE_SYSTEM,
      user: JSON.stringify({ text: String(text || '').slice(0, 200), bot: bot?.name || '' }),
      effort: 'low',
    })
    return parseNudge(content)
  }

  async #request(body) {
    let response
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) { throw Errors.agentFailed(`模型服务不可达：${err.message}`) }
    const raw = await response.text()
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = {} }
    return { ...parsed, __status: response.status, __body: raw }
  }
}

const KNOWN_ACTIONS = new Set(['activity', 'reply', 'write_artifact', 'browse', 'run_command'])

/** A plan may carry parallel branches: one message that holds several jobs. */
function parsePlan(content) {
  let s = String(content || '').trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) s = fence[1].trim()
  const read = (raw) => {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return { actions: parsed, branches: [] }
      if (!parsed || typeof parsed !== 'object') return null
      return {
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        branches: Array.isArray(parsed.branches) ? parsed.branches : [],
      }
    } catch { return null }
  }
  const whole = read(s)
  if (whole) return whole
  // The model sometimes wraps the object in prose; take the outermost braces.
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const embedded = read(s.slice(start, end + 1))
    if (embedded) return embedded
  }
  return { actions: [], branches: [] }
}

/** Parallel branches of one request. Each branch is an independent job. */
function normalizeBranches(branches, bot, limit = 3) {
  const out = []
  for (const b of Array.isArray(branches) ? branches : []) {
    if (!b || typeof b !== 'object') continue
    const raw = Array.isArray(b.actions) ? b.actions : []
    if (!raw.length) continue
    out.push({
      label: String(b.label || '').slice(0, 40),
      text: String(b.text || '').slice(0, 200),
      actions: normalizeActions(raw, bot),
    })
    if (out.length >= limit) break
  }
  return out
}

function normalizeActions(actions, bot) {
  // Honest fallback: never claim the work is done when the model gave no answer.
  const NO_ANSWER = '这一步我还没给出答案，可以直接再问我一次。'
  const list = Array.isArray(actions) ? actions.filter((a) => a && typeof a === 'object') : []
  const clean = list.map((a) => {
    const kind = KNOWN_ACTIONS.has(a.kind) ? a.kind : 'reply'
    switch (kind) {
      case 'reply': {
        const text = String(a.text ?? a.content ?? '').trim()
        return { kind, text: text || NO_ANSWER, fallback: !text }
      }
      case 'write_artifact':
        return { kind, filename: String(a.filename || 'result.md'), content: String(a.content ?? ''), summary: String(a.summary || '正在起草交付物') }
      case 'run_command':
        return {
          kind, command: String(a.command || a.detail || 'node --version'),
          detail: String(a.detail || a.command || ''),
          summary: String(a.summary || '准备在本机执行命令'),
          requiresApproval: a.requiresApproval !== false,
        }
      case 'browse':
        return { kind, query: String(a.query || ''), summary: String(a.summary || '正在检索') }
      default:
        return { kind: 'activity', summary: String(a.summary || '正在处理') }
    }
  })
  if (!clean.some((a) => a.kind === 'reply')) clean.push({ kind: 'reply', text: NO_ANSWER, fallback: true })
  return clean
}

// ---------------------------------------------------------------- executor

// Read-only utilities a model reaches for when it wants to LOOK at a file.
// They are translated into the safer browse() path instead of being executed.
const READ_COMMANDS = new Set(['cat', 'type', 'head', 'less', 'more', 'tail'])
const ALLOWED_BIN = new Set(['node', 'git', 'npm', 'pnpm', 'python', 'python3'])

/** `cat materials/sort.js` -> a browse() over that file. Returns null if not a read. */
export function readCommandToBrowse(command) {
  const parts = tokenize(command)
  if (parts.length < 2) return null
  const bin = parts[0].toLowerCase()
  if (!READ_COMMANDS.has(bin)) return null
  const target = parts[1]
  if (!target || target.startsWith('-')) return null
  return { query: target, summary: `读取 ${target}` }
}

function tokenize(command) {
  return (String(command).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((s) => s.replace(/^["']|["']$/g, ''))
}

/**
 * Local resident executor. This is the P0-A provider: same machine as the daemon.
 * It implements the ExecutorProvider interface so it can be swapped for a DSH-based
 * provider (or a future HarmonyOS / cloud provider) without touching the engine.
 */
export class LocalExecutor {
  constructor({ store, workspace }) { this.store = store; this.workspace = workspace; this.name = 'local' }

  capabilities() { return ['terminal', 'file', 'headless_browser', 'artifact'] }

  async runCommand({ command }) {
    const [bin, ...args] = tokenize(command)
    if (!bin || !ALLOWED_BIN.has(bin)) throw Errors.commandNotAllowed(bin)
    try {
      const stdout = execFileSync(bin, args, {
        encoding: 'utf8', timeout: 10000, cwd: this.workspace, windowsHide: true, maxBuffer: 1024 * 1024,
      })
      return { stdout: String(stdout).trim().slice(0, 4000) }
    } catch (err) {
      throw Errors.agentFailed(`命令执行失败：${err.message}`)
    }
  }

  async writeArtifact({ filename, content }) {
    const id = this.store.newId('art')
    this.store.writeArtifactFile(id, String(content ?? ''))
    return this.store.saveArtifact({
      id, filename: String(filename || 'result.txt'), url: `/api/artifacts/${id}`, createdAt: new Date().toISOString(),
    })
  }

  /** The catalog of local files the model may ask to read. */
  async listMaterials() {
    const dir = join(this.workspace, 'materials')
    if (!existsSync(dir)) return []
    const out = []
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !MATERIAL_EXTS.has(extname(ent.name).toLowerCase())) continue
      let size = 0
      try { size = statSync(join(dir, ent.name)).size } catch { continue }
      out.push({ name: ent.name, size })
      if (out.length >= MAX_MATERIAL_FILES) break
    }
    return out
  }

  /** Real local retrieval: read the materials the user put in DATA_DIR/materials/.
   *  No network, no dependencies, no absolute paths leaked back to the transcript.
   *  Returns an honest empty result instead of a fabricated hit when nothing matches. */
  async browse({ query } = {}) {
    const dir = join(this.workspace, 'materials')
    if (!existsSync(dir)) {
      return { items: [], source: 'local', note: '本机还没有可检索的资料：把文件放进运行目录的 materials/ 子目录即可。' }
    }
    const q = String(query || '').trim()
    const { wanted, pageOffset } = parseBrowseQuery(q)
    const terms = q.toLowerCase().split(/[\s,，、/]+/)
      .filter((t) => t.length >= 2 && !t.startsWith('[') && !/^@\d+$/.test(t)).slice(0, 6)
    const files = []
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !MATERIAL_EXTS.has(extname(ent.name).toLowerCase())) continue
      const full = join(dir, ent.name)
      try { if (statSync(full).size > MAX_MATERIAL_BYTES) continue } catch { continue }
      files.push({ name: ent.name, full })
      if (files.length >= MAX_MATERIAL_FILES) break
    }
    if (!files.length) {
      return { items: [], source: 'local', note: 'materials/ 里没有可检索的文本文件（.txt/.md/.json/.csv/.log 等）。' }
    }
    // If the query names a file, that file IS the answer's source: return it
    // within a hard budget instead of jumping to the first keyword. An explicit
    // `@offset` asks for the NEXT page; nothing is cached or auto-fetched, so a
    // long document is only read further when the model actually asks for it.
    const exactFiles = wanted ? files.filter((f) => f.name.toLowerCase() === wanted.toLowerCase()) : []
    const candidates = exactFiles.length ? exactFiles : files
    const items = []
    let pastEnd = false
    for (const f of candidates) {
      let text
      try { text = readFileSync(f.full, 'utf8') } catch { continue }
      const lower = text.toLowerCase()
      const name = f.name.toLowerCase()
      const exact = wanted && name === wanted.toLowerCase()
      const contentHit = terms.find((t) => lower.includes(t)) || null
      const nameHit = terms.find((t) => name.includes(t)) || null
      if (!exact && !contentHit && !nameHit) continue
      // Only a named file can be paged. Keyword hits keep the old 800-char
      // located snippet so the bounded and honest contract never changes.
      if (exact && pageOffset >= text.length) { pastEnd = true; continue }
      const offset = exact ? pageOffset : (contentHit ? Math.max(0, lower.indexOf(contentHit) - 60) : 0)
      const budget = exact ? FULL_FILE_CHARS : MAX_SNIPPET
      const raw = text.slice(offset, offset + budget)
      const snippet = raw.replace(/\s+/g, ' ').trim()
      const covered = offset + raw.length
      // Skipping the beginning is truncation too: the old check only looked at
      // the tail, so a file read from char 7622 claimed to be complete.
      const truncated = offset > 0 || covered < text.length
      items.push({
        title: f.name, snippet, matched: contentHit || nameHit || 'exact',
        via: exact ? 'exact' : contentHit ? 'content' : 'filename',
        bytes: text.length, shown: covered, offset, window: exact ? 'full' : 'located',
        ...(exact ? { page: Math.floor(offset / BROWSE_PAGE_CHARS) + 1 } : {}),
        ...(exact && covered < text.length ? { nextOffset: covered } : {}),
        ...(truncated ? { truncated: true } : {}),
      })
      if (items.length >= 8) break
    }
    const clipped = items.filter((i) => i.truncated).length
    const more = items.some((i) => i.nextOffset !== undefined)
    return {
      items, source: 'local',
      note: pastEnd
        ? '已经读到文件末尾，没有更多内容了。'
        : items.length
          ? `本机 materials/ 命中 ${items.length} 处${clipped ? `（${clipped} 份只给了部分内容）` : ''}${more ? '；后面还有内容，可再发一个 browse 带 @<nextOffset> 续读' : ''}`
          : `本机 materials/ 里没有与「${q}」相关的内容`,
    }
  }
}

/** Pinned integration contract for the DeepSeek Harness CLI. */
export const DSH_PINNED_VERSION = '0.2.1-rc.5'

export function assertPinnedVersion(actual) {
  const version = String(actual || '').trim()
  if (version !== DSH_PINNED_VERSION) {
    throw new AppError(Family.AGENT, 'DSH_VERSION_MISMATCH', 'DSH 版本与钉扎版本不一致',
      `钉住 ${DSH_PINNED_VERSION}，实际 ${version || '(未知)'}；升级适配层后再改钉扎常量`, 500)
  }
  return version
}

/** Parse the newline-delimited event stream of `dsh headless --json`. */
export function parseDshStream(stdout) {
  let finalText = ''
  let sessionId = null
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'final') finalText = String(event.text ?? event.content ?? '')
      if (event.type === 'session') sessionId = event.sessionId || event.id || sessionId
    } catch { /* non-JSON diagnostic line */ }
  }
  return {
    finalText: finalText.trim() || String(stdout || '').trim().slice(-2000),
    sessionId,
  }
}

export function parseDshFinal(stdout) { return parseDshStream(stdout).finalText }

/**
 * DeepSeek Harness execution provider. The CLI is the integration boundary:
 * pre-stable internals stay isolated, and commands/files still go through the
 * local executor so the whitelist / approval boundary is unchanged.
 */
export class DshExecutor {
  constructor({
    store, workspace, bin = process.env.DSH_BIN || 'dsh',
    entry = process.env.DSH_CLI_ENTRY, home = process.env.DSH_HOME,
    timeoutMs = 120000,
  } = {}) {
    this.name = 'dsh'
    this.local = new LocalExecutor({ store, workspace })
    this.bin = bin
    this.entry = entry
    this.home = home
    this.timeoutMs = timeoutMs
    this.store = store
    this.sessions = new Map(Object.entries(store?.read?.('dshSessions', {}) || {}))
    this.verified = false
  }

  capabilities() { return ['terminal', 'file', 'headless_browser', 'artifact', 'dsh_tools'] }

  #base() {
    return this.entry
      ? { command: process.execPath, prefix: [this.entry], shell: false }
      : { command: this.bin, prefix: [], shell: process.platform === 'win32' }
  }

  #exec(args, task = '') {
    return new Promise((resolve, reject) => {
      const { command, prefix, shell } = this.#base()
      const env = { ...process.env, ...(this.home ? { DSH_HOME: this.home } : {}) }
      const child = spawn(command, [...prefix, ...args], {
        cwd: this.local.workspace, env, windowsHide: true, shell,
      })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => child.kill(), this.timeoutMs)
      child.stdout?.on('data', (d) => { stdout += d })
      child.stderr?.on('data', (d) => { stderr += d })
      child.on('error', (err) => { clearTimeout(timer); reject(Errors.agentFailed(`DSH 启动失败：${err.message}`)) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) return reject(Errors.agentFailed(`DSH 退出码 ${code}：${stderr.slice(-300)}`))
        resolve({ stdout, stderr })
      })
      child.stdin?.end(task)
    })
  }

  /** Verify once per instance; a version drift fails loudly instead of silently. */
  async verify() {
    if (this.verified) return DSH_PINNED_VERSION
    const { stdout } = await this.#exec(['--version'])
    const version = assertPinnedVersion(stdout)
    this.verified = true
    return version
  }

  async #runTask(task, botId) {
    await this.verify()
    const sid = botId ? this.sessions.get(botId) : null
    const args = sid
      ? ['headless', '--json', '--session-id', sid, '-']
      : ['headless', '--json', '-']
    const { stdout } = await this.#exec(args, task)
    const { finalText, sessionId } = parseDshStream(stdout)
    if (botId && sessionId) {
      this.sessions.set(botId, sessionId)
      this.store?.write?.('dshSessions', Object.fromEntries(this.sessions))
    }
    return finalText
  }

  async browse({ query, botId }) {
    const text = await this.#runTask(`Research briefly and return a short factual summary, no preamble: ${query}`, botId)
    return { items: [{ title: 'DSH 检索结果', snippet: text.slice(0, 1200), url: 'about:blank' }], provider: 'dsh' }
  }

  /** The catalog is local files, independent of where commands run. Keep the
   *  ExecutorProvider interface complete so a gray-rolled Bot still sees them. */
  async listMaterials() { return this.local.listMaterials() }

  async runCommand({ command }) { return this.local.runCommand({ command }) }
  async writeArtifact({ filename, content }) { return this.local.writeArtifact({ filename, content }) }
}

// ---------------------------------------------------------------- secrets

/** Values stay in the local state dir. The transcript only ever sees a reference. */
export class SecretBroker {
  constructor({ store }) { this.store = store }
  submit(value) {
    if (typeof value !== 'string' || !value.trim()) throw Errors.invalid('secret')
    const ref = `sec_${randomUUID().slice(0, 10)}`
    this.store.saveSecret(ref, value)
    return { ref, note: '值保存在本机状态目录；transcript 里只有引用。' }
  }
  resolve(ref) { return this.store.getSecret(ref)?.value ?? null }
}

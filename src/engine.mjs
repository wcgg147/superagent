import { Journal } from './journal.mjs'
import { Store } from './store.mjs'
import {
  AppError, Errors, MockModel, DeepSeekModel, LocalExecutor, DshExecutor, SecretBroker, sanitizeSecrets,
  readCommandToBrowse, splitIntents, COMPOSE_BUDGET,
} from './providers.mjs'
import { TurnCoordinator, ReplyOutbox } from './turns.mjs'
import { SkillBook } from './features.mjs'
import { buildTurnContext } from './context.mjs'

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'denied'])

// A step failure is not automatically a dead task. Only transient transport
// failures get a retry / a "stopped at this step" offer; command rejections,
// invalid input and approval denials stay terminal failures.
const TRANSIENT_CODES = new Set(['USAGE_LIMIT'])
const TRANSIENT_TEXT = /不可达|fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|network|abort|socket hang|429|限流/i
function isTransient(err) {
  if (TRANSIENT_CODES.has(err?.code)) return true
  if (err?.code !== 'AGENT_FAILED') return false
  return TRANSIENT_TEXT.test(String(err?.message || ''))
}

/** A weak model sometimes writes "待根据读取内容填写" as the file body.
 *  That is not a deliverable: treat it as empty so the compose/material
 *  backstops actually run instead of shipping a placeholder to the human. */
function isPlaceholderContent(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t.length > 160) return false
  return /填写|待补|待完善|待根据|待完善|根据读取内容|此处将|将基于|以下内容待|占位|稍后补|示例文本|TODO\b|TBD\b|placeholder|xxxxxxxx/i.test(t)
    || /^[（(].*[）)]\s*$/.test(t)
    || /^#{1,6}\s*[^\n]+\s*$/.test(t)
}

/** A bounded, factual preview of a deliverable: real lines from the file,
 *  never generated prose. So the timeline shows what was actually written. */
function previewOf(text, maxLines = 6, maxChars = 90) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const structured = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/.test(line)
    if (!structured && out.length) continue
    out.push(line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '').slice(0, maxChars))
    if (out.length >= maxLines) break
  }
  return out
}

/** Collect every browse page THIS turn already put on the append-only timeline.
 *  A long document is read page by page; keeping only turn.lastBrowse meant the
 *  deliverable silently lost every earlier page. The journal is the only
 *  context source, so we read it back instead of adding any cache or index.
 *  Bounded and honest: duplicate pages are dropped, pages are ordered by
 *  offset, and exceeding either cap is reported (not silently truncated away). */
export function collectTurnMaterials(entries, turnId, { maxPages = 8, maxChars = 64000 } = {}) {
  const seen = new Set()
  const items = []
  let chars = 0
  let clipped = false
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.turnId !== turnId || e.kind !== 'tool/call' || e.name !== 'browse') continue
    const results = e.result?.items
    if (!Array.isArray(results)) continue
    for (const it of results) {
      if (!it || typeof it !== 'object') continue
      const key = `${String(it.title ?? '')}@${it.offset ?? 0}`
      if (seen.has(key)) continue
      const snippet = String(it.snippet ?? '')
      if (items.length >= maxPages || chars + snippet.length > maxChars) { clipped = true; break }
      seen.add(key)
      chars += snippet.length
      items.push(it)
    }
    if (clipped) break
  }
  // Stable page order even if the model asked for the pages out of order.
  items.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''))
    || (Number(a.offset) || 0) - (Number(b.offset) || 0))
  if (clipped && items.length) {
    items[items.length - 1] = { ...items[items.length - 1], truncated: true }
  }
  return { items, clipped }
}

/** Split ordered browse pages into batches that each fit the EXISTING compose
 *  budget. composeUser() stops at COMPOSE_BUDGET and silently drops every later
 *  page; feeding one batch per call keeps each call inside that same budget
 *  without raising it. A single page always forms one batch (never dropped),
 *  even if it alone exceeds the budget -- that preserves composeUser's old
 *  first-item behaviour. Pure function: no state, no cache, no side effects. */
export function splitMaterialsForCompose(items, budget = COMPOSE_BUDGET) {
  const out = []
  let batch = []
  let used = 0
  for (const it of Array.isArray(items) ? items : []) {
    const len = String(it?.snippet ?? '').length
    if (batch.length && used + len > budget) {
      out.push(batch)
      batch = []
      used = 0
    }
    batch.push(it)
    used += len
  }
  if (batch.length) out.push(batch)
  return out
}

/**
 * The resident control loop. It owns the Bot registry, the append-only transcript,
 * turn state, approvals and interrupts. Execution is delegated to an ExecutorProvider.
 */
export class Engine {
  constructor({ dataDir, model, executor, maxConcurrent = process.env.MAX_CONCURRENT_TURNS } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required')
    this.dataDir = dataDir
    this.store = new Store(dataDir)
    this.journal = new Journal(dataDir)
    this.model = model ?? (process.env.DEEPSEEK_API_KEY ? new DeepSeekModel() : new MockModel())
    const requested = process.env.EXECUTOR_PROVIDER || 'local'
    this.executorMode = ['local', 'dsh', 'gray'].includes(requested) ? requested : 'local'
    this.customExecutor = executor || null
    this.localExecutor = new LocalExecutor({ store: this.store, workspace: dataDir })
    this.dshExecutor = this.executorMode === 'local'
      ? null
      : new DshExecutor({ store: this.store, workspace: dataDir })
    const fallback = this.executorMode === 'dsh'
      ? (this.dshExecutor || this.localExecutor)
      : this.localExecutor
    this.executor = this.customExecutor || fallback
    this.broker = new SecretBroker({ store: this.store })
    this.cards = null
    this.skillBook = new SkillBook(this)
    this.threads = null
    this.quota = null
    this.listeners = new Set()
    this.waiters = new Map()
    this.running = new Set()
    this.coordinator = new TurnCoordinator({ maxConcurrent })
    this.outbox = new ReplyOutbox(this)
    this.parallelAtStart = new Map()
    this.taskOpen = new Set()
    this.interrupted = new Set()
    this.groupWaiters = new Map()
    this.watchdog = null
    this.journal.emit = (botId, entry) => this.#broadcast({ type: 'entry', botId, entry })
  }

  // -------------------------------------------------------------- public API

  listBots() { return this.store.listBots() }
  getBot(id) { const b = this.store.getBot(id); if (!b) throw Errors.notFound('Bot'); return b }
  getTurn(id) { const t = this.store.getTurn(id); if (!t) throw Errors.notFound('任务'); return t }
  getApproval(id) { const a = this.store.getApproval(id); if (!a) throw Errors.notFound('审批卡片'); return a }
  getArtifact(id) { const a = this.store.getArtifact(id); if (!a) throw Errors.notFound('交付物'); return a }
  readArtifactFile(id) { return this.store.readArtifactFile(id) }
  getTranscript(botId, cursor = 0, limit = 200) { this.getBot(botId); return this.journal.read(botId, cursor, limit) }
  submitSecret(value) { return this.broker.submit(value) }
  capabilities() {
    return {
      model: this.model.name,
      executor: this.executor.name,
      capabilities: this.executor.capabilities(),
      concurrency: this.coordinator.status(),
      mode: this.executorMode,
      dshAvailable: Boolean(this.dshExecutor),
      grayBots: this.listBots().filter((b) => b.executor === 'dsh').map((b) => b.id),
    }
  }

  /** Rollout switch: local (default) / dsh (all) / gray (per-Bot opt-in). */
  executorFor(botId) {
    if (this.customExecutor) return this.customExecutor
    if (this.executorMode === 'local') return this.localExecutor
    if (this.executorMode === 'dsh') return this.dshExecutor || this.localExecutor
    const bot = this.store.getBot(botId)
    return bot?.executor === 'dsh' && this.dshExecutor ? this.dshExecutor : this.localExecutor
  }

  setBotExecutor(id, provider) {
    if (!['local', 'dsh'].includes(provider)) throw Errors.invalid('执行面（local / dsh）')
    if (provider === 'dsh' && !this.dshExecutor) {
      throw Errors.invalid('执行面（dsh 未启用，请先设 EXECUTOR_PROVIDER=gray 或 dsh）')
    }
    const bot = this.getBot(id)
    bot.executor = provider
    this.store.saveBot(bot)
    return bot
  }

  rollbackExecutors() {
    const rolledBack = []
    for (const bot of this.listBots()) {
      if (!bot.executor) continue
      delete bot.executor
      this.store.saveBot(bot)
      rolledBack.push(bot.id)
    }
    return { rolledBack: rolledBack.length, bots: rolledBack }
  }

  executorStatus() {
    return {
      mode: this.executorMode,
      defaultExecutor: this.executor.name,
      dshAvailable: Boolean(this.dshExecutor),
      grayBots: this.listBots().filter((b) => b.executor === 'dsh').map((b) => b.id),
    }
  }

  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  createBot({ name, job } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw Errors.invalid('Bot 名称')
    const bot = {
      id: this.store.newId('bot'), name: name.trim(), job: String(job || '').trim(),
      createdAt: new Date().toISOString(), memory: [],
    }
    this.store.saveBot(bot)
    this.journal.append(bot.id, 'system', { text: `Bot「${bot.name}」已创建。${bot.job ? `职责：${bot.job}` : ''}` })
    return bot
  }

  /** A send is only an acceptance. The result arrives later through the transcript / SSE. */
  sendMessage({ botId, text, clientNonce, threadId } = {}) {
    this.getBot(botId)
    if (this.quota) this.quota.checkAndConsume(botId)
    if (typeof text !== 'string' || !text.trim()) throw Errors.invalid('消息内容')
    const nonce = clientNonce ? String(clientNonce) : undefined
    if (nonce && this.journal.hasNonce(botId, nonce)) {
      const existing = this.journal.findByNonce(botId, nonce)
      return { accepted: true, duplicate: true, turnId: existing.turnId, botId }
    }
    // An interjection is a message that arrives while this Bot already has a
    // task in flight. The running task must NOT be stopped — this new request
    // is handled on its own turn, layered on top of what's already running.
    const against = this.#inFlightTurns(botId)
    const interjected = against.length > 0
    const { clean, refs } = sanitizeSecrets(text)
    const turnId = this.store.newId('turn')
    const counts = this.store.read('taskCounts', {})
    const taskNumber = (Number(counts[botId]) || 0) + 1
    counts[botId] = taskNumber
    this.store.write('taskCounts', counts)
    const taskLabel = `任务 ${taskNumber}`
    let thread = null
    if (threadId) {
      if (!this.threads) throw Errors.invalid('线索（未启用）')
      thread = this.threads.get(String(threadId))
    }
    const userEntry = this.journal.append(botId, 'user/message', {
      text: clean, turnId, secretRefs: refs, secretProvided: refs.length > 0,
      ...(interjected ? { interjection: true } : {}),
      ...(thread ? { threadId: thread.id } : {}),
    }, nonce ? { clientNonce: nonce } : {})
    this.store.saveTurn({
      id: turnId, botId, status: 'running', index: 0, actions: [], text: clean,
      taskLabel, secretRefs: refs, createdAt: new Date().toISOString(),
      userSeq: userEntry.seq,
      ...(interjected ? { interjected: true, againstLabels: against.map((id) => this.store.getTurn(id)?.taskLabel).filter(Boolean) } : {}),
      ...(thread ? {
        threadId: thread.id,
        threadAfterSeq: thread.deliveredSeq,
        threadThroughSeq: thread.throughSeq,
      } : {}),
    })
    this.store.indexTurn(turnId)
    const start = () => {
      const live = this.store.getTurn(turnId)
      if (!live || TERMINAL.has(live.status) || this.interrupted.has(turnId)) {
        this.coordinator.release(turnId)
        this.#notify(turnId)
        return
      }
      const parallel = this.#markParallel(botId)
      this.taskOpen.add(turnId)
      this.journal.append(botId, 'task', { turnId, taskLabel, status: 'running', parallel, ...(thread ? { threadId: thread.id } : {}) })
      queueMicrotask(() => this.#run(turnId))
    }
    const admission = this.coordinator.request(turnId, start)
    // Acknowledge the interjection through one voice: the running task keeps
    // going, and this new request is handled separately (now, or once a slot
    // frees). A marker entry keeps the timeline honest about the layering.
    if (interjected) {
      const labels = against.map((id) => this.store.getTurn(id)?.taskLabel).filter(Boolean)
      this.journal.append(botId, 'interject', {
        turnId, summary: '插话', against: labels, parallel: this.coordinator.active.size, queued: !admission.started,
      })
      const ack = admission.started
        ? `（插话收到，我边跑手上的${labels.length ? `「${labels.join('、')}」` : '进行中任务'}边处理这条。）`
        : `（插话已记好，手上的${labels.length ? `「${labels.join('、')}」` : '进行中任务'}继续跑，我空出来马上处理这条。）`
      this.outbox.emit({ botId, turnId, text: ack, interjection: true })
    }
    return {
      accepted: true, duplicate: false, turnId, botId, taskLabel,
      interjected, queued: !admission.started, position: admission.position,
      ...(thread ? { threadId: thread.id } : {}),
    }
  }

  /** Resolves when the turn next leaves `running` (waiting for approval or terminal). */
  waitForTurn(turnId) {
    const t = this.store.getTurn(turnId)
    if (!t || t.status !== 'running') return Promise.resolve(t)
    return new Promise((resolve) => this.waiters.set(turnId, resolve))
  }

  approve(approvalId, allow) {
    const a = this.getApproval(approvalId)
    if (a.status !== 'pending') return a
    const turn = this.getTurn(a.turnId)
    if (turn.status !== 'waiting_approval') throw Errors.invalid('审批状态（任务已不再等待）')
    a.status = allow ? 'approved' : 'denied'
    a.decidedAt = new Date().toISOString()
    this.store.saveApproval(a)
    this.journal.append(turn.botId, 'approval', { turnId: turn.id, approvalId, decision: a.status })
    if (!allow) {
      turn.status = 'denied'
      this.store.saveTurn(turn)
      this.#reply(turn, '好的，这一步我不做了。')
      this.#closeTask(turn.id, 'denied')
      this.parallelAtStart.delete(turn.id)
      this.#notify(turn.id)
      return a
    }
    turn.actions[a.actionIndex].approved = true
    turn.pendingApproval = null
    turn.status = 'running'
    this.store.saveTurn(turn)
    this.coordinator.request(turn.id, () => {
      const live = this.store.getTurn(turn.id)
      if (!live || TERMINAL.has(live.status) || this.interrupted.has(turn.id)) {
        this.#closeTask(turn.id, live?.status || 'interrupted')
        this.coordinator.release(turn.id)
        this.#notify(turn.id)
        return
      }
      this.#markParallel(turn.botId)
      queueMicrotask(() => this.#run(turn.id, true))
    })
    return a
  }

  interrupt(turnId) {
    return this.#interruptTurn(turnId)
  }

  /** Stopping one job stops the jobs it spawned: a group is one unit of work. */
  #interruptTurn(turnId) {
    const t = this.getTurn(turnId)
    const inFlight = this.running.has(turnId) || this.coordinator.active.has(turnId)
    this.coordinator.cancel(turnId)
    this.interrupted.add(turnId)
    if (!TERMINAL.has(t.status)) {
      t.status = 'interrupted'
      t.interruptedAt = new Date().toISOString()
      // Stopping the task also withdraws its pending approval: a card the
      // human can still click for a task that no longer runs is a trap.
      this.#withdrawApproval(t)
      this.store.saveTurn(t)
      this.journal.append(t.botId, 'interrupt', {
        turnId, taskLabel: t.taskLabel,
        summary: t.taskLabel ? `已停止「${t.taskLabel}」` : '已停止',
      })
      this.#notify(turnId)
    }
    if (!inFlight) this.#closeTask(turnId, 'interrupted')
    // A branch stopped from the outside must still wake its group up.
    if (t.parentTurnId) this.#checkGroup(t.parentTurnId)
    for (const childId of (t.childTurns || [])) this.#interruptTurn(childId)
    return this.store.getTurn(turnId)
  }

  /** Withdraw a pending approval: work that will not run must not leave a
   *  clickable "allow" card behind. */
  #withdrawApproval(turn) {
    if (!turn.pendingApproval) return
    const a = this.store.getApproval(turn.pendingApproval)
    if (a && a.status === 'pending') {
      a.status = 'denied'
      a.decidedAt = new Date().toISOString()
      this.store.saveApproval(a)
      this.journal.append(turn.botId, 'approval', {
        turnId: turn.id, approvalId: a.id, decision: 'interrupted',
      })
      this.journal.append(turn.botId, 'card/resolved', {
        cardId: a.id, actionId: 'interrupted', status: 'dismissed',
      })
    }
    turn.pendingApproval = null
  }

  /** A restart must not pretend unfinished work succeeded, and must not auto-resume. */
  recover() {
    for (const t of this.store.listTurns()) {
      if (TERMINAL.has(t.status)) continue
      t.status = 'interrupted'
      t.recovered = true
      this.#withdrawApproval(t)
      this.store.saveTurn(t)
      const timeline = this.journal.all(t.botId)
      const opened = timeline.some((e) => e.kind === 'task' && e.turnId === t.id)
      const closed = timeline.some((e) => e.kind === 'task/done' && e.turnId === t.id)
      if (opened && !closed) {
        this.journal.append(t.botId, 'task/done', {
          turnId: t.id, taskLabel: t.taskLabel, status: 'interrupted', recovered: true,
        })
      }
      this.#reply(t, '（上次进程结束时这一轮还没跑完，现场已保留；可以点下面接着做，或重新发一次。）', { recovered: true })
      if (this.cards) this.cards.offerResume(t)
    }
  }

  /** Explicitly continue an interrupted turn from its persisted step.
   *  Never automatic: a stop or a restart always waits for a human decision. */
  resume(turnId) {
    const t = this.getTurn(turnId)
    if (t.status !== 'interrupted') throw Errors.invalid('恢复状态（只有已中断的任务能接着做）')
    if (this.running.has(turnId) || this.coordinator.active.has(turnId)) {
      throw Errors.invalid('恢复状态（任务正在跑）')
    }
    const needPlan = !Array.isArray(t.actions) || t.actions.length === 0
    // A group that already split once must not split again on resume: its
    // branches may have done part of the work already.
    if (t.childTurns?.length) t.noSplit = true
    this.interrupted.delete(turnId)
    this.watchdog?.forget(turnId)
    t.status = 'running'
    t.resumedAt = new Date().toISOString()
    t.resumeCount = (t.resumeCount || 0) + 1
    t.lastProgressAt = t.resumedAt
    this.store.saveTurn(t)
    this.journal.append(t.botId, 'resume', {
      turnId, summary: '接着上次停下的一步继续', taskLabel: t.taskLabel,
      fromStep: (t.index || 0) + 1, total: (t.actions || []).length, needPlan,
    })
    this.taskOpen.add(turnId)
    this.journal.append(t.botId, 'task', {
      turnId, taskLabel: t.taskLabel, status: 'running', parallel: 1, resumed: true,
    })
    const start = () => {
      const live = this.store.getTurn(turnId)
      if (!live || TERMINAL.has(live.status) || this.interrupted.has(turnId)) {
        this.#closeTask(turnId, live?.status || 'interrupted')
        this.coordinator.release(turnId)
        this.#notify(turnId)
        return
      }
      this.#markParallel(t.botId)
      queueMicrotask(() => this.#run(turnId, !needPlan))
    }
    const admission = this.coordinator.request(turnId, start)
    return {
      accepted: true, turnId, resumed: true,
      queued: !admission.started, position: admission.position,
      fromStep: (t.index || 0) + 1, total: (t.actions || []).length,
    }
  }

  // -------------------------------------------------------------- internals

  #broadcast(msg) { for (const cb of this.listeners) { try { cb(msg) } catch { /* ignore listener errors */ } } }

  #notify(turnId) {
    const resolve = this.waiters.get(turnId)
    if (resolve) { this.waiters.delete(turnId); resolve(this.store.getTurn(turnId)) }
  }

  /** A whole overlapping batch of ONE Bot shares the observed peak. Other
   *  Bots running in the same process must not make this Bot's single task
   *  look like a parallel batch. */
  #markParallel(botId) {
    const peers = [...this.coordinator.active].filter((id) => {
      const t = this.store.getTurn(id)
      return t && t.botId === botId
    })
    const parallel = Math.max(1, peers.length)
    for (const id of peers) {
      const prev = this.parallelAtStart.get(id) || 1
      if (parallel > prev) this.parallelAtStart.set(id, parallel)
    }
    return parallel
  }

  /** Is this Bot working on something right now? Proactivity waits its turn. */
  busy(botId) { return this.#inFlightTurns(botId).length > 0 }

  /** Tasks truly executing right now for a Bot (not merely queued). Used to
   *  detect interjections: a new message layered on top of a running task. */
  #inFlightTurns(botId) {
    const ids = new Set([...this.running, ...this.coordinator.active])
    const out = []
    for (const id of ids) {
      const t = this.store.getTurn(id)
      if (t && t.botId === botId) out.push(id)
    }
    return out
  }

  /** Every outbound message — including notices — leaves through one voice. */
  #reply(turn, text, meta = {}) {
    const parallel = this.parallelAtStart.get(turn.id) || 1
    const taskLabel = parallel > 1 ? turn.taskLabel : null
    return this.outbox.emit({ botId: turn.botId, turnId: turn.id, text, taskLabel, ...meta })
  }

  /** The local files THIS Bot's execution provider may read. */
  async #catalog(botId) {
    const ex = this.executorFor(botId)
    if (typeof ex.listMaterials === 'function') {
      const files = await ex.listMaterials()
      return Array.isArray(files) ? files : []
    }
    return []
  }

  /** Plan each independently-named job on its own, so "A 并且 B" really runs
   *  in parallel even when the model forgot the branches contract. Any failure
   *  falls back to the original single-turn plan -- never worse than before. */
  async #splitByPlanning(turn, planArgs, parts) {
    const out = []
    const giveUp = (why) => {
      // Be explicit on the timeline instead of silently degrading.
      this.journal.append(turn.botId, 'activity', {
        turnId: turn.id, summary: `几件事没能拆开并行，按一件事做（${why}）`,
      })
      return null
    }
    for (const part of parts.slice(0, 3)) {
      try {
        const plan = await this.#planWithRetry(turn, { ...planArgs, text: part })
        if (this.interrupted.has(turn.id)) return null
        const acts = Array.isArray(plan) ? plan : (plan?.actions || [])
        if (!acts.length) return giveUp('规划没给出动作')
        out.push({ label: part.slice(0, 20), text: part, actions: acts })
      } catch (err) { return giveUp(String(err?.code || '模型临时不可用')) }
    }
    if (out.length < 2) return giveUp('分支不足')
    this.journal.append(turn.botId, 'activity', {
      turnId: turn.id, summary: '一句话里有几件事，系统拆开并行做',
    })
    return out
  }

  /** A weak model sometimes answers "here is the content" without ever emitting
   *  write_artifact, even when the human explicitly asked for a FILE. That is
   *  not a deliverable. Add the step ourselves; its empty body goes through the
   *  same browse -> compose -> material backstops, so nothing is invented. */
  #forceDeliverable(turn, actions) {
    const text = String(turn.text || '')
    const wantsFile = /存成|存为|保存为|保存成|生成文件|导出|存下来|写成文件|写进文件/i.test(text)
      || /(?:生成|写|整理|做成|产出)[^。；\n]{0,24}\.(?:md|markdown|txt|json|csv|log|html|py|js)\b/i.test(text)
    if (!wantsFile || actions.some((a) => a && a.kind === 'write_artifact')) return actions
    const named = text.match(/[\p{L}\p{N}._-]+\.(?:md|markdown|txt|json|csv|log|html|py|js)\b/iu)
    const filename = named ? named[0].replace(/^.*[/\\]/, '') : '结果.md'
    const out = [...actions]
    const at = out.findIndex((a) => a && a.kind === 'reply')
    const extras = []
    // Without a browse step the write-first backstop would search using the
    // whole sentence and find nothing. Point it at a real local file.
    const firstFile = turn.planArgs?.catalog?.[0]?.name
    if (firstFile) extras.push({ kind: 'browse', query: firstFile, summary: '读取本机材料' })
    extras.push({
      kind: 'write_artifact', filename, content: '', summary: '生成交付物', systemForced: true,
    })
    out.splice(at >= 0 ? at : out.length, 0, ...extras)
    this.journal.append(turn.botId, 'activity', {
      turnId: turn.id, summary: '用户要文件但模型没给写文件动作，系统补了一步',
    })
    return out
  }

  /** A reply that only says "I read it" without using the content. */
  #isHollow(text) {
    const t = String(text || '').trim()
    if (t.length > 120) return false
    // Promises instead of answers: "我来读…", "好的，我来…", "稍后给你汇总".
    return /我(先|这就去|这就|来|会|将|要)?(去|来)?(读一?下?|读取|看看|看一下|处理一下|过一遍|做一?下|总结|汇总|说明)|已(经)?读取|(正在|马上|稍后?|回头|待会|一会儿)(读取|处理|开始|给|告诉|回复|汇总|总结|说明)|^好[的，,、]?我|^ok$|^好的[。！!]?$|^稍后|^马上/.test(t)
      || /详见|参见|见上方|见下方|见\s*browse|如上述|见工具结果|见检索结果|读取成功|检索成功|查看成功/.test(t)
  }

  /** Planning is side-effect free, so a transient hiccup is safe to retry here.
   *  Step execution is deliberately NOT retried: a command or an artifact must
   *  never run twice. It is paused at the same step instead. */
  async #planWithRetry(turn, args, attempts = 3) {
    let last
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.model.plan(args)
      } catch (err) {
        if (!isTransient(err)) throw err
        last = err
        if (i < attempts - 1) {
          this.journal.append(turn.botId, 'progress', {
            turnId: turn.id, step: 0, total: 0, taskLabel: turn.taskLabel, elapsedMs: 0,
            summary: `模型临时没连上，正在重试（${i + 1}/${attempts - 1}）`,
          })
          await new Promise((r) => setTimeout(r, 400 * (i + 1)))
        }
      }
    }
    throw last
  }

  /** Keep the checkpoint and ask the human, instead of declaring the task dead. */
  #pauseAtStep(turn, err) {
    const e = err instanceof AppError ? err : Errors.agentFailed(String(err?.message || err))
    const total = (turn.actions || []).length
    const where = total ? `停在第 ${(turn.index || 0) + 1}/${total} 步` : '还没来得及规划'
    this.journal.append(turn.botId, 'error', {
      turnId: turn.id, family: e.family, code: e.code,
      title: '刚没连上模型', detail: `${where}：${e.message}`,
    })
    turn.status = 'interrupted'
    turn.pausedAt = new Date().toISOString()
    turn.error = e.toJSON()
    this.store.saveTurn(turn)
    this.#reply(turn, `（${where}，临时没连上模型；现场已保留，点「接着做」从这一步继续。）`)
    if (this.cards) this.cards.offerResume(turn, { reason: 'transient' })
    this.#notify(turn.id)
  }

  /** Pair a visible `task` row with exactly one `task/done` row. */
  #closeTask(turnId, status) {
    if (!this.taskOpen.has(turnId)) return
    this.taskOpen.delete(turnId)
    const t = this.store.getTurn(turnId)
    if (!t) return
    this.journal.append(t.botId, 'task/done', { turnId, taskLabel: t.taskLabel, status })
  }

  /** One message, several jobs. The agent splits them itself and runs the
   *  parts in parallel. The parent turn stays the coordinator: it holds no
   *  execution slot and closes once every branch has closed. */
  async #runBranches(parent, branches) {
    const limit = Math.max(2, Math.min(branches.length, this.coordinator.maxConcurrent))
    const picked = branches.slice(0, limit)
    // The parent coordinates; it must not occupy an execution slot.
    this.coordinator.release(parent.id)
    const children = picked.map((branch, i) => this.#createBranch(parent, branch, i))
    parent.childTurns = children.map((c) => c.id)
    parent.branchCount = picked.length
    this.store.saveTurn(parent)
    this.journal.append(parent.botId, 'split', {
      turnId: parent.id, taskLabel: parent.taskLabel, count: picked.length,
      labels: children.map((c) => c.taskLabel),
      summaries: picked.map((b) => b.label || b.text || '').filter(Boolean).slice(0, 3),
    })
    for (const child of children) this.#startBranch(child, picked.length)
    await this.#waitForBranches(parent.id)
    if (this.interrupted.has(parent.id)) return
    const live = this.store.getTurn(parent.id)
    if (!live || TERMINAL.has(live.status)) return
    parent.status = 'completed'
    parent.completedAt = new Date().toISOString()
    this.store.saveTurn(parent)
    this.journal.append(parent.botId, 'result', {
      turnId: parent.id, summary: `这一轮拆成 ${picked.length} 件并行推进完成`,
    })
  }

  /** A branch is a real turn: it has its own steps, approvals and checkpoint. */
  #createBranch(parent, branch, index) {
    const turnId = this.store.newId('turn')
    const child = {
      id: turnId, botId: parent.botId, status: 'running', index: 0,
      actions: branch.actions, text: branch.text || parent.text,
      taskLabel: `${parent.taskLabel}·${index + 1}`, parentTurnId: parent.id,
      branchLabel: branch.label || '', planArgs: parent.planArgs,
      secretRefs: parent.secretRefs || [], createdAt: new Date().toISOString(),
    }
    this.store.saveTurn(child)
    this.store.indexTurn(turnId)
    return child
  }

  #startBranch(child, total = 1) {
    const start = () => {
      const live = this.store.getTurn(child.id)
      if (!live || TERMINAL.has(live.status) || this.interrupted.has(child.id)) {
        this.coordinator.release(child.id)
        this.#notify(child.id)
        return
      }
      // Every branch of the group shows the same parallelism: they run together.
      const parallel = Math.max(total, this.#markParallel(child.botId))
      this.taskOpen.add(child.id)
      this.journal.append(child.botId, 'task', {
        turnId: child.id, taskLabel: child.taskLabel, status: 'running',
        parallel, branch: true, parentTurnId: child.parentTurnId,
      })
      queueMicrotask(() => this.#run(child.id, true))
    }
    return this.coordinator.request(child.id, start)
  }

  #waitForBranches(parentId) {
    return new Promise((resolve) => {
      this.groupWaiters.set(parentId, { resolve })
      // A branch may already be closed; do not wait for a group that is done.
      queueMicrotask(() => this.#checkGroup(parentId))
    })
  }

  /** A branch closed: maybe the whole group is finished. */
  #checkGroup(parentId) {
    const group = this.groupWaiters.get(parentId)
    if (!group) return
    const parent = this.store.getTurn(parentId)
    if (!parent) {
      this.groupWaiters.delete(parentId)
      group.resolve()
      return
    }
    const allClosed = (parent.childTurns || []).every((id) => {
      const t = this.store.getTurn(id)
      return !t || TERMINAL.has(t.status)
    })
    if (!allClosed) return
    this.groupWaiters.delete(parentId)
    group.resolve()
  }

  async #run(turnId, resume = false) {
    if (this.running.has(turnId)) return
    const initial = this.store.getTurn(turnId)
    if (!initial || TERMINAL.has(initial.status) || this.interrupted.has(turnId)) {
      this.#closeTask(turnId, initial?.status || 'interrupted')
      this.parallelAtStart.delete(turnId)
      this.coordinator.release(turnId)
      this.#notify(turnId)
      return
    }
    this.running.add(turnId)
    const turn = initial
    try {
      if (!resume) {
        const bot = this.getBot(turn.botId)
        let thread = null
        if (turn.threadId && this.threads) {
          thread = this.threads.recall(turn.threadId, turn.threadAfterSeq || 0, turn.threadThroughSeq)
          turn.threadRecall = thread
        }
        // One place decides what the agent knows this turn: a bounded read of
        // the timeline plus the skills the human explicitly saved.
        const ctx = buildTurnContext({
          journal: this.journal, botId: turn.botId, skills: this.skillBook.list(),
          interjection: turn.againstLabels && turn.againstLabels.length ? turn.againstLabels : null,
          text: turn.text, turns: this.store.listTurns(),
          excludeSeqs: turn.userSeq ? [turn.userSeq] : [],
          excludeTurnId: turnId, store: this.store,
        })
        const planArgs = { text: turn.text, bot, memory: ctx.recent }
        if (ctx.skills.length) planArgs.skills = ctx.skills
        if (ctx.interjection) planArgs.interjection = ctx.interjection
        if (ctx.related) planArgs.related = ctx.related
        if (ctx.openWork) planArgs.openWork = ctx.openWork
        if (ctx.priorDeliverables) planArgs.priorDeliverables = ctx.priorDeliverables
        if (thread) planArgs.thread = thread
        // Tell the model which local files it may read. Without this it either
        // invents file contents or claims it read something it never saw.
        const catalog = await this.#catalog(turn.botId)
        if (catalog.length) planArgs.catalog = catalog
        turn.planArgs = planArgs
        let plan
        try {
          plan = await this.#planWithRetry(turn, planArgs)
        } catch (err) {
          if (!isTransient(err)) throw err
          this.#pauseAtStep(turn, err)
          return
        }
        if (this.interrupted.has(turnId)) return
        const actions = Array.isArray(plan) ? plan : (plan?.actions || [])
        const branches = Array.isArray(plan?.branches) ? plan.branches : []
        // One message can hold several jobs. The agent splits them itself and
        // runs the parts in parallel instead of doing them one after another.
        if (branches.length >= 2 && !turn.noSplit) {
          await this.#runBranches(turn, branches)
          return
        }
        // The model often forgets to emit branches in a long combined prompt.
        // An explicit "并且/同时/另外/还有" is a deterministic signal, so split
        // ourselves instead of letting the whole request degrade to one turn.
        if (branches.length < 2 && !turn.noSplit && !turn.parentTurnId) {
          const parts = splitIntents(turn.text)
          if (parts.length >= 2) {
            const forced = await this.#splitByPlanning(turn, planArgs, parts)
            if (forced) {
              await this.#runBranches(turn, forced)
              return
            }
          }
        }
        const rawActions = Array.isArray(actions) && actions.length
          ? actions
          : [{ kind: 'reply', text: '（模型没有给出动作）' }]
        turn.actions = this.#forceDeliverable(turn, rawActions)
        turn.index = 0
      }
      const before = this.store.getTurn(turnId)
      if (this.interrupted.has(turnId) || before?.status === 'interrupted') return
      turn.status = 'running'
      turn.pendingApproval = null
      this.store.saveTurn(turn)

      while (turn.index < turn.actions.length) {
        const live = this.store.getTurn(turnId)
        if (this.interrupted.has(turnId) || live?.status === 'interrupted') return
        const action = turn.actions[turn.index]
        turn.step = turn.index + 1
        turn.total = turn.actions.length
        turn.stepSummary = String(action.summary || action.kind || '处理中').slice(0, 120)
        turn.startedAt ||= new Date().toISOString()
        turn.lastProgressAt = new Date().toISOString()
        this.journal.append(turn.botId, 'progress', {
          turnId, step: turn.step, total: turn.total, summary: turn.stepSummary,
          taskLabel: turn.taskLabel,
          elapsedMs: Math.max(0, Date.now() - (Date.parse(turn.startedAt) || Date.now())),
        })
        this.store.saveTurn(turn)
        if (action.requiresApproval && !action.approved) {
          const approvalId = this.store.newId('apr')
          this.store.saveApproval({
            id: approvalId, turnId, botId: turn.botId, actionIndex: turn.index,
            action, status: 'pending', createdAt: new Date().toISOString(),
          })
          this.journal.append(turn.botId, 'card', {
            turnId, cardType: 'approval', approvalId, title: '需要你确认',
            summary: action.summary || '这一步有后果', detail: action.detail || action.command || '',
          })
          turn.status = 'waiting_approval'
          turn.pendingApproval = approvalId
          this.store.saveTurn(turn)
          this.#notify(turnId)
          return
        }
        // Two-stage planning: if we just retrieved material and the model is
        // about to answer, re-plan WITH that material so the answer is grounded
        // instead of a bare "I read it".
        if (action.kind === 'reply' && turn.lastBrowse?.items?.length
          && !turn.replannedWithMaterial && !turn.lastArtifactId
          && (action.fallback || this.#isHollow(action.text))) {
          const materials = turn.lastBrowse.items
          let replanned
          try {
            replanned = await this.#planWithRetry(turn, { ...turn.planArgs, materials })
          } catch (err) {
            if (!isTransient(err)) throw err
            this.#pauseAtStep(turn, err)
            return
          }
          if (this.interrupted.has(turnId)) return
          if (Array.isArray(replanned) && replanned.length) {
            turn.actions = replanned
            turn.index = 0
            turn.replannedWithMaterial = true
            turn.total = replanned.length
            this.store.saveTurn(turn)
            continue
          }
        }
        // Last resort: the model still produced no answer, but we DID retrieve
        // real local material. Show that material (facts, not invented prose)
        // instead of sending the user away with "ask me again".
        if (action.kind === 'reply' && action.fallback && turn.lastBrowse?.items?.length) {
          const items = turn.lastBrowse.items
          action.text = '我读到了这些材料，但没能整理成答案；以下是本机读到的原文：\n\n'
            + items.map((i) => `【${i.title}】${i.truncated ? '（只看到部分）' : ''}\n${String(i.snippet || '').slice(0, 1200)}`).join('\n\n')
        }
        try {
          await this.#apply(turn, action)
        } catch (err) {
          if (!isTransient(err) || this.interrupted.has(turnId)) throw err
          // Never advance turn.index: the exact same step is replayed on resume.
          this.#pauseAtStep(turn, err)
          return
        }
        const after = this.store.getTurn(turnId)
        if (this.interrupted.has(turnId) || after?.status === 'interrupted') return
        turn.index += 1
        this.store.saveTurn(turn)
      }

      // A colleague hands work over with a sentence, not just an attachment.
      // If the model produced no answer this turn, say what was actually
      // delivered, using real lines from the file (never invented prose).
      if (turn.lastArtifactId) {
        const tail = this.journal.tail(turn.botId, 120)
        const said = tail.some((e) => e.kind === 'assistant/message'
          && e.turnId === turnId && !e.interjection && !e.nudge && !e.recovered)
        if (!said) {
          const art = [...tail].reverse().find((e) => e.kind === 'artifact' && e.turnId === turnId)
          if (art) {
            const brief = (art.preview || []).slice(0, 3).map((s) => String(s).slice(0, 24))
            this.#reply(turn, `（${art.filename} 已生成${brief.length ? `：${brief.join('、')}` : ''}；点附件看全文。）`,
              { handoff: true })
          }
        }
      }

      turn.status = 'completed'
      turn.completedAt = new Date().toISOString()
      this.store.saveTurn(turn)
      if (turn.threadId && this.threads) {
        this.threads.deliver(turn.threadId, turn.id, turn.threadRecall?.throughSeq ?? turn.threadThroughSeq)
      }
      const bot = this.getBot(turn.botId)
      // Compatibility record only. The model's context now comes from
      // buildTurnContext() reading the timeline, not from this field.
      bot.memory = [...(bot.memory || []), { at: turn.completedAt, text: turn.text.slice(0, 120) }].slice(-20)
      this.store.saveBot(bot)
      this.journal.append(turn.botId, 'result', { turnId, summary: '这一轮已完成' })
      if (this.cards) this.cards.offerForTurn(turn)
      this.#notify(turnId)
    } catch (err) {
      const e = err instanceof AppError ? err : Errors.agentFailed(err?.message || String(err))
      this.journal.append(turn.botId, 'error', {
        turnId, family: e.family, code: e.code, title: e.title, detail: e.message,
      })
      turn.status = 'failed'
      turn.error = e.toJSON()
      this.store.saveTurn(turn)
      this.#notify(turnId)
    } finally {
      this.running.delete(turnId)
      const final = this.store.getTurn(turnId)
      if (final && TERMINAL.has(final.status)) {
        this.#closeTask(turnId, final.status)
        this.parallelAtStart.delete(turnId)
        if (final.parentTurnId) this.#checkGroup(final.parentTurnId)
      }
      this.coordinator.release(turnId)
      this.watchdog?.forget(turnId)
      this.#notify(turnId)
    }
  }

  async #apply(turn, action) {
    switch (action.kind) {
      case 'activity':
        this.journal.append(turn.botId, 'activity', { turnId: turn.id, summary: action.summary })
        return
      case 'reply':
        this.#reply(turn, action.text)
        return
      case 'run_command': {
        // A model asking to "read a file" means it wants the material, not a
        // shell. Translate read-only utilities into the safer browse() path
        // instead of widening the command allowlist.
        const read = readCommandToBrowse(action.command)
        if (read) {
          const out = await this.executorFor(turn.botId).browse({ query: read.query, botId: turn.botId })
          turn.lastBrowse = out
          const live = this.store.getTurn(turn.id)
          if (live) this.store.saveTurn({ ...live, lastBrowse: out })
          this.journal.append(turn.botId, 'tool/call', {
            turnId: turn.id, name: 'browse', via: 'read-command', detail: action.command, result: out,
          })
          this.journal.append(turn.botId, 'activity', {
            turnId: turn.id, summary: action.summary || '读取材料',
            detail: out?.note || (out?.items?.length ? `命中 ${out.items.length} 处` : '没有命中'),
          })
          return
        }
        let command = String(action.command || '')
        // A generated deliverable lives in artifacts/, while commands run with
        // cwd = DATA_DIR. Two controlled bridges, both limited to files THIS
        // process generated: the explicit `@last`, and a bare filename that
        // matches the deliverable we just wrote.
        if (turn.lastArtifactId) {
          command = command.replace(/@last\b/g, `artifacts/${turn.lastArtifactId}`)
          const artifact = this.store.getArtifact(turn.lastArtifactId)
          if (artifact?.filename) {
            const bare = artifact.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            command = command.replace(new RegExp(`(?<![/\\\\w])${bare}(?![/\\\\w])`, 'g'),
              `artifacts/${turn.lastArtifactId}`)
          }
        }
        const out = await this.executorFor(turn.botId).runCommand({ command })
        this.journal.append(turn.botId, 'tool/call', {
          turnId: turn.id, name: 'run_command', detail: action.command, resolved: command, result: out,
        })
        this.journal.append(turn.botId, 'activity', {
          turnId: turn.id, summary: action.summary || '命令已执行',
          detail: `完成：${String(out.stdout || '').split('\n')[0].slice(0, 80) || '无输出'}`,
        })
        return
      }
      case 'write_artifact': {
        // A placeholder body is NOT a deliverable. Blank it so the compose and
        // material backstops below still get a chance to produce real content.
        const placeholder = isPlaceholderContent(action.content)
        let content = placeholder ? '' : String(action.content ?? '')
        let contentSource = placeholder ? 'placeholder' : 'model'
        // All browse results for THIS turn already live on the append-only
        // timeline. Reading them back means a multi-page document contributes
        // every page to the deliverable, not just the last browse. No cache,
        // no second memory: the journal stays the single context source.
        let gathered = collectTurnMaterials(this.journal.all(turn.botId), turn.id)
        let source = gathered.items
        // The model sometimes writes the file BEFORE reading. If we have no
        // material yet, fetch it now (by the task text) so the deliverable is
        // never empty.
        if (!content.trim() && !source.length && turn.planArgs?.text) {
          const out = await this.executorFor(turn.botId).browse({ query: turn.planArgs.text, botId: turn.botId })
          turn.lastBrowse = out
          const live = this.store.getTurn(turn.id)
          if (live) this.store.saveTurn({ ...live, lastBrowse: out })
          this.journal.append(turn.botId, 'tool/call', {
            turnId: turn.id, name: 'browse', via: 'write-first', detail: action.filename, result: out,
          })
          // Re-read AFTER appending, so the write-first page is included too.
          gathered = collectTurnMaterials(this.journal.all(turn.botId), turn.id)
          source = gathered.items
        }
        // Two-stage planning: hand the REAL retrieved material back to the model
        // and let it write the file body. Still a system backstop if it returns
        // nothing -- never ship an empty file, never invent facts.
        let composeBatches = 0
        let composeDegraded = false
        if (!content.trim() && source.length && typeof this.model.compose === 'function') {
          // composeUser() stops at COMPOSE_BUDGET and drops every later page.
          // Feed one bounded batch per call and join the parts in page order:
          // every call stays inside the SAME 16000 budget, no contract change.
          // A single batch reproduces the old one-call behaviour byte for byte.
          const batches = splitMaterialsForCompose(source, COMPOSE_BUDGET)
          composeBatches = batches.length
          const parts = []
          try {
            for (const batch of batches) {
              const raw = String(await this.model.compose({
                text: turn.text, materials: batch, bot: this.getBot(turn.botId),
                prior: turn.planArgs?.priorDeliverables || [],
              }) || '')
              if (!raw.trim()) throw new Error('compose batch returned no body')
              parts.push(raw)
            }
            content = parts.join('\n\n')
            if (content.trim()) contentSource = 'compose'
          } catch {
            // Never ship a half document. Fall back to the full raw material,
            // which already contains every page the model actually read.
            content = ''
            composeDegraded = batches.length > 1
          }
        }
        if (!content.trim() && source.length) {
          // Group pages by file so the title is written once and the pages
          // appear in offset order. Never invent prose: this is raw material.
          const grouped = new Map()
          for (const i of source) {
            const title = String(i.title || '材料')
            if (!grouped.has(title)) grouped.set(title, [])
            grouped.get(title).push(String(i.snippet || ''))
          }
          const body = [...grouped.entries()]
            .map(([title, pages]) => `## ${title}\n\n${pages.join('\n\n')}\n`).join('\n')
          content = `# ${action.filename || '结果'}\n\n> 由本机 materials/ 检索结果生成（模型未给出内容，系统兜底）\n\n`
            + body
            + (gathered.clipped ? '\n> 材料有界：还有后续页未纳入，请分批续读后再补。\n' : '')
          contentSource = 'material'
        }
        if (!content.trim()) {
          content = `# ${action.filename || '结果'}\n\n> 没有读到可用材料，也没有生成内容。\n`
          contentSource = 'empty'
        }
        const art = await this.executorFor(turn.botId).writeArtifact({ filename: action.filename, content })
        // Read it back: confirm what we intended to hand over is what actually
        // landed on disk, instead of assuming the write succeeded.
        const landed = this.store.readArtifactFile(art.id)
        // A custom/remote execution provider may not write through this store;
        // in that case there is nothing to compare, so say "unknown" rather
        // than raising a false integrity alarm.
        const integrity = landed === null ? null : landed === content
        const preview = previewOf(content)
        turn.lastArtifactId = art.id
        this.journal.append(turn.botId, 'artifact', {
          turnId: turn.id, artifactId: art.id, url: art.url, filename: art.filename,
          composed: Boolean(content) && !content.includes('系统兜底'),
          contentSource, integrity, bytes: content.length,
          preview, previewTruncated: preview.length >= 6,
          ...(composeBatches > 1 ? { composeBatches } : {}),
          ...(composeDegraded ? { composeDegraded: true } : {}),
        })
        if (integrity === false) {
          this.journal.append(turn.botId, 'error', {
            turnId: turn.id, family: 'agent', code: 'ARTIFACT_INTEGRITY',
            title: '交付物没能正确写入', detail: '写完后回读与预期不一致，请重新生成一次。',
          })
        }
        this.journal.append(turn.botId, 'activity', { turnId: turn.id, summary: action.summary || '交付物已生成' })
        return
      }
      case 'browse': {
        const out = await this.executorFor(turn.botId).browse({ query: action.query, botId: turn.botId })
        turn.lastBrowse = out
        const live = this.store.getTurn(turn.id)
        if (live) this.store.saveTurn({ ...live, lastBrowse: out })
        this.journal.append(turn.botId, 'tool/call', { turnId: turn.id, name: 'browse', result: out })
        this.journal.append(turn.botId, 'activity', {
          turnId: turn.id, summary: action.summary || '检索完成',
          detail: out?.note || (out?.items?.length ? `命中 ${out.items.length} 处` : '没有命中'),
        })
        return
      }
      default:
        this.journal.append(turn.botId, 'tool/call', { turnId: turn.id, name: action.kind || 'unknown' })
    }
  }
}

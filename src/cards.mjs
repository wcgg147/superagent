import { Errors } from './providers.mjs'
import { SkillBook, RoutineScheduler } from './features.mjs'

const FOLLOWUP_DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Progressive disclosure: after a turn with real work, offer exactly one typed
 * card in the conversation. Card actions flow back as recorded events carrying
 * an initiator, so the program still decides what is allowed.
 */
export class CardBook {
  constructor(engine) {
    this.engine = engine
    this.skills = new SkillBook(engine)
    this.routines = new RoutineScheduler(engine)
  }

  offerForTurn(turn) {
    if (turn.status !== 'completed') return null
    const meaningful = (turn.actions || []).some((a) => a.kind !== 'reply' && a.kind !== 'activity')
    if (!meaningful) return null
    // A system fallback reply means the question was never really answered.
    // Do not invite the user to automate a task we just failed to do.
    if ((turn.actions || []).some((a) => a.kind === 'reply' && a.fallback)) return null
    // Low-attention: never stack identical offers. One pending card per Bot;
    // if the human said "不用了", stay quiet for a day.
    const key = `followup.${turn.botId}`
    const state = this.engine.store.read(key, {})
    if (state.suppressedUntil && Date.now() < state.suppressedUntil) return null
    const timeline = this.engine.journal.all(turn.botId)
    const last = timeline.filter((e) => e.kind === 'card' && e.cardType === 'followup-offer').at(-1)
    if (last && !timeline.some((e) => e.kind === 'card/resolved' && e.cardId === last.cardId)) return null
    const id = this.engine.store.newId('crd')
    this.engine.store.write(`card.${id}`, {
      id, botId: turn.botId, sourceTurnId: turn.id, cardType: 'followup-offer',
      createdAt: new Date().toISOString(),
    })
    return this.engine.journal.append(turn.botId, 'card', {
      cardId: id, cardType: 'followup-offer', turnId: turn.id, sourceTurnId: turn.id,
      title: '要不要把这件事变成常规？',
      summary: '存成技能，或让它定时自动跑一次；不感兴趣直接忽略。',
      actions: [
        { id: 'save-skill', label: '存成技能' },
        { id: 'save-routine', label: '每小时自动跑' },
        { id: 'dismiss', label: '不用了' },
      ],
      initiator: 'agent',
    })
  }

  /** A proactively noticed event becomes a card in the timeline, never a background log. */
  offerObservation(item) {
    const id = this.engine.store.newId('crd')
    this.engine.store.write(`card.${id}`, {
      id, botId: item.botId, cardType: 'observation-offer',
      observationId: item.id, text: item.text, source: item.source,
      createdAt: new Date().toISOString(),
    })
    return this.engine.journal.append(item.botId, 'card', {
      cardId: id, cardType: 'observation-offer', observationId: item.id,
      title: '它注意到一件可能值得做的事',
      summary: `来自 ${item.source}：${item.text.slice(0, 120)}`,
      actions: [
        { id: 'delegate', label: '交给它' },
        { id: 'dismiss', label: '不用了' },
      ],
      initiator: 'agent',
    })
  }

  /** One card per pending chain, no matter how many events it contains. */
  offerThread(thread) {
    const id = this.engine.store.newId('crd')
    this.engine.store.write(`card.${id}`, {
      id, botId: thread.botId, cardType: 'thread-offer', threadId: thread.id,
      createdAt: new Date().toISOString(),
    })
    return this.engine.journal.append(thread.botId, 'card', {
      cardId: id, cardType: 'thread-offer', threadId: thread.id,
      title: '这几件事是连着的',
      summary: `${thread.source} / ${thread.entity}：同一条线索上的新进展会串在一起，交给它时只补看新增的。`,
      actions: [
        { id: 'delegate', label: '交给它' },
        { id: 'dismiss', label: '不用了' },
      ],
      initiator: 'agent',
    })
  }

  /** It comes back on its own: something it left hanging was never answered. */
  offerNudge({ botId, title, summary, sourceTurnId, sourceCardId, sourceCardType }) {
    const id = this.engine.store.newId('crd')
    this.engine.store.write(`card.${id}`, {
      id, botId, sourceTurnId: sourceTurnId || null, cardType: 'nudge-offer',
      sourceCardId: sourceCardId || null, sourceCardType: sourceCardType || null,
      createdAt: new Date().toISOString(),
    })
    const actions = sourceCardType === 'observation-offer'
      ? [{ id: 'delegate', label: '交给它' }, { id: 'dismiss', label: '先放着' }]
      : [{ id: 'resume', label: '接着做' }, { id: 'dismiss', label: '先放着' }]
    return this.engine.journal.append(botId, 'card', {
      cardId: id, cardType: 'nudge-offer', turnId: sourceTurnId || null,
      sourceTurnId: sourceTurnId || null, title, summary, actions, initiator: 'agent',
    })
  }

  /** A restart must not auto-resume: one card asks the human instead. */
  offerResume(turn, { reason } = {}) {
    const transient = reason === 'transient'
    const total = (turn.actions || []).length
    const where = total ? `停在第 ${(turn.index || 0) + 1}/${total} 步` : '还没来得及规划'
    const label = turn.taskLabel || '这件事'
    const id = this.engine.store.newId('crd')
    this.engine.store.write(`card.${id}`, {
      id, botId: turn.botId, cardType: 'resume-offer', turnId: turn.id,
      createdAt: new Date().toISOString(),
    })
    return this.engine.journal.append(turn.botId, 'card', {
      cardId: id, cardType: 'resume-offer', turnId: turn.id,
      title: transient ? '这一步刚没连上模型' : '上次有件事没做完',
      summary: transient
        ? `「${label}」${where}，前面的结果都还在；要接着做吗？`
        : `「${label}」${where}；现场还在，要接着做吗？`,
      actions: [
        { id: 'resume', label: '接着做' },
        { id: 'dismiss', label: '算了' },
      ],
      initiator: 'agent',
    })
  }

  /** Stalled step: offer a decision, never auto-kill the turn. */
  offerWatchdog(turn, idleMs) {
    const id = this.engine.store.newId('crd')
    this.engine.store.write(`card.${id}`, {
      id, botId: turn.botId, cardType: 'watchdog', turnId: turn.id,
      createdAt: new Date().toISOString(),
    })
    return this.engine.journal.append(turn.botId, 'card', {
      cardId: id, cardType: 'watchdog', turnId: turn.id,
      title: '这一步好像卡住了',
      summary: `「${turn.taskLabel || '这件事'}」第 ${turn.step}/${turn.total} 步已 ${Math.round(idleMs / 1000)}s 没有进展；要停掉还是继续等？`,
      actions: [
        { id: 'stop', label: '停掉' },
        { id: 'wait', label: '继续等' },
      ],
      initiator: 'watchdog',
    })
  }

  get(cardId) {
    const meta = this.engine.store.read(`card.${cardId}`, null)
    if (!meta) throw Errors.notFound('卡片')
    const entries = this.engine.journal.all(meta.botId)
    const card = entries.find((e) => e.kind === 'card' && e.cardId === cardId) || null
    const resolution = entries.find((e) => e.kind === 'card/resolved' && e.cardId === cardId) || null
    return { ...meta, card, status: resolution ? resolution.status : 'pending', resolution }
  }

  resolve(cardId, actionId) {
    const info = this.get(cardId)
    if (info.status !== 'pending') return info
    const allowedByType = {
      'observation-offer': ['delegate', 'dismiss'],
      'thread-offer': ['delegate', 'dismiss'],
      watchdog: ['stop', 'wait'],
      'resume-offer': ['resume', 'dismiss'],
      'nudge-offer': ['resume', 'delegate', 'dismiss'],
    }
    const allowed = allowedByType[info.cardType] || ['save-skill', 'save-routine', 'dismiss']
    if (!allowed.includes(actionId)) throw Errors.invalid('卡片动作')
    let result = null
    let resultKind = 'skill'
    if (info.cardType === 'thread-offer') {
      const threads = this.engine.threads
      if (!threads) throw Errors.invalid('线索（未启用）')
      const thread = threads.get(info.threadId)
      if (actionId === 'delegate') {
        const summary = threads.pending(thread.id).map((ev, i) => `${i + 1}) ${ev.text}`).join('；')
        result = this.engine.sendMessage({
          botId: info.botId, text: `接续线索「${thread.title}」：${summary}`,
          threadId: thread.id, clientNonce: `card:${cardId}`,
        })
        threads.beginDelegation(thread.id)
        resultKind = 'turn'
      } else {
        threads.close(thread.id)
        resultKind = 'none'
      }
    } else if (info.cardType === 'observation-offer') {
      if (actionId === 'delegate') {
        result = this.engine.sendMessage({
          botId: info.botId, text: info.text, clientNonce: `card:${cardId}`,
        })
        resultKind = 'turn'
      } else resultKind = 'none'
    } else if (info.cardType === 'watchdog') {
      if (actionId === 'stop') {
        result = this.engine.interrupt(info.turnId)
        resultKind = 'interrupt'
      } else resultKind = 'none'
    } else if (info.cardType === 'resume-offer') {
      if (actionId === 'resume') {
        result = this.engine.resume(info.turnId)
        resultKind = 'resume'
      } else resultKind = 'none'
    } else if (info.cardType === 'nudge-offer') {
      // A nudge points back at the thing that was left hanging.
      if (actionId === 'resume' && info.sourceTurnId) {
        result = this.engine.resume(info.sourceTurnId)
        resultKind = 'resume'
      } else if (actionId === 'delegate' && info.sourceCardId) {
        const source = this.get(info.sourceCardId)
        result = this.engine.sendMessage({
          botId: info.botId, text: source.card?.detail || source.card?.summary || '',
          clientNonce: `nudge:${info.id}`,
        })
        resultKind = 'turn'
      } else resultKind = 'none'
    } else {
      const source = this.engine.getTurn(info.sourceTurnId)
      if (actionId === 'save-skill') {
        result = this.skills.fromTurn(info.sourceTurnId, { name: `技能 ${info.sourceTurnId.slice(-4)}` })
      } else if (actionId === 'save-routine') {
        result = this.routines.create({
          botId: info.botId, name: '每小时重复', instruction: source.text,
          trigger: { type: 'interval', everyMs: 3600000 },
        })
        resultKind = 'routine'
      } else resultKind = 'none'
    }
    const status = actionId === 'dismiss' || actionId === 'wait' ? 'dismissed' : 'saved'
    if (info.cardType === 'followup-offer' && actionId === 'dismiss') {
      const key = `followup.${info.botId}`
      const state = this.engine.store.read(key, {})
      state.suppressedUntil = Date.now() + FOLLOWUP_DISMISS_COOLDOWN_MS
      this.engine.store.write(key, state)
    }
    this.engine.journal.append(info.botId, 'card/resolved', {
      cardId, actionId, status, resultId: result?.id || result?.turnId || null,
      resultKind, initiator: 'card_action',
    })
    return { ...info, status, result, resultKind }
  }
}

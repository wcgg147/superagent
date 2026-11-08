import { Errors } from './providers.mjs'

/** P1: turn a successful task into a reusable instruction set. */
export class SkillBook {
  constructor(engine) { this.engine = engine }

  #key(id) { return `skill.${id}` }
  #index() { return this.engine.store.read('skillIndex', {}) }

  list() {
    return Object.keys(this.#index())
      .map((id) => this.engine.store.read(this.#key(id), null))
      .filter(Boolean)
  }

  get(id) {
    const skill = this.engine.store.read(this.#key(id), null)
    if (!skill) throw Errors.notFound('技能')
    return skill
  }

  save({ name, description, instruction, sourceTurnId }) {
    if (typeof name !== 'string' || !name.trim()) throw Errors.invalid('技能名称')
    const id = this.engine.store.newId('skl')
    const skill = {
      id, name: name.trim(), description: String(description || ''),
      instruction: String(instruction || ''), sourceTurnId: sourceTurnId || null,
      createdAt: new Date().toISOString(), uses: 0,
    }
    this.engine.store.write(this.#key(id), skill)
    const index = this.#index()
    index[id] = true
    this.engine.store.write('skillIndex', index)
    return skill
  }

  fromTurn(turnId, { name, description } = {}) {
    const turn = this.engine.getTurn(turnId)
    if (turn.status !== 'completed') throw Errors.invalid('来源任务（必须已完成）')
    const steps = (turn.actions || [])
      .filter((a) => a.kind !== 'reply')
      .map((a) => `- ${a.kind}: ${a.summary || a.filename || a.command || ''}`)
    const instruction = `按以下步骤完成任务：\n${steps.join('\n') || '- 直接完成用户的请求'}`
    return this.save({ name: name || `技能 ${turnId.slice(-4)}`, description, instruction, sourceTurnId: turnId })
  }

  run(id, { botId, input, clientNonce } = {}) {
    const skill = this.get(id)
    skill.uses = (skill.uses || 0) + 1
    this.engine.store.write(this.#key(id), skill)
    return this.engine.sendMessage({
      botId, text: `${skill.instruction}\n\n本次输入：${input || ''}`, clientNonce,
    })
  }
}

/** P1: control-plane scheduler. Routines survive executor restarts by design. */
export class RoutineScheduler {
  constructor(engine) { this.engine = engine; this.timer = null }

  #key(id) { return `routine.${id}` }
  #index() { return this.engine.store.read('routineIndex', {}) }

  list() {
    return Object.keys(this.#index())
      .map((id) => this.engine.store.read(this.#key(id), null))
      .filter(Boolean)
  }

  get(id) {
    const r = this.engine.store.read(this.#key(id), null)
    if (!r) throw Errors.notFound('自动化')
    return r
  }

  create({ botId, name, instruction, trigger } = {}) {
    if (!botId || typeof name !== 'string' || !name.trim() || typeof instruction !== 'string' || !instruction.trim()) {
      throw Errors.invalid('自动化参数')
    }
    this.engine.getBot(botId)
    const t = trigger || { type: 'interval', everyMs: 60000 }
    if (t.type === 'interval' && (!Number.isFinite(t.everyMs) || t.everyMs < 15000)) {
      throw Errors.invalid('interval（不得小于 15 秒）')
    }
    if (t.type !== 'interval' && t.type !== 'event') throw Errors.invalid('trigger.type')
    if (t.type === 'event' && !t.source && !t.phrase) {
      throw Errors.invalid('事件触发的 source 或 phrase（不允许宽监听）')
    }
    const id = this.engine.store.newId('rtn')
    const routine = {
      id, botId, name: name.trim(), instruction: instruction.trim(), trigger: t,
      enabled: true, createdAt: new Date().toISOString(), lastRunAt: null, runCount: 0,
    }
    this.engine.store.write(this.#key(id), routine)
    const index = this.#index()
    index[id] = true
    this.engine.store.write('routineIndex', index)
    return routine
  }

  setEnabled(id, enabled) {
    const r = this.get(id)
    r.enabled = enabled === true
    this.engine.store.write(this.#key(id), r)
    return r
  }

  remove(id) {
    this.get(id)
    const index = this.#index()
    delete index[id]
    this.engine.store.write('routineIndex', index)
    return { removed: id }
  }

  fire(id, { reason = 'manual' } = {}) {
    const r = this.get(id)
    if (!r.enabled && reason !== 'test') throw Errors.invalid('自动化（已停用）')
    r.lastRunAt = new Date().toISOString()
    r.runCount = (r.runCount || 0) + 1
    this.engine.store.write(this.#key(id), r)
    return this.engine.sendMessage({
      botId: r.botId, text: r.instruction,
      clientNonce: `routine:${r.id}:${r.runCount}`,
    })
  }

  /** Narrow event matching: a broad "every message" listener is deliberately not supported. */
  ingest({ source, text } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw Errors.invalid('事件内容')
    const matched = this.list().filter((r) => {
      const t = r.trigger || {}
      if (!r.enabled || t.type !== 'event') return false
      if (t.source && t.source !== source) return false
      if (t.phrase && !text.includes(t.phrase)) return false
      return true
    })
    return matched.map((r) => ({ routineId: r.id, ...this.fire(r.id, { reason: 'event' }) }))
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      const now = Date.now()
      for (const r of this.list()) {
        const t = r.trigger || {}
        if (!r.enabled || t.type !== 'interval') continue
        const last = r.lastRunAt ? Date.parse(r.lastRunAt) : 0
        if (now - last < t.everyMs) continue
        try { this.fire(r.id, { reason: 'schedule' }) } catch { /* keep scheduler alive */ }
      }
    }, 5000)
    this.timer.unref?.()
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null } }
}

/** P1 minimal: a Room is a Bot whose messages fan out to member Bots; @ narrows targets. */
export class RoomHub {
  constructor(engine) { this.engine = engine }

  list() { return this.engine.listBots().filter((b) => b.kind === 'room') }
  bots() { return this.engine.listBots().filter((b) => b.kind !== 'room') }

  get(id) {
    const b = this.engine.getBot(id)
    if (b.kind !== 'room') throw Errors.notFound('群聊')
    return b
  }

  create({ name, memberIds } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw Errors.invalid('群聊名称')
    const members = (Array.isArray(memberIds) ? memberIds : []).filter((id) => {
      try { const b = this.engine.getBot(id); return b.kind !== 'room' } catch { return false }
    })
    if (!members.length) throw Errors.invalid('成员（至少需要一个 Bot）')
    const room = {
      id: this.engine.store.newId('room'), name: name.trim(), job: '', kind: 'room',
      members, createdAt: new Date().toISOString(), memory: [],
    }
    this.engine.store.saveBot(room)
    this.engine.journal.append(room.id, 'system', { text: `群聊「${room.name}」已创建，成员 ${members.length} 个。` })
    return room
  }

  send({ roomId, text, mentions, clientNonce } = {}) {
    const room = this.get(roomId)
    if (typeof text !== 'string' || !text.trim()) throw Errors.invalid('消息内容')
    const targets = (Array.isArray(mentions) && mentions.length)
      ? mentions.filter((id) => room.members.includes(id))
      : room.members
    if (!targets.length) throw Errors.invalid('@ 成员（不在群内）')
    const results = targets.map((botId, i) => this.engine.sendMessage({
      botId, text, clientNonce: clientNonce ? `${clientNonce}:${i}` : undefined,
    }))
    this.engine.journal.append(room.id, 'user/message', {
      text, mentions: targets, turnIds: results.map((r) => r.turnId),
    })
    return { accepted: true, roomId, targets, turnIds: results.map((r) => r.turnId) }
  }
}

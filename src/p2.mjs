import { createHash, randomUUID } from 'node:crypto'
import { AppError, Errors, Family } from './providers.mjs'

const dayKey = () => new Date().toISOString().slice(0, 10)
const sha = (value) => createHash('sha256').update(String(value)).digest('hex')

/** P2: teams own a daily turn quota. A Bot without a team is unmetered. */
export class TeamBook {
  constructor(engine) { this.engine = engine }

  #index() { return this.engine.store.read('teamIndex', {}) }

  list() {
    return Object.keys(this.#index())
      .map((id) => this.engine.store.read(`team.${id}`, null))
      .filter(Boolean)
  }

  get(id) {
    const team = this.engine.store.read(`team.${id}`, null)
    if (!team) throw Errors.notFound('团队')
    return team
  }

  create({ name, quotaPerDay = 0 } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw Errors.invalid('团队名称')
    const limit = Number(quotaPerDay)
    if (!Number.isFinite(limit) || limit < 0) throw Errors.invalid('每日额度')
    const id = this.engine.store.newId('team')
    const team = { id, name: name.trim(), quotaPerDay: limit, createdAt: new Date().toISOString() }
    this.engine.store.write(`team.${id}`, team)
    const index = this.#index()
    index[id] = true
    this.engine.store.write('teamIndex', index)
    return team
  }

  assignBot(botId, teamId) {
    this.get(teamId)
    const bot = this.engine.getBot(botId)
    bot.teamId = teamId
    this.engine.store.saveBot(bot)
    return bot
  }

  usage() {
    const day = dayKey()
    return this.list().map((team) => ({
      ...team,
      usedToday: this.engine.store.read(`quota.${team.id}.${day}`, 0),
    }))
  }
}

/** Enforced before a message is accepted, so a channel cannot bypass it. */
export class QuotaBook {
  constructor(engine) { this.engine = engine; this.teams = new TeamBook(engine) }

  checkAndConsume(botId) {
    const bot = this.engine.getBot(botId)
    if (!bot.teamId) return null
    const team = this.teams.get(bot.teamId)
    if (!team.quotaPerDay) return null
    const key = `quota.${team.id}.${dayKey()}`
    const used = this.engine.store.read(key, 0)
    if (used >= team.quotaPerDay) throw Errors.usageLimit()
    this.engine.store.write(key, used + 1)
    return { teamId: team.id, used: used + 1, limit: team.quotaPerDay }
  }

  status() {
    return {
      day: dayKey(),
      teams: this.teams.usage(),
      unlimitedBots: this.engine.listBots().filter((b) => !b.teamId).length,
    }
  }
}

/**
 * P2: a named inbound channel. Tokens are stored as hashes, returned once at
 * creation, and every call is audited so an operator can see what can command a Bot.
 */
export class ChannelBook {
  constructor(engine) { this.engine = engine }

  #index() { return this.engine.store.read('channelIndex', {}) }

  list() {
    return Object.keys(this.#index()).map((id) => {
      const channel = this.engine.store.read(`channel.${id}`, null)
      if (!channel) return null
      const { tokenHash, ...safe } = channel
      return safe
    }).filter(Boolean)
  }

  get(id) {
    if (!this.#index()[id]) throw Errors.notFound('渠道')
    const channel = this.engine.store.read(`channel.${id}`, null)
    if (!channel) throw Errors.notFound('渠道')
    return channel
  }

  create({ name, kind = 'webhook', botId, phrase = '' } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw Errors.invalid('渠道名称')
    this.engine.getBot(botId)
    if (!['webhook', 'slack', 'email'].includes(kind)) throw Errors.invalid('渠道类型')
    const id = this.engine.store.newId('chn')
    const token = `ch_${randomUUID().replace(/-/g, '')}`
    const channel = {
      id, name: name.trim(), kind, botId, phrase: String(phrase || '').trim(),
      tokenHash: sha(token), enabled: true, createdAt: new Date().toISOString(),
      calls: 0, lastUsedAt: null,
    }
    this.engine.store.write(`channel.${id}`, channel)
    const index = this.#index()
    index[id] = true
    this.engine.store.write('channelIndex', index)
    const { tokenHash, ...safe } = channel
    return { ...safe, token }
  }

  setEnabled(id, enabled) {
    const channel = this.get(id)
    channel.enabled = enabled === true
    this.engine.store.write(`channel.${id}`, channel)
    const { tokenHash, ...safe } = channel
    return safe
  }

  revoke(id) {
    this.get(id)
    const index = this.#index()
    delete index[id]
    this.engine.store.write('channelIndex', index)
    return { revoked: id }
  }

  #audit(entry) {
    const all = this.engine.store.read('channelAudit', [])
    all.unshift(entry)
    this.engine.store.write('channelAudit', all.slice(0, 100))
  }

  audit(id) {
    this.get(id)
    return { items: this.engine.store.read('channelAudit', []).filter((e) => e.channelId === id) }
  }

  ingest(id, { token, source = 'external', text = '' } = {}) {
    const channel = this.get(id)
    if (!channel.enabled) {
      throw new AppError(Family.ENTITLEMENT, 'CHANNEL_DISABLED', '渠道已停用', '启用后再投递', 403)
    }
    if (!token || sha(token) !== channel.tokenHash) {
      throw new AppError(Family.ENTITLEMENT, 'CHANNEL_TOKEN_INVALID', '渠道凭证无效', '请使用该渠道创建时返回的 token', 401)
    }
    if (typeof text !== 'string' || !text.trim()) throw Errors.invalid('事件内容')

    const matched = !channel.phrase || text.includes(channel.phrase)
    const at = new Date().toISOString()
    const entry = {
      channelId: id, at, source: String(source), matched, chars: text.length, turnId: null,
    }
    channel.calls += 1
    channel.lastUsedAt = at
    this.engine.store.write(`channel.${id}`, channel)
    try {
      if (matched) {
        const result = this.engine.sendMessage({
          botId: channel.botId, text, clientNonce: `channel:${id}:${channel.calls}`,
        })
        entry.turnId = result.turnId
      }
    } catch (err) {
      entry.error = err.code || 'AGENT_FAILED'
      this.#audit(entry)
      throw err
    }
    this.#audit(entry)
    return { accepted: true, channelId: id, matched, fired: entry.turnId ? [entry.turnId] : [] }
  }
}

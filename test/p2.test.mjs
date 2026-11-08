import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel } from '../src/providers.mjs'
import { TeamBook, QuotaBook, ChannelBook } from '../src/p2.mjs'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-p2-'))
  const engine = new Engine({ dataDir: dir, model: new MockModel() })
  const teams = new TeamBook(engine)
  const quota = new QuotaBook(engine)
  engine.quota = quota
  const channels = new ChannelBook(engine)
  return { dir, engine, teams, quota, channels }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('未加入团队的 Bot 不计量；加入后按每日额度扣减并给出明确标题', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '甲' })
  const first = ctx.engine.sendMessage({ botId: bot.id, text: '你好' })
  await ctx.engine.waitForTurn(first.turnId)
  assert.equal(ctx.quota.status().unlimitedBots, 1)

  const team = ctx.teams.create({ name: '小队', quotaPerDay: 1 })
  ctx.teams.assignBot(bot.id, team.id)
  const second = ctx.engine.sendMessage({ botId: bot.id, text: '再一句' })
  await ctx.engine.waitForTurn(second.turnId)
  assert.equal(ctx.quota.status().teams[0].usedToday, 1)

  assert.throws(
    () => ctx.engine.sendMessage({ botId: bot.id, text: '第三句' }),
    (e) => e.family === 'entitlement' && e.code === 'USAGE_LIMIT' && e.title.includes('用量'),
  )
  assert.equal(ctx.quota.status().teams[0].usedToday, 1, '超额请求不扣额度')
})

test('额度为 0 表示不限', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '甲' })
  const team = ctx.teams.create({ name: '不限队', quotaPerDay: 0 })
  ctx.teams.assignBot(bot.id, team.id)
  for (let i = 0; i < 3; i += 1) {
    const r = ctx.engine.sendMessage({ botId: bot.id, text: `第${i}句` })
    await ctx.engine.waitForTurn(r.turnId)
  }
  assert.equal(ctx.quota.status().teams[0].usedToday, 0)
})

test('渠道：token 只在创建时返回、列表不含哈希、错误凭证被拒', (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '甲' })
  const created = ctx.channels.create({ name: 'GitHub', kind: 'webhook', botId: bot.id, phrase: 'needs repro' })
  assert.match(created.token, /^ch_/)
  assert.ok(!('tokenHash' in created))
  assert.ok(!('tokenHash' in ctx.channels.list()[0]))
  assert.throws(
    () => ctx.channels.ingest(created.id, { token: 'wrong', text: 'needs repro' }),
    (e) => e.code === 'CHANNEL_TOKEN_INVALID' && e.status === 401,
  )
})

test('渠道：窄匹配命中才指挥 Bot，每次调用都有审计', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '甲' })
  const created = ctx.channels.create({ name: 'GitHub', botId: bot.id, phrase: 'needs repro' })
  const miss = ctx.channels.ingest(created.id, { token: created.token, text: '普通讨论' })
  assert.equal(miss.matched, false)
  assert.equal(miss.fired.length, 0)
  const hit = ctx.channels.ingest(created.id, { token: created.token, source: 'github', text: '#1 needs repro' })
  assert.equal(hit.matched, true)
  assert.equal(hit.fired.length, 1)
  await ctx.engine.waitForTurn(hit.fired[0])
  const audit = ctx.channels.audit(created.id)
  assert.equal(audit.items.length, 2)
  assert.ok(audit.items.some((e) => e.matched && e.turnId))
  assert.ok(audit.items.every((e) => !('token' in e)))
})

test('渠道：停用与撤销都可立即生效', (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '甲' })
  const created = ctx.channels.create({ name: 'Webhook', botId: bot.id })
  ctx.channels.setEnabled(created.id, false)
  assert.throws(
    () => ctx.channels.ingest(created.id, { token: created.token, text: 'hi' }),
    (e) => e.code === 'CHANNEL_DISABLED' && e.status === 403,
  )
  assert.equal(ctx.channels.revoke(created.id).revoked, created.id)
  assert.throws(
    () => ctx.channels.ingest(created.id, { token: created.token, text: 'hi' }),
    (e) => e.status === 404,
  )
  assert.equal(ctx.channels.list().length, 0)
  assert.throws(() => ctx.channels.audit(created.id), (e) => e.status === 404)
})

test('渠道不能绕过团队额度，失败也写审计', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '甲' })
  const team = ctx.teams.create({ name: '小队', quotaPerDay: 1 })
  ctx.teams.assignBot(bot.id, team.id)
  const created = ctx.channels.create({ name: 'Webhook', botId: bot.id })
  const ok = ctx.channels.ingest(created.id, { token: created.token, text: '第一条' })
  await ctx.engine.waitForTurn(ok.fired[0])
  assert.throws(
    () => ctx.channels.ingest(created.id, { token: created.token, text: '第二条' }),
    (e) => e.code === 'USAGE_LIMIT' && e.family === 'entitlement',
  )
  const audit = ctx.channels.audit(created.id)
  assert.equal(audit.items.length, 2)
  assert.ok(audit.items.some((e) => e.error === 'USAGE_LIMIT'))
})

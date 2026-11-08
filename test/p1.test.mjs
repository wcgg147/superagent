import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel } from '../src/providers.mjs'
import { SkillBook, RoutineScheduler, RoomHub } from '../src/features.mjs'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-p1-'))
  return {
    dir,
    engine: new Engine({ dataDir: dir, model: new MockModel() }),
    skills: null, routines: null, rooms: null,
  }
}

function attach(ctx) {
  ctx.skills = new SkillBook(ctx.engine)
  ctx.routines = new RoutineScheduler(ctx.engine)
  ctx.rooms = new RoomHub(ctx.engine)
  return ctx
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('Skill：从已完成任务保存，并能在新输入上复用', async (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '小助手' })
  const { turnId } = ctx.engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await ctx.engine.waitForTurn(turnId)
  const skill = ctx.skills.fromTurn(turnId, { name: '周报流程', description: '从任务轨迹生成' })
  assert.match(skill.instruction, /write_artifact/)
  assert.equal(skill.sourceTurnId, turnId)
  assert.equal(ctx.skills.list().length, 1)
  const run = ctx.skills.run(skill.id, { botId: bot.id, input: '本周内容' })
  await ctx.engine.waitForTurn(run.turnId)
  assert.equal(ctx.skills.get(skill.id).uses, 1)
  assert.ok(ctx.engine.journal.all(bot.id).some((e) => e.kind === 'user/message' && e.text.includes('按以下步骤完成任务')))
})

test('Skill：未完成的任务不能存成技能', async (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '小助手' })
  const { turnId } = ctx.engine.sendMessage({ botId: bot.id, text: '执行命令 `node --version`' })
  await ctx.engine.waitForTurn(turnId)
  assert.throws(() => ctx.skills.fromTurn(turnId, { name: 'x' }), (e) => e.family === 'transport')
})

test('Routine：停用后不触发，test 仍可手动跑；状态持久化', async (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '小助手' })
  const r = ctx.routines.create({
    botId: bot.id, name: '每日汇总', instruction: '生成今日汇总',
    trigger: { type: 'interval', everyMs: 60000 },
  })
  const fired = ctx.routines.fire(r.id)
  await ctx.engine.waitForTurn(fired.turnId)
  assert.equal(ctx.routines.get(r.id).runCount, 1)
  ctx.routines.setEnabled(r.id, false)
  assert.throws(() => ctx.routines.fire(r.id), (e) => e.family === 'transport')
  const manual = ctx.routines.fire(r.id, { reason: 'test' })
  await ctx.engine.waitForTurn(manual.turnId)
  assert.equal(ctx.routines.get(r.id).runCount, 2)
  const restarted = new RoutineScheduler(new Engine({ dataDir: ctx.dir, model: new MockModel() }))
  assert.equal(restarted.get(r.id).enabled, false, '调度状态在控制面，不随进程丢失')
})

test('Routine：窄匹配事件才触发，宽泛消息不打扰', async (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '小助手' })
  ctx.routines.create({
    botId: bot.id, name: '缺陷复现', instruction: '复现这个缺陷',
    trigger: { type: 'event', source: 'github', phrase: 'needs repro' },
  })
  const none = ctx.routines.ingest({ source: 'github', text: '普通讨论，没有关键词' })
  assert.equal(none.length, 0)
  const wrongSource = ctx.routines.ingest({ source: 'slack', text: 'needs repro' })
  assert.equal(wrongSource.length, 0)
  const hit = ctx.routines.ingest({ source: 'github', text: '#12 needs repro，请看一下' })
  assert.equal(hit.length, 1)
  await ctx.engine.waitForTurn(hit[0].turnId)
  assert.ok(ctx.engine.journal.all(bot.id).some((e) => e.kind === 'user/message' && e.text.includes('复现这个缺陷')))
})

test('Room：消息扇出给成员，@ 只唤醒被指定的 Bot', async (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const a = ctx.engine.createBot({ name: '甲' })
  const b = ctx.engine.createBot({ name: '乙' })
  const room = ctx.rooms.create({ name: '协作群', memberIds: [a.id, b.id] })
  assert.equal(ctx.rooms.list().length, 1)

  const all = ctx.rooms.send({ roomId: room.id, text: '大家好' })
  assert.equal(all.targets.length, 2)
  await Promise.all(all.turnIds.map((id) => ctx.engine.waitForTurn(id)))
  assert.equal(ctx.engine.journal.all(a.id).filter((e) => e.kind === 'user/message').length, 1)
  assert.equal(ctx.engine.journal.all(b.id).filter((e) => e.kind === 'user/message').length, 1)

  const mention = ctx.rooms.send({ roomId: room.id, text: '@甲 交给你', mentions: [a.id] })
  assert.deepEqual(mention.targets, [a.id])
  await Promise.all(mention.turnIds.map((id) => ctx.engine.waitForTurn(id)))
  assert.equal(ctx.engine.journal.all(b.id).filter((e) => e.kind === 'user/message').length, 1, '未被 @ 的 Bot 不应被唤醒')
  assert.ok(ctx.engine.journal.all(room.id).some((e) => e.kind === 'user/message' && e.mentions?.length === 1))
})

test('Room：空成员或群外 @ 被拒绝', (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const a = ctx.engine.createBot({ name: '甲' })
  assert.throws(() => ctx.rooms.create({ name: '空群', memberIds: [] }), (e) => e.family === 'transport')
  const room = ctx.rooms.create({ name: '协作群', memberIds: [a.id] })
  assert.throws(
    () => ctx.rooms.send({ roomId: room.id, text: 'hi', mentions: ['bot_nope'] }),
    (e) => e.family === 'transport',
  )
})

test('Routine：拒绝没有 source/phrase 的宽监听', (t) => {
  const ctx = attach(make())
  t.after(() => cleanup(ctx.dir))
  const bot = ctx.engine.createBot({ name: '小助手' })
  assert.throws(
    () => ctx.routines.create({ botId: bot.id, name: 'x', instruction: 'y', trigger: { type: 'event' } }),
    (e) => e.family === 'transport',
  )
})

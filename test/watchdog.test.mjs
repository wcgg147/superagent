import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { CardBook } from '../src/cards.mjs'
import { Watchdog } from '../src/watchdog.mjs'

function gate() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, release: () => resolve() }
}

const ACTIONS = () => [
  { kind: 'activity', summary: '第一步' },
  { kind: 'browse', query: 'q', summary: '第二步' },
  { kind: 'reply', text: '好了' },
]

function make({ maxConcurrent = 1, planGate = null, browseGates = null, heartbeatMs = 1000, stallMs = 2000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-watch-'))
  const rec = { plan: 0, browse: 0 }
  const model = {
    name: 'scripted',
    async plan() {
      rec.plan += 1
      if (planGate && rec.plan === 1) await planGate.promise
      return ACTIONS()
    },
  }
  const executor = {
    name: 'counting',
    capabilities: () => ['terminal', 'file', 'headless_browser', 'artifact'],
    async browse() {
      rec.browse += 1
      if (browseGates) {
        const g = gate()
        browseGates.push(g)
        await g.promise
      }
      return { items: [] }
    },
    async runCommand() { return { stdout: 'ok' } },
    async writeArtifact() { return { id: 'art_x', url: '/api/artifacts/art_x', filename: 'x' } },
  }
  const engine = new Engine({ dataDir: dir, model, executor, maxConcurrent })
  engine.cards = new CardBook(engine)
  const watchdog = new Watchdog(engine, { intervalMs: 999999, heartbeatMs, stallMs })
  engine.watchdog = watchdog
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, bot, rec, watchdog, planGate, browseGates }
}

async function cleanup(ctx) {
  ctx.planGate?.release()
  for (let i = 0; i < 40; i++) {
    for (const g of ctx.browseGates || []) g.release()
    if (ctx.engine.running.size === 0) break
    await tick(10)
  }
  ctx.watchdog.stop()
  rmSync(ctx.dir, { recursive: true, force: true })
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
const all = (ctx, engine) => (engine || ctx.engine).journal.all(ctx.bot.id)
const of = (ctx, kind, engine) => all(ctx, engine).filter((e) => e.kind === kind)
const send = (ctx, text = '做一件事') => ctx.engine.sendMessage({ botId: ctx.bot.id, text })

function seedTurn(ctx, id, status = 'interrupted') {
  ctx.engine.store.saveTurn({
    id, botId: ctx.bot.id, status, index: 1,
    actions: ACTIONS(), text: 'x', taskLabel: `任务 ${id}`,
    createdAt: new Date().toISOString(),
  })
  ctx.engine.store.indexTurn(id)
}

test('每一步都写 progress：step/total/summary/elapsedMs 与 turnId 可追溯', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const { turnId } = send(ctx)
  const done = await ctx.engine.waitForTurn(turnId)
  assert.equal(done.status, 'completed')
  const progress = of(ctx, 'progress')
  assert.deepEqual(progress.map((e) => e.step), [1, 2, 3])
  assert.deepEqual(progress.map((e) => e.total), [3, 3, 3])
  assert.ok(progress.every((e) => e.turnId === turnId && e.summary && Number.isFinite(e.elapsedMs)))
  const turn = ctx.engine.getTurn(turnId)
  assert.equal(turn.step, 3)
  assert.equal(turn.total, 3)
  assert.ok(turn.startedAt && turn.lastProgressAt)
  assert.equal(of(ctx, 'task').length, 1)
  assert.equal(of(ctx, 'task/done').length, 1)
})

test('plan 尚未返回时中断，状态不会被覆盖回 running', async (t) => {
  const planGate = gate()
  const ctx = make({ planGate })
  t.after(() => cleanup(ctx))
  const { turnId } = send(ctx)
  await tick()
  ctx.engine.interrupt(turnId)
  planGate.release()
  await tick(30)
  assert.equal(ctx.engine.getTurn(turnId).status, 'interrupted')
  assert.equal(ctx.engine.capabilities().concurrency.active, 0)
  assert.equal(of(ctx, 'task/done').length, 1)
  assert.equal(of(ctx, 'progress').length, 0, '没进入执行就不写步骤进度')
})

test('中断后显式 resume：不重新规划、不重跑已完成步骤，从持久化 index 续跑', async (t) => {
  const browseGates = []
  const ctx = make({ browseGates })
  t.after(() => cleanup(ctx))
  const { turnId } = send(ctx)
  for (let i = 0; i < 40 && browseGates.length === 0; i++) await tick(5)
  assert.ok(of(ctx, 'progress').some((e) => e.step === 2), '已经进入第二步')

  ctx.engine.interrupt(turnId)
  browseGates[0].release()
  await tick(30)
  const stopped = ctx.engine.getTurn(turnId)
  assert.equal(stopped.status, 'interrupted')
  assert.equal(stopped.index, 1, '现场停在第二部之前')

  const resumed = ctx.engine.resume(turnId)
  assert.equal(resumed.fromStep, 2)
  assert.equal(resumed.total, 3)
  for (let i = 0; i < 30; i++) {
    for (const g of browseGates) g.release()
    if (ctx.engine.getTurn(turnId).status === 'completed') break
    await tick(10)
  }
  const done = await ctx.engine.waitForTurn(turnId)
  assert.equal(done.status, 'completed')
  assert.equal(ctx.rec.plan, 1, 'resume 不重新调用模型规划')
  assert.equal(of(ctx, 'progress').filter((e) => e.step === 1).length, 1, '已完成的第一步不重跑')
  assert.equal(of(ctx, 'progress').filter((e) => e.step === 2).length, 2, '中断那一步按至少一次语义重做')
  assert.equal(of(ctx, 'resume').length, 1)
  assert.equal(of(ctx, 'task').length, 2)
  assert.equal(of(ctx, 'task/done').length, 2, '恢复后仍严格配对')
  assert.equal(ctx.engine.getTurn(turnId).resumeCount, 1)
})

test('plan 都没跑完就中断：resume 会重新规划', async (t) => {
  const planGate = gate()
  const ctx = make({ planGate })
  t.after(() => cleanup(ctx))
  const { turnId } = send(ctx)
  await tick()
  ctx.engine.interrupt(turnId)
  planGate.release()
  await tick(30)
  assert.deepEqual(ctx.engine.getTurn(turnId).actions, [])
  const resumed = ctx.engine.resume(turnId)
  assert.equal(resumed.total, 0)
  const done = await ctx.engine.waitForTurn(turnId)
  assert.equal(done.status, 'completed')
  assert.equal(ctx.rec.plan, 2)
})

test('resume 同样受并发槽位约束，不会绕过上限', async (t) => {
  const browseGates = []
  const ctx = make({ maxConcurrent: 1, browseGates })
  t.after(() => cleanup(ctx))
  seedTurn(ctx, 'turn_a1')
  seedTurn(ctx, 'turn_b1')
  const a = ctx.engine.resume('turn_a1')
  const b = ctx.engine.resume('turn_b1')
  assert.equal(a.queued, false)
  assert.equal(b.queued, true)
  assert.equal(b.position, 1)
  assert.equal(ctx.engine.capabilities().concurrency.active, 1)
  assert.equal(ctx.engine.capabilities().concurrency.queued, 1)
  assert.throws(() => ctx.engine.resume('turn_a1'), (e) => e.family === 'transport')
  for (let i = 0; i < 30; i++) {
    for (const g of browseGates) g.release()
    if (ctx.engine.getTurn('turn_a1').status === 'completed' && ctx.engine.getTurn('turn_b1').status === 'completed') break
    await tick(10)
  }
  assert.equal(ctx.engine.getTurn('turn_a1').status, 'completed')
  assert.equal(ctx.engine.getTurn('turn_b1').status, 'completed')
  assert.equal(ctx.engine.capabilities().concurrency.active, 0)
  assert.equal(ctx.engine.capabilities().concurrency.queued, 0)
})

test('重启不自动恢复：出一张 resume-offer 卡片，点「接着做」才续跑', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  seedTurn(ctx, 'turn_pend1', 'running')
  const restarted = new Engine({
    dataDir: ctx.dir,
    model: { name: 'stub', async plan() { return ACTIONS() } },
    executor: ctx.engine.executorFor(ctx.bot.id),
  })
  restarted.cards = new CardBook(restarted)
  restarted.watchdog = new Watchdog(restarted, { intervalMs: 999999 })
  restarted.recover()
  assert.equal(restarted.getTurn('turn_pend1').status, 'interrupted')
  assert.ok(all(ctx, restarted).some((e) => e.recovered))
  const card = of(ctx, 'card', restarted).find((e) => e.cardType === 'resume-offer')
  assert.ok(card)
  assert.deepEqual(card.actions.map((a) => a.id), ['resume', 'dismiss'])
  const acted = restarted.cards.resolve(card.cardId, 'resume')
  assert.equal(acted.status, 'saved')
  assert.equal(acted.resultKind, 'resume')
  assert.equal(acted.result.fromStep, 2)
  assert.equal(restarted.getTurn('turn_pend1').status, 'running')
  await restarted.waitForTurn('turn_pend1')
  assert.equal(restarted.getTurn('turn_pend1').status, 'completed')
  restarted.watchdog.stop()
})

test('轻量 Watchdog：停滞只提示一次、出卡片、绝不自动中断', async (t) => {
  const browseGates = []
  const ctx = make({ browseGates, heartbeatMs: 10, stallMs: 20 })
  t.after(() => cleanup(ctx))
  const { turnId } = send(ctx)
  for (let i = 0; i < 40 && browseGates.length === 0; i++) await tick(5)
  const turn = ctx.engine.getTurn(turnId)
  turn.lastProgressAt = new Date(Date.now() - 60000).toISOString()
  ctx.engine.store.saveTurn(turn)

  const first = ctx.watchdog.tick(Date.now())
  assert.equal(first.inspected, 1)
  assert.equal(first.alerts, 1)
  assert.equal(ctx.engine.getTurn(turnId).status, 'running', 'watchdog 不能自己停任务')
  assert.ok(of(ctx, 'watchdog').some((e) => e.level === 'heartbeat'))
  const card = of(ctx, 'card').find((e) => e.cardType === 'watchdog')
  assert.ok(card)
  assert.deepEqual(card.actions.map((a) => a.id), ['stop', 'wait'])

  const second = ctx.watchdog.tick(Date.now())
  assert.equal(second.alerts, 0, '同一轮只提示一次，不刷屏')
  assert.equal(of(ctx, 'card').filter((e) => e.cardType === 'watchdog').length, 1)

  const acted = ctx.engine.cards.resolve(card.cardId, 'stop')
  assert.equal(acted.resultKind, 'interrupt')
  assert.equal(ctx.engine.getTurn(turnId).status, 'interrupted')
})

test('Watchdog 不巡检排队/未开始/已完成的 turn；start/stop 可控', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  assert.equal(ctx.watchdog.tick(Date.now()).inspected, 0)
  const { turnId } = send(ctx)
  await ctx.engine.waitForTurn(turnId)
  assert.equal(ctx.watchdog.tick(Date.now()).inspected, 0, '已完成的任务不再巡检')
  ctx.watchdog.start()
  assert.equal(ctx.watchdog.status().running, true)
  ctx.watchdog.stop()
  assert.equal(ctx.watchdog.status().running, false)
  assert.equal(ctx.watchdog.status().watching, 0)
})

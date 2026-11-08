import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'

function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-multibot-')) }
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

function make({ model } = {}) {
  const dir = tmp()
  const engine = new Engine({ dataDir: dir, model })
  mkdirSync(join(dir, 'materials'), { recursive: true })
  writeFileSync(join(dir, 'materials', 'shared.md'), '共享材料\n', 'utf8')
  return { dir, engine }
}

test('不同 Bot 同时各跑一件，互不把对方标成并行', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const model = {
    name: 'gate',
    async plan() { await gate; return [{ kind: 'reply', text: '做完了' }] },
  }
  const { dir, engine } = make({ model })
  t.after(() => cleanup(dir))
  const a = engine.createBot({ name: '甲' })
  const b = engine.createBot({ name: '乙' })

  const ra = engine.sendMessage({ botId: a.id, text: '甲的事' })
  const rb = engine.sendMessage({ botId: b.id, text: '乙的事' })
  // Both turns are in the GLOBAL coordinator at once.
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(engine.capabilities().concurrency.active, 2, '两个 Bot 确实同时在飞')
  release()
  await Promise.all([engine.waitForTurn(ra.turnId), engine.waitForTurn(rb.turnId)])

  for (const [label, bot] of [['甲', a], ['乙', b]]) {
    const items = engine.journal.all(bot.id)
    const tasks = items.filter((e) => e.kind === 'task')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].parallel, 1, `${label} 的单任务不该被别的 Bot 标成并行`)
    const replies = items.filter((e) => e.kind === 'assistant/message')
    assert.ok(replies.length >= 1)
    assert.ok(replies.every((r) => !r.taskLabel), `${label} 的回复不该误带 taskLabel`)
  }
})

test('同一 Bot 的两件事仍标为并行（没有被过度隔离）', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const model = {
    name: 'gate',
    async plan() { await gate; return [{ kind: 'reply', text: '做完了' }] },
  }
  const { dir, engine } = make({ model })
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '甲' })
  const a = engine.sendMessage({ botId: bot.id, text: '第一件' })
  const b = engine.sendMessage({ botId: bot.id, text: '第二件' })
  await new Promise((r) => setTimeout(r, 20))
  release()
  await Promise.all([engine.waitForTurn(a.turnId), engine.waitForTurn(b.turnId)])

  const items = engine.journal.all(bot.id)
  const tasks = items.filter((e) => e.kind === 'task')
  assert.equal(tasks.length, 2)
  assert.ok(tasks.some((x) => x.parallel === 2), '至少第二件事标为并行')
  // The batch peak is remembered for replies, even for the first turn that
  // started before the second one arrived.
  const replies = items.filter((e) => e.kind === 'assistant/message' && !e.interjection)
  assert.ok(replies.length >= 2)
  assert.ok(replies.every((r) => r.taskLabel), '同一个 Bot 的两件事，回复都要带 taskLabel')
})

test('#catalog 用当前 turn 的 Bot 执行面，而不是列表里第一个 Bot', async (t) => {
  const saved = process.env.EXECUTOR_PROVIDER
  process.env.EXECUTOR_PROVIDER = 'gray'
  t.after(() => {
    if (saved === undefined) delete process.env.EXECUTOR_PROVIDER
    else process.env.EXECUTOR_PROVIDER = saved
  })
  const plans = []
  const model = {
    name: 'capture',
    async plan(args) { plans.push(args); return [{ kind: 'reply', text: 'ok' }] },
  }
  const { dir, engine } = make({ model })
  t.after(() => cleanup(dir))
  assert.ok(engine.dshExecutor, 'gray 模式应创建 DSH 执行面')
  assert.equal(typeof engine.dshExecutor.listMaterials, 'function',
    'DSH 执行面也要实现完整的 ExecutorProvider 接口')
  const defaultCatalog = await engine.dshExecutor.listMaterials()
  assert.ok(defaultCatalog.some((f) => f.name === 'shared.md'), '默认实现应列得出本地材料')
  // Per-provider marker: proves #catalog uses THIS turn's bot, not listBots()[0].
  engine.dshExecutor.listMaterials = async () => [{ name: 'dsh-only.md' }]

  const localBot = engine.createBot({ name: '用本地' })
  const dshBot = engine.createBot({ name: '用DSH' })
  engine.setBotExecutor(dshBot.id, 'dsh')

  const r1 = engine.sendMessage({ botId: localBot.id, text: '本地的事' })
  await engine.waitForTurn(r1.turnId)
  const r2 = engine.sendMessage({ botId: dshBot.id, text: 'DSH 的事' })
  await engine.waitForTurn(r2.turnId)

  const localCatalog = (plans[0].catalog || []).map((f) => f.name)
  const dshCatalog = (plans[1].catalog || []).map((f) => f.name)
  assert.ok(localCatalog.includes('shared.md'), '本地 Bot 应看到共享材料')
  assert.ok(!localCatalog.includes('dsh-only.md'))
  assert.ok(dshCatalog.includes('dsh-only.md'), 'DSH Bot 必须用自己执行面的材料清单')
})

test('B 的上下文召回不会捞到 A 的历史', async (t) => {
  const model = {
    name: 'capture',
    async plan() { return [{ kind: 'reply', text: 'ok' }] },
  }
  const { dir, engine } = make({ model })
  t.after(() => cleanup(dir))
  const a = engine.createBot({ name: '甲' })
  const b = engine.createBot({ name: '乙' })
  const r1 = engine.sendMessage({ botId: a.id, text: '读一下 alpha.md 的启动命令' })
  await engine.waitForTurn(r1.turnId)
  const r2 = engine.sendMessage({ botId: b.id, text: 'alpha.md 那件事怎么样了' })
  await engine.waitForTurn(r2.turnId)

  const planB = engine.getTurn(r2.turnId).planArgs || {}
  const joined = JSON.stringify(planB.related || [])
  assert.equal(planB.related, undefined, 'B 从未读过 alpha.md，不该召回 A 的历史')
  assert.ok(!joined.includes('alpha'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel } from '../src/providers.mjs'

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }
function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-interject-')) }

function make({ model, maxConcurrent } = {}) {
  const dir = tmp()
  const engine = new Engine({ dataDir: dir, model: model || new MockModel(), maxConcurrent })
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, bot }
}

// ---------------------------------------------------------------- parallel

test('插话不终止在跑任务：并行继续跑、标 interjected、写 interject 节点与确认', async (t) => {
  const { dir, engine, bot } = make({ model: new MockModel() })
  t.after(() => cleanup(dir))
  // Send B immediately after A, before any await, so A is in flight when B is accepted.
  const a = engine.sendMessage({ botId: bot.id, text: '做件长事' })
  const b = engine.sendMessage({ botId: bot.id, text: '插一句：帮我查天气' })
  assert.equal(b.interjected, true, '第二条应被识别为插话')
  assert.equal(b.queued, false, '默认 3 并发下应与在跑任务并行')
  await engine.waitForTurn(a.turnId)
  await engine.waitForTurn(b.turnId)

  assert.equal(engine.getTurn(a.turnId).status, 'completed', '在跑任务必须不被杀')
  assert.equal(engine.getTurn(b.turnId).status, 'completed')
  assert.equal(engine.getTurn(b.turnId).interjected, true)

  const entries = engine.journal.all(bot.id)
  assert.ok(entries.some((e) => e.kind === 'interject' && e.turnId === b.turnId), '应有 interject 时间线节点')
  const ack = entries.find((e) => e.kind === 'assistant/message' && e.interjection === true)
  assert.ok(ack, '应有插话确认气泡')
  assert.match(ack.text, /插话|边跑|继续跑/)
  assert.equal(entries.filter((e) => e.kind === 'interrupt').length, 0, '不能有中断记录')
})

// ---------------------------------------------------------------- queued

test('插话排队：槽满时排队、在跑任务继续、确认说排队', async (t) => {
  const { dir, engine, bot } = make({ model: new MockModel(), maxConcurrent: 1 })
  t.after(() => cleanup(dir))
  const a = engine.sendMessage({ botId: bot.id, text: '做件长事' })
  const b = engine.sendMessage({ botId: bot.id, text: '插一句：查天气' })
  assert.equal(b.interjected, true)
  assert.equal(b.queued, true, '单槽下应排队')

  await engine.waitForTurn(a.turnId)
  await engine.waitForTurn(b.turnId)
  assert.equal(engine.getTurn(a.turnId).status, 'completed')
  assert.equal(engine.getTurn(b.turnId).status, 'completed')

  const interject = engine.journal.all(bot.id).find((e) => e.kind === 'interject' && e.turnId === b.turnId)
  assert.ok(interject)
  assert.equal(interject.queued, true)
  const ack = engine.journal.all(bot.id).find((e) => e.kind === 'assistant/message' && e.interjection === true)
  assert.match(ack.text, /空出来|排队|继续跑/)
})

// ---------------------------------------------------------------- context

test('插话规划上下文携带在飞任务标签，弱模型也别替它收尾', async (t) => {
  const plans = []
  const model = {
    name: 'stub',
    async plan(args) { plans.push(args); return [{ kind: 'reply', text: 'ok' }] },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  const a = engine.sendMessage({ botId: bot.id, text: '做件长事' })
  const b = engine.sendMessage({ botId: bot.id, text: '查天气' })
  assert.equal(b.interjected, true)

  await engine.waitForTurn(a.turnId)
  await engine.waitForTurn(b.turnId)
  const bPlan = plans.find((p) => p.text === '查天气')
  assert.ok(bPlan, '应捕获 B 的规划输入')
  assert.deepEqual(bPlan.interjection, [engine.getTurn(a.turnId).taskLabel])
})

// ---------------------------------------------------------------- no-op

test('没有在跑任务时，首条消息不是插话、无 interject 节点', async (t) => {
  const { dir, engine, bot } = make({ model: new MockModel() })
  t.after(() => cleanup(dir))
  const a = engine.sendMessage({ botId: bot.id, text: '做件事' })
  assert.equal(a.interjected, false)
  await engine.waitForTurn(a.turnId)
  const entries = engine.journal.all(bot.id)
  assert.equal(entries.filter((e) => e.kind === 'interject').length, 0)
  assert.equal(entries.filter((e) => e.kind === 'assistant/message' && e.interjection).length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'

/**
 * One Bot, many turns. `wait:` turns block inside model.plan until released;
 * `approve:` turns stop at an approval gate. Gates are pre-created so a release
 * may safely happen before the turn is admitted.
 */
function scriptedModel() {
  const gates = new Map()
  const started = []
  function gate(text) {
    if (!gates.has(text)) {
      let resolve
      const promise = new Promise((r) => { resolve = r })
      gates.set(text, { promise, resolve })
    }
    return gates.get(text)
  }
  return {
    name: 'scripted',
    started,
    async plan({ text }) {
      started.push(text)
      if (text.startsWith('wait:')) await gate(text).promise
      if (text.startsWith('approve:')) {
        return [
          { kind: 'activity', summary: `需要确认 ${text}`, requiresApproval: true },
          { kind: 'reply', text: `完成 ${text}` },
        ]
      }
      return [{ kind: 'reply', text: `回复 ${text}` }]
    },
    release(text) { gate(text).resolve() },
    releaseAll() { for (const g of gates.values()) g.resolve() },
  }
}

function make({ model = scriptedModel(), maxConcurrent = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-conc-'))
  const engine = new Engine({ dataDir: dir, model, maxConcurrent })
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, bot, model }
}

async function cleanup(ctx) {
  ctx.model.releaseAll()
  for (let i = 0; i < 40; i++) {
    const s = status(ctx)
    if (s.active + s.queued === 0) break
    await tick(10)
  }
  await tick(10)
  rmSync(ctx.dir, { recursive: true, force: true })
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms))
const send = (ctx, text) => ctx.engine.sendMessage({ botId: ctx.bot.id, text })
const entries = (ctx, kind) => ctx.engine.journal.all(ctx.bot.id).filter((e) => e.kind === kind)
const status = (ctx) => ctx.engine.capabilities().concurrency

test('硬并发上限：超出的 turn 排队，槽位释放后自动补位', async (t) => {
  const ctx = make({ maxConcurrent: 2 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'wait:A')
  const b = send(ctx, 'wait:B')
  const c = send(ctx, 'wait:C')
  const d = send(ctx, 'wait:D')
  assert.equal(a.queued, false)
  assert.equal(b.queued, false)
  assert.equal(c.queued, true)
  assert.equal(c.position, 1)
  assert.equal(d.queued, true)
  assert.equal(d.position, 2)
  assert.equal(status(ctx).maxConcurrent, 2)

  await tick()
  assert.deepEqual(ctx.model.started, ['wait:A', 'wait:B'], '只有两个 turn 真正开跑')
  assert.equal(status(ctx).active, 2)
  assert.equal(status(ctx).queued, 2)
  assert.equal(entries(ctx, 'task').length, 2, '排队的 turn 不先写时间线')

  ctx.model.release('wait:B')
  await ctx.engine.waitForTurn(b.turnId)
  await tick()
  assert.ok(ctx.model.started.includes('wait:C'), '空出的槽位立刻推进排队项')
  assert.equal(status(ctx).active, 2)

  for (const text of ['wait:A', 'wait:C', 'wait:D']) ctx.model.release(text)
  await Promise.all([a, b, c, d].map((r) => ctx.engine.waitForTurn(r.turnId)))
  const st = status(ctx)
  assert.equal(st.active, 0)
  assert.equal(st.queued, 0)
  assert.equal(st.peak, 2)
  assert.equal(st.started, 4)
  assert.deepEqual([a, b, c, d].map((r) => ctx.engine.getTurn(r.turnId).status),
    ['completed', 'completed', 'completed', 'completed'])

  const starts = entries(ctx, 'task')
  const dones = entries(ctx, 'task/done')
  assert.equal(starts.length, 4)
  assert.equal(dones.length, 4, '每个开始行都有且只有一个结束行')
  assert.equal(new Set(dones.map((e) => e.turnId)).size, 4)
})

test('并行互不阻塞，且所有回复只从统一出口发出', async (t) => {
  const ctx = make({ maxConcurrent: 2 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'wait:A')
  const b = send(ctx, 'wait:B')
  await tick()
  assert.deepEqual(ctx.model.started, ['wait:A', 'wait:B'])

  ctx.model.release('wait:B')
  const doneB = await ctx.engine.waitForTurn(b.turnId)
  assert.equal(doneB.status, 'completed')
  assert.equal(ctx.engine.getTurn(a.turnId).status, 'running', 'B 完成不能把 A 也结束掉')

  const replies = entries(ctx, 'assistant/message').filter((e) => !e.interjection)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].turnId, b.turnId)
  assert.equal(replies[0].viaOutbox, true)
  assert.equal(replies[0].taskLabel, b.taskLabel, '并行回复标注来自哪件事')
  assert.equal(ctx.engine.outbox.emitted, 2, '统一出口：真实回复 + 插话确认')

  ctx.model.release('wait:A')
  await ctx.engine.waitForTurn(a.turnId)
  const all = entries(ctx, 'assistant/message').filter((e) => !e.interjection)
  assert.equal(all.length, 2)
  assert.ok(all.every((e) => e.viaOutbox === true && e.turnId))
  assert.deepEqual(new Set(all.map((e) => e.taskLabel)), new Set([a.taskLabel, b.taskLabel]),
    '同一批重叠任务里，先启动的那条也带标签')
  const starts = entries(ctx, 'task')
  const dones = entries(ctx, 'task/done')
  assert.equal(starts.length, 2)
  assert.equal(dones.length, 2)
})

test('maxConcurrent=1 严格串行：不并发、不加任务标签、峰值 1', async (t) => {
  const ctx = make({ maxConcurrent: 1 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'wait:A')
  const b = send(ctx, 'wait:B')
  const c = send(ctx, 'wait:C')
  await tick()
  assert.equal(status(ctx).active, 1)
  assert.equal(status(ctx).queued, 2)
  assert.deepEqual(ctx.model.started, ['wait:A'])
  for (const text of ['wait:A', 'wait:B', 'wait:C']) ctx.model.release(text)
  await Promise.all([a, b, c].map((r) => ctx.engine.waitForTurn(r.turnId)))
  assert.equal(status(ctx).peak, 1)
  assert.deepEqual(ctx.model.started, ['wait:A', 'wait:B', 'wait:C'])
  assert.ok(entries(ctx, 'task').every((e) => e.parallel === 1))
  assert.ok(entries(ctx, 'assistant/message').every((e) => !e.taskLabel))
  assert.equal(entries(ctx, 'task/done').length, 3)
})

test('中断排队中的 turn：撤销排队、不占槽、不写悬空任务行', async (t) => {
  const ctx = make({ maxConcurrent: 1 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'wait:A')
  const b = send(ctx, 'wait:B')
  const c = send(ctx, 'wait:C')
  await tick()
  assert.equal(status(ctx).queued, 2)

  ctx.engine.interrupt(b.turnId)
  assert.equal(ctx.engine.getTurn(b.turnId).status, 'interrupted')
  assert.equal(status(ctx).queued, 1, '被中断的排队项立刻出队')
  assert.equal(entries(ctx, 'task').some((e) => e.turnId === b.turnId), false)
  const interrupts = entries(ctx, 'interrupt')
  assert.equal(interrupts.length, 1)
  assert.equal(interrupts[0].taskLabel, b.taskLabel, '中断要说清停的是哪一件')
  assert.match(interrupts[0].summary, /任务/)

  ctx.model.release('wait:A')
  await ctx.engine.waitForTurn(a.turnId)
  await tick()
  assert.ok(ctx.model.started.includes('wait:C'))
  assert.equal(ctx.model.started.includes('wait:B'), false, '被中断的排队项永不执行')
  ctx.model.release('wait:C')
  await ctx.engine.waitForTurn(c.turnId)

  assert.equal(status(ctx).active, 0)
  assert.equal(status(ctx).queued, 0)
  const starts = entries(ctx, 'task')
  const dones = entries(ctx, 'task/done')
  assert.equal(starts.length, 2)
  assert.equal(dones.length, 2)
  assert.ok(starts.every((s) => dones.some((d) => d.turnId === s.turnId)))
})

test('审批期间释放槽位；批准后恢复仍带任务标签，拒绝也配对结束行', async (t) => {
  const ctx = make({ maxConcurrent: 2 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'approve:A')
  const b = send(ctx, 'approve:B')
  const cards = []
  for (const r of [a, b]) {
    const waiting = await ctx.engine.waitForTurn(r.turnId)
    assert.equal(waiting.status, 'waiting_approval')
    cards.push(entries(ctx, 'card').find((e) => e.turnId === r.turnId))
  }
  assert.equal(status(ctx).active, 0, '等人确认时不占并发槽')
  assert.equal(entries(ctx, 'task').length, 2)
  assert.equal(entries(ctx, 'task/done').length, 0)

  ctx.engine.approve(cards[0].approvalId, true)
  await ctx.engine.waitForTurn(a.turnId)
  ctx.engine.approve(cards[1].approvalId, true)
  await ctx.engine.waitForTurn(b.turnId)
  assert.equal(ctx.engine.getTurn(a.turnId).status, 'completed')
  assert.equal(ctx.engine.getTurn(b.turnId).status, 'completed')
  assert.equal(status(ctx).active, 0)
  assert.equal(entries(ctx, 'task/done').length, 2)
  const replies = entries(ctx, 'assistant/message').filter((e) => !e.interjection)
  assert.equal(replies.length, 2)
  assert.ok(replies.every((e) => e.viaOutbox === true && e.taskLabel),
    '恢复后的回复仍从统一出口发出并标注任务')

  const c = send(ctx, 'approve:C')
  await ctx.engine.waitForTurn(c.turnId)
  const cardC = entries(ctx, 'card').find((e) => e.turnId === c.turnId)
  ctx.engine.approve(cardC.approvalId, false)
  assert.equal(ctx.engine.getTurn(c.turnId).status, 'denied')
  const doneC = entries(ctx, 'task/done').find((e) => e.turnId === c.turnId)
  assert.equal(doneC?.status, 'denied', '拒绝审批也要关闭任务行')
  assert.ok(entries(ctx, 'assistant/message').some((e) => e.turnId === c.turnId && e.viaOutbox === true))
  assert.equal(status(ctx).active, 0)
  assert.equal(status(ctx).queued, 0)
})

test('中断等待审批的 turn：补结束行，后续任务仍能拿到槽位', async (t) => {
  const ctx = make({ maxConcurrent: 1 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'approve:A')
  const waiting = await ctx.engine.waitForTurn(a.turnId)
  assert.equal(waiting.status, 'waiting_approval')
  assert.equal(status(ctx).active, 0)

  ctx.engine.interrupt(a.turnId)
  const dones = entries(ctx, 'task/done')
  assert.equal(dones.length, 1)
  assert.equal(dones[0].status, 'interrupted')

  const b = send(ctx, 'B')
  await ctx.engine.waitForTurn(b.turnId)
  assert.equal(ctx.engine.getTurn(b.turnId).status, 'completed')
  assert.equal(status(ctx).active, 0)
  assert.equal(status(ctx).queued, 0)
  assert.equal(entries(ctx, 'task/done').length, 2)
})

test('恢复通知与拒绝答复也走统一出口；transcript 里没有裸 assistant/message', async (t) => {
  const ctx = make({ maxConcurrent: 2 })
  t.after(() => cleanup(ctx))
  const a = send(ctx, 'approve:A')
  await ctx.engine.waitForTurn(a.turnId)
  const card = entries(ctx, 'card').find((e) => e.turnId === a.turnId)
  ctx.engine.approve(card.approvalId, false)

  ctx.engine.store.saveTurn({
    id: 'turn_recover1', botId: ctx.bot.id, status: 'running', index: 0,
    actions: [], text: 'x', taskLabel: '任务 9',
  })
  ctx.engine.store.indexTurn('turn_recover1')
  ctx.engine.recover()

  const all = ctx.engine.journal.all(ctx.bot.id)
  assert.ok(all.every((e) => e.kind !== 'assistant/message' || e.viaOutbox === true))
  const recovered = all.find((e) => e.recovered)
  assert.equal(recovered?.viaOutbox, true)
  assert.equal(recovered?.turnId, 'turn_recover1')
  assert.equal(ctx.engine.getTurn('turn_recover1').status, 'interrupted')
})

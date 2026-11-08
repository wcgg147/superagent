import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { CardBook } from '../src/cards.mjs'
import { ThreadBook } from '../src/threads.mjs'
import { MockModel, DeepSeekModel } from '../src/providers.mjs'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-thread-'))
  const engine = new Engine({ dataDir: dir, model: new MockModel(), maxConcurrent: 3 })
  engine.cards = new CardBook(engine)
  engine.threads = new ThreadBook(engine)
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, bot }
}

function cleanup(ctx) { rmSync(ctx.dir, { recursive: true, force: true }) }
const all = (ctx) => ctx.engine.journal.all(ctx.bot.id)
const of = (ctx, kind, extra = {}) => all(ctx).filter((e) => e.kind === kind
  && Object.entries(extra).every(([k, v]) => e[k] === v))
const ingest = (ctx, text, extra = {}) => ctx.engine.threads.ingest({
  botId: ctx.bot.id, source: 'github', entity: 'issue/12', text, ...extra,
})

test('程序侧稳定分组：同一 source+entity 串成一条，不同实体独立', (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const b = ingest(ctx, '复现步骤已补齐')
  assert.equal(a.threadId, b.threadId)
  assert.equal(ThreadBook.key({ botId: ctx.bot.id, source: 'github', entity: 'issue/12' }), a.threadId)
  const other = ingest(ctx, '另一个 issue', { entity: 'issue/13' })
  assert.notEqual(other.threadId, a.threadId)
  assert.equal(ctx.engine.threads.list().length, 2)
  assert.equal(ctx.engine.threads.status().events, 3)
})

test('多个相关事件只出一张卡片、不自动派 turn；重复事件不再写时间线', (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const b = ingest(ctx, '复现步骤已补齐')
  const c = ingest(ctx, '维护者回复了')
  assert.equal(a.offered, true)
  assert.equal(b.coalesced, true)
  assert.equal(c.coalesced, true)
  assert.equal(of(ctx, 'card', { cardType: 'thread-offer' }).length, 1)
  assert.equal(of(ctx, 'thread/event').length, 3)
  assert.equal(of(ctx, 'user/message').length, 0, '观察不等于执行')

  const dup = ingest(ctx, '维护者回复了')
  assert.equal(dup.duplicate, true)
  assert.equal(of(ctx, 'thread/event').length, 3)
  const events = of(ctx, 'thread/event')
  assert.deepEqual(events.map((e) => e.count), [1, 2, 3])
  assert.deepEqual(events.map((e) => e.coalesced), [false, true, true])
  assert.equal(ctx.engine.threads.recall(a.threadId, 0).items.length, 3)
})

test('点「交给它」只派一个 turn，并把整条链作为增量召回交给模型', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const b = ingest(ctx, '复现步骤已补齐')
  const card = of(ctx, 'card', { cardType: 'thread-offer' })[0]
  assert.deepEqual(card.actions.map((x) => x.id), ['delegate', 'dismiss'])

  const acted = ctx.engine.cards.resolve(card.cardId, 'delegate')
  assert.equal(acted.status, 'saved')
  assert.equal(acted.resultKind, 'turn')
  assert.equal(acted.result.threadId, a.threadId)
  const turn = await ctx.engine.waitForTurn(acted.result.turnId)
  assert.equal(turn.status, 'completed')

  assert.equal(of(ctx, 'user/message').length, 1, '三条事件只变成一个 turn')
  assert.equal(of(ctx, 'user/message')[0].threadId, a.threadId)
  assert.equal(of(ctx, 'task')[0].threadId, a.threadId)
  assert.equal(ctx.engine.getTurn(turn.id).threadId, a.threadId)
  const recall = ctx.engine.getTurn(turn.id).threadRecall
  assert.equal(recall.afterSeq, 0)
  assert.equal(recall.throughSeq, b.throughSeq)
  assert.equal(recall.items.length, 2)
  const activity = of(ctx, 'activity').find((e) => e.summary?.includes('接续同一条线索'))
  assert.match(activity.summary, /新增 2 条/)
  assert.equal(ctx.engine.threads.get(a.threadId).deliveredSeq, b.throughSeq)
})

test('水位推进后，下一轮只召回新增事件（afterSeq / throughSeq）', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const b = ingest(ctx, '复现步骤已补齐')
  const first = ctx.engine.cards.resolve(of(ctx, 'card', { cardType: 'thread-offer' })[0].cardId, 'delegate')
  await ctx.engine.waitForTurn(first.result.turnId)
  const deliveredSeq = ctx.engine.threads.get(a.threadId).deliveredSeq
  assert.equal(deliveredSeq, b.throughSeq)

  const c = ingest(ctx, '维护者回复了')
  assert.equal(c.offered, true, '上一轮交付后新事件重新出卡片')
  const card2 = of(ctx, 'card', { cardType: 'thread-offer' })[1]
  const second = ctx.engine.cards.resolve(card2.cardId, 'delegate')
  const turn2 = await ctx.engine.waitForTurn(second.result.turnId)
  const recall2 = ctx.engine.getTurn(turn2.id).threadRecall
  assert.equal(recall2.afterSeq, deliveredSeq)
  assert.equal(recall2.throughSeq, c.throughSeq)
  assert.deepEqual(recall2.items.map((i) => i.text), ['维护者回复了'])

  const full = ctx.engine.threads.recall(a.threadId, 0)
  const delta = ctx.engine.threads.recall(a.threadId, deliveredSeq)
  assert.equal(full.items.length, 3)
  assert.equal(delta.items.length, 1)
  assert.equal(delta.afterSeq, deliveredSeq)
  assert.equal(delta.throughSeq, c.throughSeq)
})

test('点「不用了」不派 turn，链条关闭后新事件重新出卡片', (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const acted = ctx.engine.cards.resolve(of(ctx, 'card', { cardType: 'thread-offer' })[0].cardId, 'dismiss')
  assert.equal(acted.status, 'dismissed')
  assert.equal(acted.resultKind, 'none')
  assert.equal(of(ctx, 'user/message').length, 0)
  const thread = ctx.engine.threads.get(a.threadId)
  assert.equal(thread.openCardId, null)
  assert.equal(thread.deliveredSeq, a.throughSeq, '丢弃的链不会被再次召回')

  const b = ingest(ctx, '又有新进展')
  assert.equal(b.offered, true)
  assert.equal(of(ctx, 'card', { cardType: 'thread-offer' }).length, 2)
  assert.deepEqual(ctx.engine.threads.pending(a.threadId).map((e) => e.text), ['又有新进展'])
})

test('sendMessage 带 threadId 时 turn 与时间线都打上线索标记；非法线索被拒', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const sent = ctx.engine.sendMessage({ botId: ctx.bot.id, text: '顺手看一下', threadId: a.threadId })
  assert.equal(sent.threadId, a.threadId)
  const turn = await ctx.engine.waitForTurn(sent.turnId)
  assert.equal(turn.status, 'completed')
  assert.equal(of(ctx, 'user/message')[0].threadId, a.threadId)
  assert.throws(() => ctx.engine.sendMessage({ botId: ctx.bot.id, text: 'x', threadId: 'thr_missing' }),
    (e) => e.family === 'transport' && e.status === 404)
})

test('thread 召回只放尾部 user，稳定 system 前缀不变（模型契约）', async (t) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body))
    return {
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"actions":[{"kind":"reply","text":"ok"}]}' } }] }),
    }
  }
  t.after(() => { globalThis.fetch = original })
  const model = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test', model: 'ds-test' })
  const bot = { name: '它', job: '协助用户' }
  const thread = { threadId: 'thr_1', afterSeq: 3, throughSeq: 7, items: [{ seq: 5, text: 'a' }] }
  await model.plan({ text: '第一句', bot, memory: [] })
  await model.plan({ text: '第二句', bot, memory: [], thread })
  assert.equal(calls[0].messages[0].content, calls[1].messages[0].content)
  const user1 = JSON.parse(calls[0].messages[1].content)
  const user2 = JSON.parse(calls[1].messages[1].content)
  assert.equal(user1.thread, undefined)
  assert.equal(user2.thread.afterSeq, 3)
  assert.equal(user2.thread.throughSeq, 7)
  assert.equal(user2.thread.items.length, 1)
  assert.ok(!calls[1].messages[0].content.includes('afterSeq'), 'system 前缀不能随线索变化')
  assert.equal(calls[1].reasoning_effort, 'high', 'effort 仍是顶层旁路字段')
})

test('重启后线索、事件链与交付水位都还在', (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  ingest(ctx, '复现步骤已补齐')
  ctx.engine.threads.deliver(a.threadId, 'turn_delivered1', 999)
  const restarted = new Engine({ dataDir: ctx.dir, model: new MockModel() })
  restarted.threads = new ThreadBook(restarted)
  const thread = restarted.threads.get(a.threadId)
  assert.equal(thread.events.length, 2)
  assert.equal(thread.deliveredSeq, 999)
  assert.deepEqual(restarted.threads.recall(a.threadId, 999).items, [])
  assert.equal(restarted.threads.recall(a.threadId, 0).items.length, 2)
})

test('卡片一旦委派就释放链位；turn 未交付也不会把后续事件卡住', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx))
  const a = ingest(ctx, 'CI 报错了')
  const acted = ctx.engine.cards.resolve(of(ctx, 'card', { cardType: 'thread-offer' })[0].cardId, 'delegate')
  assert.equal(ctx.engine.threads.get(a.threadId).openCardId, null, '委派后链位立即释放')
  assert.equal(ctx.engine.threads.get(a.threadId).deliveredSeq, 0, '水位只在模型真正交付后推进')
  const b = ingest(ctx, '又有新进展')
  assert.equal(b.offered, true, '即使委派的 turn 被中断，新事件仍能浮出新卡片')
  assert.equal(of(ctx, 'card', { cardType: 'thread-offer' }).length, 2)
  const delivered = await ctx.engine.waitForTurn(acted.result.turnId)
  assert.equal(delivered.status, 'completed')
  assert.equal(ctx.engine.getTurn(delivered.id).threadRecall.items.length, 1,
    '在途 turn 只看到委派当时已存在的事件')
  assert.equal(ctx.engine.threads.get(a.threadId).deliveredSeq, a.throughSeq)
  assert.deepEqual(ctx.engine.threads.pending(a.threadId).map((e) => e.text), ['又有新进展'])
})

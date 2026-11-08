import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel } from '../src/providers.mjs'
import { CardBook } from '../src/cards.mjs'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-card-'))
  const engine = new Engine({ dataDir: dir, model: new MockModel() })
  engine.cards = new CardBook(engine)
  return { dir, engine, cards: engine.cards }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('有实质工作的完成轮才浮现一张类型化卡片', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await engine.waitForTurn(turnId)
  const cards = engine.journal.all(bot.id).filter((e) => e.kind === 'card')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].cardType, 'followup-offer')
  assert.equal(cards[0].actions.length, 3)
  assert.equal(cards[0].initiator, 'agent')
})

test('纯对话不打扰：不浮现卡片', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '你好' })
  await engine.waitForTurn(turnId)
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'card').length, 0)
})

test('点「存成技能」生成技能并写回 resolved，重复点击幂等', async (t) => {
  const { dir, engine, cards } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await engine.waitForTurn(turnId)
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  assert.equal(cards.get(card.cardId).status, 'pending')
  const r = cards.resolve(card.cardId, 'save-skill')
  assert.equal(r.status, 'saved')
  assert.match(r.result.id, /^skl_/)
  assert.equal(cards.get(card.cardId).status, 'saved')
  assert.equal(cards.resolve(card.cardId, 'save-routine').status, 'saved', '重复动作不重复创建')
  const resolved = engine.journal.all(bot.id).filter((e) => e.kind === 'card/resolved')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].initiator, 'card_action')
  assert.equal(cards.skills.list().length, 1)
})

test('点「每小时自动跑」创建定时 routine；「不用了」只记录不产生对象', async (t) => {
  const { dir, engine, cards } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await engine.waitForTurn(turnId)
  const first = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  const r = cards.resolve(first.cardId, 'save-routine')
  assert.equal(r.result.trigger.type, 'interval')
  assert.equal(cards.routines.list().length, 1)

  const { turnId: second } = engine.sendMessage({ botId: bot.id, text: '再写一份报告' })
  await engine.waitForTurn(second)
  const latest = engine.journal.all(bot.id).filter((e) => e.kind === 'card').at(-1)
  const d = cards.resolve(latest.cardId, 'dismiss')
  assert.equal(d.status, 'dismissed')
  assert.equal(d.result, null)
  assert.equal(cards.skills.list().length, 0)
})

test('非法动作与不存在的卡片被拒绝', async (t) => {
  const { dir, engine, cards } = make()
  t.after(() => cleanup(dir))
  assert.throws(() => cards.get('crd_nope'), (e) => e.status === 404)
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await engine.waitForTurn(turnId)
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  assert.throws(() => cards.resolve(card.cardId, 'rm-rf'), (e) => e.family === 'transport')
})

test('连续多件有实质工作不堆叠重复的 followup 卡片', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  for (const text of ['帮我写一份周报', '再写一份报告', '生成一份文档']) {
    const { turnId } = engine.sendMessage({ botId: bot.id, text })
    await engine.waitForTurn(turnId)
  }
  const cards = engine.journal.all(bot.id).filter((e) => e.kind === 'card' && e.cardType === 'followup-offer')
  assert.equal(cards.length, 1, '上一张还没处理时不再堆同样的卡片')
})

test('点「不用了」之后不再重复提议（尊重人的决定）', async (t) => {
  const { dir, engine, cards } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const a = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await engine.waitForTurn(a.turnId)
  const first = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  assert.equal(cards.resolve(first.cardId, 'dismiss').status, 'dismissed')

  const b = engine.sendMessage({ botId: bot.id, text: '再写一份报告' })
  await engine.waitForTurn(b.turnId)
  const offers = engine.journal.all(bot.id).filter((e) => e.kind === 'card' && e.cardType === 'followup-offer')
  assert.equal(offers.length, 1)
  assert.ok(engine.store.read(`followup.${bot.id}`, {}).suppressedUntil > Date.now())
})

test('没真答出来的轮不邀请「存成技能 / 自动跑」', (t) => {
  const { dir, engine, cards } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '它' })
  const base = { id: 'turn_probe', botId: bot.id, status: 'completed' }

  const failed = cards.offerForTurn({ ...base, actions: [
    { kind: 'browse', query: 'x' },
    { kind: 'reply', text: '这一步我还没给出答案', fallback: true },
  ] })
  assert.equal(failed, null, '系统兜底 = 没答出来，不该邀功')

  const answered = cards.offerForTurn({ ...base, actions: [
    { kind: 'browse', query: 'x' },
    { kind: 'reply', text: '没做的两件是 A 和 B' },
  ] })
  assert.equal(answered?.cardType, 'followup-offer', '真答出来了仍然照常给卡片')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { CardBook } from '../src/cards.mjs'
import { ProactiveNudge } from '../src/nudge.mjs'

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }
function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-nudge-')) }

function make({ model, minAgeMs = 0, cooldownMs = 0 } = {}) {
  const dir = tmp()
  const engine = new Engine({ dataDir: dir, model: model || approvingModel() })
  engine.cards = new CardBook(engine)
  const bot = engine.createBot({ name: '它' })
  const nudge = new ProactiveNudge(engine, { minAgeMs, cooldownMs, enabled: true })
  return { dir, engine, bot, nudge }
}

/** A model that stops on a command waiting for approval, so the turn can be
 *  interrupted into a genuinely hanging state. */
function approvingModel() {
  return {
    name: 'stub-approve',
    async plan() {
      return [{ kind: 'run_command', command: 'node --version', requiresApproval: true, summary: '等一下' }]
    },
    async nudge({ text }) { return `「${String(text || '').slice(0, 20)}」还等着你点一下。` },
  }
}

/** Leave a card the human never answered: a stopped turn plus a resume offer. */
async function hangAResume(engine, bot) {
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '做一件长事' })
  for (let i = 0; i < 100; i += 1) {
    if (engine.getTurn(turnId).status === 'waiting_approval') break
    await new Promise((r) => setTimeout(r, 5))
  }
  engine.interrupt(turnId)
  engine.cards.offerResume(engine.getTurn(turnId))
  return turnId
}

// ---------------------------------------------------------------- the nudge

test('没人理的卡会被主动提一次：一条主动消息 + 一张可点的卡', async (t) => {
  const { dir, engine, bot, nudge } = make()
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  const res = await nudge.scan()
  assert.equal(res.offered, 1, '应主动开口一次')

  const entries = engine.journal.all(bot.id)
  const said = entries.filter((e) => e.kind === 'assistant/message' && e.nudge)
  assert.equal(said.length, 1, '时间线上应有一条主动消息')
  assert.equal(said[0].viaOutbox, true, '主动消息也走统一出口')
  assert.match(said[0].text, /还等着|点一下|停着|接着做/)

  const card = entries.find((e) => e.kind === 'card' && e.cardType === 'nudge-offer')
  assert.ok(card, '应出一张可点的卡')
  assert.deepEqual(card.actions.map((a) => a.id), ['resume', 'dismiss'])
})

test('同一件事只提一次，不重复刷屏', async (t) => {
  const { dir, engine, bot, nudge } = make()
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  assert.equal((await nudge.scan()).offered, 1)
  const second = await nudge.scan()
  assert.equal(second.offered, 0, '同一张卡不该被提第二次')
  const said = engine.journal.all(bot.id).filter((e) => e.kind === 'assistant/message' && e.nudge)
  assert.equal(said.length, 1)
})

test('冷却期内不再开口，不打扰人', async (t) => {
  const { dir, engine, bot, nudge } = make({ cooldownMs: 60 * 60 * 1000 })
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  assert.equal((await nudge.scan()).offered, 1)

  // A second hanging thing appears, but the Bot just spoke: stay quiet.
  await hangAResume(engine, bot)
  const second = await nudge.scan()
  assert.equal(second.offered, 0, '冷却期内应保持安静')
  assert.ok(second.skippedCooldown >= 1)
})

test('手上有活在跑时不打扰', async (t) => {
  let call = 0
  let release = null
  const model = {
    name: 'stub-busy',
    async plan() {
      call += 1
      if (call === 1) {
        return [{ kind: 'run_command', command: 'node --version', requiresApproval: true, summary: '等一下' }]
      }
      // The second turn stays genuinely in flight while we scan.
      await new Promise((r) => { release = r })
      return [{ kind: 'reply', text: 'ok' }]
    },
  }
  const { dir, engine, bot, nudge } = make({ model })
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  engine.sendMessage({ botId: bot.id, text: '再开一件事' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(engine.busy(bot.id), true, '此时确实有活在跑')

  const res = await nudge.scan()
  assert.equal(res.offered, 0, '忙着的时候不该插话')
  release?.()
})

test('太新的卡不主动提：刚出的卡不算悬挂', async (t) => {
  const { dir, engine, bot, nudge } = make({ minAgeMs: 60 * 60 * 1000 })
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  const res = await nudge.scan()
  assert.equal(res.offered, 0, '刚出的卡不该被当成悬挂')
})

test('已经处理过的卡不再提', async (t) => {
  const { dir, engine, bot, nudge } = make()
  t.after(() => cleanup(dir))

  const turnId = await hangAResume(engine, bot)
  const resumeCard = engine.journal.all(bot.id).find((e) => e.kind === 'card' && e.cardType === 'resume-offer')
  engine.cards.resolve(resumeCard.cardId, 'dismiss')

  const res = await nudge.scan()
  assert.equal(res.offered, 0, '人已经处理过就不该再提')
})

// ---------------------------------------------------------------- wording

test('模型给不出话时用程序兜底，绝不给空话', async (t) => {
  const model = {
    ...approvingModel(),
    async nudge() { throw new Error('model down') },
  }
  const { dir, engine, bot, nudge } = make({ model })
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  const res = await nudge.scan()
  assert.equal(res.offered, 1)
  const said = engine.journal.all(bot.id).find((e) => e.kind === 'assistant/message' && e.nudge)
  assert.ok(said.text && said.text.length > 0, '兜底文案不能为空')
  assert.ok(said.text.length <= 80)
})

// ---------------------------------------------------------------- actions

test('主动卡上的「接着做」真的把任务接起来', async (t) => {
  const { dir, engine, bot, nudge } = make()
  t.after(() => cleanup(dir))

  const turnId = await hangAResume(engine, bot)
  await nudge.scan()
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card' && e.cardType === 'nudge-offer')
  const info = engine.cards.get(card.cardId)
  const out = engine.cards.resolve(info.id, 'resume')
  assert.equal(out.resultKind, 'resume')

  // The command still has consequences, so it asks again — resuming never
  // silently re-runs something that was stopped for approval.
  for (let i = 0; i < 100; i += 1) {
    if (engine.getTurn(turnId).status === 'waiting_approval') break
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(engine.getTurn(turnId).status, 'waiting_approval', '恢复后仍要你点头')
  const approval = engine.getTurn(turnId).pendingApproval
  assert.ok(approval, '审批应重新摆出来')
  engine.approve(approval, true)
  await engine.waitForTurn(turnId)
  assert.equal(engine.getTurn(turnId).status, 'completed', '批准后任务应跑完')
})

test('等人点头的审批卡也会被提起，但不再重复摆卡', async (t) => {
  const { dir, engine, bot, nudge } = make()
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '跑条命令' })
  for (let i = 0; i < 100; i += 1) {
    if (engine.getTurn(turnId).status === 'waiting_approval') break
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(engine.getTurn(turnId).status, 'waiting_approval')

  const res = await nudge.scan()
  assert.equal(res.offered, 1, '该提醒一句')
  const said = engine.journal.all(bot.id).filter((e) => e.kind === 'assistant/message' && e.nudge)
  assert.equal(said.length, 1)
  assert.match(said[0].text, /点头|等|命令/)
  const cards = engine.journal.all(bot.id).filter((e) => e.kind === 'card' && e.cardType === 'nudge-offer')
  assert.equal(cards.length, 0, '审批卡本来就在屏幕上，不必再摆一张')
})

test('「先放着」= 不再回访', async (t) => {
  const { dir, engine, bot, nudge } = make()
  t.after(() => cleanup(dir))

  await hangAResume(engine, bot)
  await nudge.scan()
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card' && e.cardType === 'nudge-offer')
  const info = engine.cards.get(card.cardId)
  engine.cards.resolve(info.id, 'dismiss')

  const again = await nudge.scan()
  assert.equal(again.offered, 0, '放过的事不该再被提起')
})

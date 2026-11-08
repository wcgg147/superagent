import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { Journal } from '../src/journal.mjs'
import { CardBook } from '../src/cards.mjs'
import { Errors, DeepSeekModel } from '../src/providers.mjs'
import { buildTurnContext } from '../src/context.mjs'

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }
function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-cont-')) }

function make({ model, executor, cards = false } = {}) {
  const dir = tmp()
  const engine = new Engine({ dataDir: dir, model, executor })
  if (cards) engine.cards = new CardBook(engine)
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, bot }
}

const transient = () => Errors.agentFailed('模型服务不可达：fetch failed')
// ---------------------------------------------------------------- context

test('时间线是唯一上下文源：纠正/回复/产出/决定/失败/结果都取得到，且有界', (t) => {
  const dir = tmp()
  t.after(() => cleanup(dir))
  const j = new Journal(dir)
  const botId = 'bot_ctx'
  j.append(botId, 'user/message', { text: '别只说做完了，把内容给我' })
  j.append(botId, 'assistant/message', { text: '好的，这是内容' })
  j.append(botId, 'artifact', { filename: 'report.md' })
  j.append(botId, 'card/resolved', { actionId: 'dismiss' })
  j.append(botId, 'error', { title: '刚没连上模型', detail: '停在第 2 步：fetch failed' })
  j.append(botId, 'result', { summary: '这一轮已完成' })
  for (let i = 0; i < 40; i += 1) j.append(botId, 'progress', { summary: `细节 ${i}` })

  const ctx = buildTurnContext({
    journal: j, botId,
    skills: [{ name: '整理发布清单', description: '读 release-checklist.md 列出未完成项' }],
  })
  const kinds = ctx.recent.map((e) => e.kind)
  for (const kind of ['user', 'assistant', 'artifact', 'decision', 'error', 'result']) {
    assert.ok(kinds.includes(kind), `缺少 ${kind}`)
  }
  assert.match(ctx.recent.find((e) => e.kind === 'user').text, /别只说做完了/, '用户纠正要跟到下一轮')
  assert.equal(ctx.recent.find((e) => e.kind === 'decision').text, 'dismiss')
  assert.ok(ctx.recent.every((e) => e.text.length <= 120))
  const seqs = ctx.recent.map((e) => e.seq)
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), '按时间线顺序')
  assert.equal(ctx.skills[0].name, '整理发布清单')
})

test('装配不随时间线增长：只取最后 12 条、只扫尾部窗口', (t) => {
  const dir = tmp()
  t.after(() => cleanup(dir))
  const j = new Journal(dir)
  const botId = 'bot_long'
  for (let i = 0; i < 200; i += 1) j.append(botId, 'user/message', { text: `消息 ${i}` })

  const ctx = buildTurnContext({ journal: j, botId })
  assert.equal(ctx.recent.length, 12)
  assert.match(ctx.recent.at(-1).text, /消息 199/)
  assert.equal(j.tail(botId, 5).length, 5, 'tail 是有界尾读，不复制全量')
})

test('存过的技能与上一轮的纠正，都出现在下一轮规划输入里', async (t) => {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    seen.push(JSON.parse(opts.body))
    return {
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"actions":[{"kind":"reply","text":"ok"}]}' } }] }),
    }
  }
  t.after(() => { globalThis.fetch = original })

  const model = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test', model: 'ds-test' })
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  engine.journal.append(bot.id, 'user/message', { text: '别只说做完了，把内容给我' })
  engine.skillBook.save({
    name: '整理发布清单', description: '读 release-checklist.md 列出未完成项',
    instruction: '按步骤读文件并列未完成项',
  })

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '照上次那样' })
  await engine.waitForTurn(turnId)

  const user = JSON.parse(seen[0].messages[1].content)
  assert.equal(user.skills[0].name, '整理发布清单', '教过的技能必须进入规划')
  assert.ok(user.memory.some((e) => /别只说做完了/.test(e.text)), '纠正必须进入规划')
  assert.equal(engine.getTurn(turnId).status, 'completed')
})

// ---------------------------------------------------------------- continuity

test('规划阶段网络抖动自动重试，任务照常完成', async (t) => {
  let calls = 0
  const model = {
    name: 'stub',
    async plan() {
      calls += 1
      if (calls < 3) throw transient()
      return [{ kind: 'reply', text: '办好了' }]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '做件事' })
  await engine.waitForTurn(turnId)
  assert.equal(calls, 3)
  assert.equal(engine.getTurn(turnId).status, 'completed')
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'error').length, 0)
})

test('抖动耗尽后不是判死：停在原地、出「接着做」卡片、点完续跑', async (t) => {
  let calls = 0
  const model = {
    name: 'stub',
    async plan() {
      calls += 1
      if (calls <= 3) throw transient()
      return [{ kind: 'reply', text: '终于办好了' }]
    },
  }
  const { dir, engine, bot } = make({ model, cards: true })
  t.after(() => cleanup(dir))
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '做件事' })
  const paused = await engine.waitForTurn(turnId)

  assert.equal(paused.status, 'interrupted', '不能是 failed')
  const err = engine.journal.all(bot.id).find((e) => e.kind === 'error')
  assert.equal(err.title, '刚没连上模型')
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card' && e.cardType === 'resume-offer')
  assert.ok(card)
  assert.match(card.title, /没连上模型/)

  engine.cards.resolve(card.cardId, 'resume')
  const done = await engine.waitForTurn(turnId)
  assert.equal(done.status, 'completed')
  assert.equal(calls, 4, '续跑时重新规划，没有从头再问用户')
  assert.ok(engine.journal.all(bot.id).some((e) => e.kind === 'assistant/message' && /终于办好了/.test(e.text)))
})

test('执行中某一步抖动：index 不推进、现场保留、恢复后从同一步重放且不重复副作用', async (t) => {
  let browseCalls = 0
  const executor = {
    name: 'stub',
    capabilities: () => ({}),
    listMaterials: async () => [],
    browse: async () => {
      browseCalls += 1
      if (browseCalls === 1) throw transient()
      return { items: [{ title: 'a.md', snippet: '真实片段' }], note: '命中 1 处', source: 'local' }
    },
  }
  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'browse', query: 'a.md', summary: '读取材料' },
        { kind: 'reply', text: '读到了' },
      ]
    },
  }
  const { dir, engine, bot } = make({ model, executor, cards: true })
  t.after(() => cleanup(dir))
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '读一下 a.md' })
  const paused = await engine.waitForTurn(turnId)

  assert.equal(paused.status, 'interrupted')
  assert.equal(engine.getTurn(turnId).index, 0, '断点必须停在第 1 步，不能推进')
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card' && e.cardType === 'resume-offer')
  assert.match(card.summary, /停在第 1\/2 步/)

  engine.cards.resolve(card.cardId, 'resume')
  const done = await engine.waitForTurn(turnId)
  assert.equal(done.status, 'completed')
  assert.equal(browseCalls, 2, '失败那次不算执行，成功后没有重复跑')
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'tool/call').length, 1,
    'tool/call 不能因为重试出现两条')
})

test('确定性失败仍然判死，不会被误当成可续跑', async (t) => {
  const model = { name: 'stub', async plan() { throw Errors.commandNotAllowed('rm') } }
  const { dir, engine, bot } = make({ model, cards: true })
  t.after(() => cleanup(dir))
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '删掉文件' })
  const failed = await engine.waitForTurn(turnId)
  assert.equal(failed.status, 'failed')
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'card' && e.cardType === 'resume-offer').length, 0)
})

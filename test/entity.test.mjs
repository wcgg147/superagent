import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTurnContext, entitiesOf } from '../src/context.mjs'
import { Engine } from '../src/engine.mjs'
import { MockModel } from '../src/providers.mjs'

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }
function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-entity-')) }

// ---------------------------------------------------------------- entities

test('实体提取：只认文件名，取基本名', () => {
  assert.deepEqual(entitiesOf('读一下 README.md 和 package.json'), ['readme.md', 'package.json'])
  assert.deepEqual(entitiesOf('看看 src/engine.mjs 里的并发那块'), ['engine.mjs'])
  assert.deepEqual(entitiesOf('没有任何文件名的普通中文句子'), [])
  assert.deepEqual(entitiesOf('a.ts 太短不算实体'), [], '太短的名字不作为把手')
  assert.deepEqual(entitiesOf('读一下 materials/项目现状.md 的待办'), ['项目现状.md'],
    '中文文件名同样要能作为召回把手')
  assert.deepEqual(entitiesOf('把 现状清单.md 和 README.md 都看看'), ['现状清单.md', 'readme.md'])
})

// ---------------------------------------------------------------- recall

function seed(journal, botId) {
  journal.append(botId, 'user/message', { text: '帮我看看 package.json 里有哪些脚本' })
  journal.append(botId, 'assistant/message', { text: 'package.json 里声明了 test 和 start 两个脚本' })
  journal.append(botId, 'user/message', { text: '顺便把 README 的待办也列一下' })
  journal.append(botId, 'assistant/message', { text: 'README 里有三件待办' })
  // A lot of unrelated chatter in between.
  for (let i = 0; i < 40; i += 1) {
    journal.append(botId, 'user/message', { text: `闲聊 ${i}` })
    journal.append(botId, 'assistant/message', { text: `闲聊回复 ${i}` })
  }
}

test('用户指回一个旧东西时，相关历史被找回来（即使中间隔了很多闲聊）', () => {
  const dir = tmp()
  try {
    const engine = new Engine({ dataDir: dir, model: new MockModel() })
    const bot = engine.createBot({ name: '它' })
    seed(engine.journal, bot.id)

    const ctx = buildTurnContext({
      journal: engine.journal, botId: bot.id,
      text: 'package.json 那件事后来怎么样了',
    })
    assert.ok(ctx.related?.length, '应召回相关历史')
    const texts = ctx.related.map((r) => r.text).join(' | ')
    assert.match(texts, /package\.json/, '相关历史里应有 package.json 那次')
    assert.match(texts, /test 和 start/, '连当时的结论一起召回')
    assert.doesNotMatch(texts, /闲聊/, '闲聊不该混进来')
  } finally { cleanup(dir) }
})

test('没提到旧东西时不多召回', () => {
  const dir = tmp()
  try {
    const engine = new Engine({ dataDir: dir, model: new MockModel() })
    const bot = engine.createBot({ name: '它' })
    seed(engine.journal, bot.id)

    const ctx = buildTurnContext({
      journal: engine.journal, botId: bot.id,
      text: '今天天气怎么样',
    })
    assert.equal(ctx.related, undefined, '没有实体就不该有相关历史')
  } finally { cleanup(dir) }
})

test('召回不把自己这条算进去', () => {
  const dir = tmp()
  try {
    const engine = new Engine({ dataDir: dir, model: new MockModel() })
    const bot = engine.createBot({ name: '它' })
    seed(engine.journal, bot.id)
    const entry = engine.journal.append(bot.id, 'user/message', { text: '再看看 package.json' })

    const ctx = buildTurnContext({
      journal: engine.journal, botId: bot.id,
      text: '再看看 package.json',
      excludeSeqs: [entry.seq],
    })
    assert.ok(ctx.related?.length)
    assert.ok(!ctx.related.some((r) => r.seq === entry.seq), '本轮这条不该出现在相关历史里')
  } finally { cleanup(dir) }
})

// ---------------------------------------------------------------- open work

test('它知道自己手上有几件没做完的活', () => {
  const dir = tmp()
  try {
    const engine = new Engine({ dataDir: dir, model: new MockModel() })
    const bot = engine.createBot({ name: '它' })
    const done = engine.sendMessage({ botId: bot.id, text: '做完的那件' })
    const stuck = engine.sendMessage({ botId: bot.id, text: '没做完的那件' })
    engine.store.saveTurn({ ...engine.getTurn(done.turnId), status: 'completed' })
    engine.store.saveTurn({ ...engine.getTurn(stuck.turnId), status: 'interrupted' })

    const ctx = buildTurnContext({
      journal: engine.journal, botId: bot.id,
      text: '接着干',
      turns: engine.store.listTurns(),
      excludeTurnId: 'turn_none',
    })
    assert.ok(ctx.openWork?.length, '应看见未完成的活')
    const texts = ctx.openWork.map((w) => w.text).join(' | ')
    assert.match(texts, /没做完的那件/)
    assert.ok(!ctx.openWork.some((w) => w.text === '做完的那件'), '已完成的活不该算未完成')
  } finally { cleanup(dir) }
})

test('未完成的活不包括用户明确拒绝的', () => {
  const dir = tmp()
  try {
    const engine = new Engine({ dataDir: dir, model: new MockModel() })
    const bot = engine.createBot({ name: '它' })
    const t = engine.sendMessage({ botId: bot.id, text: '被拒绝的那件' })
    engine.store.saveTurn({ ...engine.getTurn(t.turnId), status: 'denied' })

    const ctx = buildTurnContext({
      journal: engine.journal, botId: bot.id,
      text: '接着干',
      turns: engine.store.listTurns(),
    })
    assert.equal(ctx.openWork, undefined, '被拒绝的事不算未完成')
  } finally { cleanup(dir) }
})

// ---------------------------------------------------------------- wiring

test('引擎把相关历史与未完成的活都交给模型', async (t) => {
  const dir = tmp()
  t.after(() => cleanup(dir))
  const plans = []
  const model = {
    name: 'stub',
    async plan(args) { plans.push(args); return [{ kind: 'reply', text: 'ok' }] },
  }
  const engine = new Engine({ dataDir: dir, model })
  const bot = engine.createBot({ name: '它' })

  const first = engine.sendMessage({ botId: bot.id, text: '看看 package.json 的脚本' })
  await engine.waitForTurn(first.turnId)
  const stuck = engine.sendMessage({ botId: bot.id, text: '另有一件没做完的' })
  engine.store.saveTurn({ ...engine.getTurn(stuck.turnId), status: 'interrupted' })

  const second = engine.sendMessage({ botId: bot.id, text: 'package.json 那件事再看看' })
  await engine.waitForTurn(second.turnId)

  const plan = plans.at(-1)
  assert.ok(plan.related?.length, '规划输入应带相关历史')
  assert.match(plan.related.map((r) => r.text).join(' '), /package\.json/)
  assert.ok(plan.openWork?.length, '规划输入应带未完成的活')
})

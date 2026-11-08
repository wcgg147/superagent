import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { buildTurnContext } from '../src/context.mjs'
import { MockModel, DeepSeekModel } from '../src/providers.mjs'

function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-delivery-')) }
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

function make({ model } = {}) {
  const dir = tmp()
  const engine = new Engine({ dataDir: dir, model: model || new MockModel() })
  const bot = engine.createBot({ name: '它' })
  mkdirSync(join(dir, 'materials'), { recursive: true })
  return { dir, engine, bot }
}

function longMaterial(dir) {
  // The important section is far past the old 800-character window.
  const filler = Array.from({ length: 60 }, (_, i) =>
    `## 第 ${i + 1} 节 · 背景\n这是占位的背景描述，用来把重要内容推到文件后半部分；编号 ${i + 1}，与待办无关。\n\n`).join('')
  writeFileSync(join(dir, 'materials', '长文档.md'),
    `${filler}## 还没做的三件事\n1. 接入渠道通知\n2. 补一份周报\n3. 换成向量检索\n`, 'utf8')
}

// ---------------------------------------------------------------- browse

test('指名一个长文件时给全文：后半段的重要章节不能被丢掉', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  longMaterial(dir)

  const out = await engine.executorFor(bot.id).browse({ query: '长文档.md' })
  const item = out.items[0]
  assert.ok(item, '应命中指名的文件')
  assert.equal(item.offset, 0, '指名文件要从头开始给')
  assert.equal(item.window, 'full')
  assert.equal(item.via, 'exact')
  assert.match(item.snippet, /接入渠道通知/, '后半段待办必须在给模型的材料里')
  assert.match(item.snippet, /向量检索/)
  assert.equal(item.truncated, undefined, '整份都在预算里就不标截断')
})

test('关键词定位读到的片段要诚实标记：跳过开头也算截断', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  longMaterial(dir)

  const out = await engine.executorFor(bot.id).browse({ query: '向量检索' })
  const item = out.items[0]
  assert.ok(item)
  assert.ok(item.offset > 0, '关键词定位会跳过前面的内容')
  assert.equal(item.truncated, true, '前置跳过必须标 truncated，不能假装看到了全文')
  assert.equal(item.window, 'located')
  assert.match(out.note, /部分内容/)
})

test('指名文件优先：不被 query 里的关键词带去别的命中片段', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  longMaterial(dir)
  writeFileSync(join(dir, 'materials', '其他.md'), '向量检索 这个词也出现在这里\n', 'utf8')

  const out = await engine.executorFor(bot.id).browse({ query: 'materials/长文档.md 向量检索' })
  assert.equal(out.items.length, 1, '指名文件时应只返回那份文件')
  assert.equal(out.items[0].title, '长文档.md')
  assert.equal(out.items[0].offset, 0)
})

// ---------------------------------------------------------------- placeholder

function placeholderModel({ composeFails = false } = {}) {
  const calls = { compose: 0, prior: null }
  return {
    name: 'stub-placeholder',
    calls,
    async plan() {
      return [
        { kind: 'browse', query: '材料.md', summary: '读材料' },
        { kind: 'write_artifact', filename: '结果.md', content: '待根据读取内容填写', summary: '生成文件' },
      ]
    },
    async compose({ prior }) {
      calls.compose += 1
      calls.prior = prior
      if (composeFails) throw new Error('model down')
      return '# 真交付物\n\n## 待办\n1. 接入渠道通知\n2. 补一份周报\n3. 换成向量检索\n'
    },
  }
}

test('占位正文不算交付：会触发带材料重写出真实内容', async (t) => {
  const model = placeholderModel()
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n测试：npm test\n待办：接入渠道通知、补一份周报、换成向量检索\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '整理成 结果.md' })
  await engine.waitForTurn(r.turnId)

  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  assert.ok(art, '应生成交付物')
  const body = engine.store.readArtifactFile(art.artifactId)
  assert.ok(!/待根据|待填写|TODO/.test(body), '占位文字不能落到文件里')
  assert.match(body, /真交付物/)
  assert.equal(model.calls.compose, 1, '应走 compose 重写')
})

test('括号里的「将基于读取内容填写」也算占位，并标出内容来源', async (t) => {
  const model = {
    name: 'stub-placeholder-variant',
    async plan() {
      return [
        { kind: 'browse', query: '材料.md', summary: '读材料' },
        { kind: 'write_artifact', filename: '结果.md',
          content: '（此处将基于读取内容填写启动命令、测试命令和三件未完成事项）', summary: '生成' },
      ]
    },
    async compose() { return '# 真交付物\n\n启动：npm start\n待办：接入渠道通知\n' },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '整理成 结果.md' })
  await engine.waitForTurn(r.turnId)

  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  const body = engine.store.readArtifactFile(art.artifactId)
  assert.match(body, /真交付物/)
  assert.ok(!/将基于|此处/.test(body), '占位说明不能落到文件里')
  assert.equal(art.contentSource, 'compose', '应记录正文来自 compose 重写')
})

test('compose 也失败时，兜底写入的是材料事实而不是占位符', async (t) => {
  const { dir, engine, bot } = make({ model: placeholderModel({ composeFails: true }) })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n测试：npm test\n待办：接入渠道通知\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '整理成 结果.md' })
  await engine.waitForTurn(r.turnId)

  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  const body = engine.store.readArtifactFile(art.artifactId)
  assert.ok(!/待根据读取内容填写/.test(body), '占位符不能成为交付物')
  assert.match(body, /npm start/, '兜底至少要有读到的真实材料')
})

test('用户明确要文件但模型只回话时，系统补写文件动作', async (t) => {
  const model = {
    name: 'stub-no-write',
    async plan() { return [{ kind: 'reply', text: '清单内容如下：启动 npm start。' }] },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n测试：npm test\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '把启动和测试命令整理成 现状清单.md 存下来' })
  await engine.waitForTurn(r.turnId)

  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  assert.ok(art, '系统应补出交付物，而不是只在回复里贴内容')
  assert.equal(art.filename, '现状清单.md')
  const body = engine.store.readArtifactFile(art.artifactId)
  assert.match(body, /npm start/, '补出的文件要有真实材料')
  assert.ok(engine.journal.all(bot.id).some((e) => e.kind === 'activity' && /补了一步/.test(e.summary || '')))
})

test('模型已经给了 write_artifact 时不重复补', async (t) => {
  const model = {
    name: 'stub-has-write',
    async plan() {
      return [{ kind: 'write_artifact', filename: '清单.md', content: '# 清单\n\n- 启动：npm start\n' },
        { kind: 'reply', text: '做好了' }]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理成 清单.md 存下来' })
  await engine.waitForTurn(r.turnId)
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'artifact').length, 1)
})

test('「详见 browse 结果」这类指向别处的空话会触发带材料重规划', async (t) => {
  const plans = []
  const model = {
    name: 'stub-pointing-elsewhere',
    async plan(args) {
      plans.push(args)
      if (!args.materials) {
        return [
          { kind: 'browse', query: '材料.md', summary: '读材料' },
          { kind: 'reply', text: '读取成功，最终结论详见browse结果。' },
        ]
      }
      return [{ kind: 'reply', text: `结论是：${String(args.materials[0].snippet).slice(0, 20)}` }]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '最终结论：ANSWER_42\n', 'utf8')
  const r = engine.sendMessage({ botId: bot.id, text: '材料.md 的最终结论是什么' })
  await engine.waitForTurn(r.turnId)

  assert.ok(plans.some((p) => p.materials), '应带真实材料重规划一次')
  const replies = engine.journal.all(bot.id)
    .filter((e) => e.kind === 'assistant/message' && e.turnId === r.turnId)
  assert.ok(replies.length >= 1)
  const final = replies.at(-1)
  assert.ok(!/详见|读取成功/.test(String(final.text)), '最终不能还停在推给别处')
  assert.match(String(final.text), /结论是/)
})

// ---------------------------------------------------------------- big material

test('超过全文预算时，browse 如实标截断并给出覆盖区间', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', 'huge.md'),
    `开头标记\n${'x'.repeat(20000)}\n结尾标记\n`, 'utf8')

  const out = await engine.executorFor(bot.id).browse({ query: 'huge.md' })
  const it = out.items[0]
  assert.ok(it)
  assert.equal(it.truncated, true, '超出预算必须标截断')
  assert.equal(it.offset, 0, '指名文件从头给')
  assert.equal(it.window, 'full')
  assert.ok(it.shown < it.bytes, '覆盖区间要小于文件长度')
  assert.match(it.snippet, /开头标记/)
  assert.doesNotMatch(it.snippet, /结尾标记/, '被截掉的尾部不能假装给了')
  assert.match(out.note, /部分内容/)
})

test('planUser 把 truncated 与「缺什么就明说」一起交给模型', async (t) => {
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
  const model = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test' })
  await model.plan({
    text: '整理 huge.md', bot: { name: '它' }, memory: [],
    materials: [{ title: 'huge.md', snippet: '只看到开头', truncated: true, offset: 0 }],
  })
  const user = JSON.parse(seen[0].messages[1].content)
  assert.equal(user.materials[0].truncated, true, '模型必须知道材料不完整')
  assert.equal(user.materials[0].offset, 0)
  assert.match(user.how_to_answer, /缺什么/, '要明确要求不编造没看到的内容')
})

// ---------------------------------------------------------------- handoff

test('交付物事件带有界内容预览和回读校验结果', async (t) => {
  const { dir, engine, bot } = make({ model: placeholderModel() })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '整理成 结果.md' })
  await engine.waitForTurn(r.turnId)

  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  assert.equal(art.integrity, true, '写完后回读应与预期一致')
  assert.ok(Array.isArray(art.preview) && art.preview.length, '应带正文预览')
  assert.match(art.preview.join(' '), /真交付物|待办/, '预览必须是文件里的真实行')
  assert.equal(art.previewTruncated, false, '短文件不该标预览截断')
  assert.equal(art.bytes, engine.store.readArtifactFile(art.artifactId).length)
  assert.equal(engine.journal.all(bot.id).some((e) => e.kind === 'error' && e.code === 'ARTIFACT_INTEGRITY'),
    false, '不该有误报的完整性错误')
})

test('模型没给回复时，时间线上会有一句基于真实交付物的说明', async (t) => {
  const { dir, engine, bot } = make({ model: placeholderModel() })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '整理成 结果.md' })
  await engine.waitForTurn(r.turnId)

  const handoff = engine.journal.all(bot.id).find((e) => e.kind === 'assistant/message' && e.handoff)
  assert.ok(handoff, '应有同事式交付说明')
  assert.equal(handoff.viaOutbox, true, '仍走统一出口')
  assert.match(handoff.text, /结果\.md/)
  assert.match(handoff.text, /点附件看全文/)
})

test('模型给了正常回复时不重复补交付说明', async (t) => {
  const model = {
    ...placeholderModel(),
    async plan() {
      return [
        { kind: 'browse', query: '材料.md', summary: '读材料' },
        { kind: 'write_artifact', filename: '结果.md', content: '# 清单\n\n- 启动：npm start\n', summary: '生成' },
        { kind: 'reply', text: '清单做好了，你看看。' },
      ]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n', 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '整理成 结果.md' })
  await engine.waitForTurn(r.turnId)
  const handoffs = engine.journal.all(bot.id).filter((e) => e.kind === 'assistant/message' && e.handoff)
  assert.equal(handoffs.length, 0, '已经有回复就不该再补')
})

// ---------------------------------------------------------------- prior deliverables

test('时间线能读回上次交付物的正文，供「接着补」使用', async (t) => {
  const plans = []
  const model = {
    name: 'stub-doc',
    async plan(args) {
      plans.push(args)
      return [{ kind: 'write_artifact', filename: '清单.md', content: '# 清单\n\n1. 接入渠道通知\n2. 补一份周报\n', summary: '生成' }]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const first = engine.sendMessage({ botId: bot.id, text: '做一份清单' })
  await engine.waitForTurn(first.turnId)

  const ctx = buildTurnContext({
    journal: engine.journal, botId: bot.id, store: engine.store,
    text: '接着补上次那份清单',
    turns: engine.store.listTurns(),
  })
  assert.ok(ctx.priorDeliverables?.length, '应读回上次交付物')
  assert.match(ctx.priorDeliverables[0].text, /接入渠道通知/)
  assert.equal(ctx.priorDeliverables[0].filename, '清单.md')

  const second = engine.sendMessage({ botId: bot.id, text: '接着补上次那份清单' })
  await engine.waitForTurn(second.turnId)
  assert.ok(plans.at(-1).priorDeliverables?.length, '引擎应把上次正文交给模型')
  assert.match(plans.at(-1).priorDeliverables[0].text, /接入渠道通知/)
})

test('compose 走兜底时也带上次正文，接得上同一份文档', async (t) => {
  let planCount = 0
  const model = {
    name: 'stub-continue',
    calls: { compose: 0, prior: null },
    async plan() {
      planCount += 1
      if (planCount === 1) {
        return [{ kind: 'write_artifact', filename: '清单.md', content: '# 清单\n\n1. 接入渠道通知\n', summary: '生成' }]
      }
      return [
        { kind: 'browse', query: '材料.md', summary: '读材料' },
        { kind: 'write_artifact', filename: '清单_v2.md', content: '待根据读取内容填写', summary: '生成' },
      ]
    },
    async compose({ prior }) {
      model.calls.compose += 1
      model.calls.prior = prior
      return '# 清单（续）\n\n1. 接入渠道通知\n2. 新增风险节\n'
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  writeFileSync(join(dir, 'materials', '材料.md'), '启动：npm start\n', 'utf8')

  const first = engine.sendMessage({ botId: bot.id, text: '做一份清单' })
  await engine.waitForTurn(first.turnId)
  const second = engine.sendMessage({ botId: bot.id, text: '接着补上次那份清单' })
  await engine.waitForTurn(second.turnId)

  assert.equal(model.calls.compose, 1, '占位正文应触发 compose 重写')
  assert.ok(model.calls.prior?.length, 'compose 应收到上次交付物正文')
  assert.match(model.calls.prior[0].text, /接入渠道通知/)
  const art = engine.journal.all(bot.id).filter((e) => e.kind === 'artifact').at(-1)
  assert.match(engine.store.readArtifactFile(art.artifactId), /新增风险节/)
})

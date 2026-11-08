import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel, DeepSeekModel, parseBrowseQuery, BROWSE_PAGE_CHARS, COMPOSE_BUDGET } from '../src/providers.mjs'

const ANSWER = '最终结论 CHECK-16001：三件待办全部收口，不要编造没读到的内容。'
const FILLER = '这一节是占位背景，与最终结论无关。'.repeat(1000)

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-page-'))
  const engine = new Engine({ dataDir: dir, model: new MockModel() })
  const bot = engine.createBot({ name: '它' })
  mkdirSync(join(dir, 'materials'), { recursive: true })
  writeFileSync(join(dir, 'materials', '长报告.md'), `# 季度报告\n${FILLER}\n## 最终结论\n${ANSWER}\n`, 'utf8')
  return { dir, engine, bot }
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })
const browse = (engine, bot, query) => engine.executorFor(bot.id).browse({ query })

const ok = (body) => ({ status: 200, body })
const message = (content) => ok({ choices: [{ message: { content } }] })
function fakeFetch(responses) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    calls.push({ body: JSON.parse(opts.body) })
    const next = responses.shift() || ok({ choices: [] })
    return { status: next.status, text: async () => JSON.stringify(next.body) }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('parseBrowseQuery：页码 token 不参与文件名识别，偏移按页对齐', () => {
  assert.deepEqual(parseBrowseQuery('长报告.md @16000'), { wanted: '长报告.md', pageOffset: 16000 })
  assert.deepEqual(parseBrowseQuery('读一下 materials/长报告.md 的待办'), { wanted: '长报告.md', pageOffset: 0 })
  assert.deepEqual(parseBrowseQuery('长报告.md @123'), { wanted: '长报告.md', pageOffset: 0 })
  assert.deepEqual(parseBrowseQuery('长报告.md @-1'), { wanted: '长报告.md', pageOffset: 0 })
  assert.deepEqual(parseBrowseQuery('随便一个关键词'), { wanted: '', pageOffset: 0 })
})

test('第一页：单次仍只有 16K，如实标 truncated / offset / shown / bytes / window', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  const out = await browse(engine, bot, '长报告.md')
  const it = out.items[0]
  assert.ok(it)
  assert.equal(it.offset, 0, '默认仍从头读')
  assert.equal(it.window, 'full', 'window 语义不变')
  assert.equal(it.via, 'exact')
  assert.equal(it.page, 1)
  assert.equal(it.truncated, true, '超出预算必须标截断')
  assert.equal(it.shown, BROWSE_PAGE_CHARS)
  assert.ok(it.shown < it.bytes, '覆盖区间必须小于文件长度')
  assert.ok(it.snippet.length <= BROWSE_PAGE_CHARS, '单次材料有界')
  assert.ok(!it.snippet.includes(ANSWER), '第一页确实没读到 16K 之外的答案')
  assert.equal(it.nextOffset, BROWSE_PAGE_CHARS, '要告诉模型下一页从哪开始')
  assert.match(out.note, /部分内容/)
})

test('第二页：模型显式写 @nextOffset 就能真读到 16K 之外的答案', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  const first = await browse(engine, bot, '长报告.md')
  const next = first.items[0].nextOffset
  const out = await browse(engine, bot, `长报告.md @${next}`)
  const it = out.items[0]
  assert.ok(it)
  assert.equal(it.offset, next)
  assert.equal(it.page, 2)
  assert.match(it.snippet, /CHECK-16001/, '16K 之外的真实答案必须出现')
  assert.equal(it.nextOffset, undefined, '读到文件末尾就不再给下一页')
  assert.equal(it.truncated, true, '前置跳过仍要诚实标 truncated，不假装看到了全文')
  assert.equal(it.shown, it.bytes, '覆盖到文件末尾')
  assert.equal(it.window, 'full', 'window 语义不变')
})

test('系统绝不自动翻页：不带 @offset 时不会把整份 25K 文档一次吐出来', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  const out = await browse(engine, bot, '长报告.md')
  assert.equal(out.items.length, 1)
  assert.ok(out.items[0].snippet.length <= BROWSE_PAGE_CHARS)
  assert.ok(!JSON.stringify(out).includes(ANSWER))
})

test('越界诚实：翻过文件末尾返回空结果，不编造也不回吐旧页', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  const out = await browse(engine, bot, '长报告.md @160000')
  assert.equal(out.items.length, 0)
  assert.match(out.note, /文件末尾|没有更多/)
  assert.ok(!out.note.includes(ANSWER))
})

test('关键词定位路径不受分页影响：仍是 800 字符定位片段', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  const out = await browse(engine, bot, 'CHECK-16001')
  const it = out.items[0]
  assert.ok(it)
  assert.equal(it.window, 'located')
  assert.ok(it.offset > 0)
  assert.equal(it.truncated, true)
  assert.ok(it.snippet.length <= 800, `关键词片段必须仍是有界的，实际 ${it.snippet.length}`)
  assert.equal(it.page, undefined, '关键词命中没有页码概念')
})

test('无状态、不缓存：改过的磁盘文件立刻被下一页读到，时间线仍是唯一上下文源', async (t) => {
  const { dir, engine, bot } = make()
  t.after(() => cleanup(dir))
  const before = await browse(engine, bot, '长报告.md')
  assert.ok(before.items[0].bytes > BROWSE_PAGE_CHARS, '材料确实超过单页预算')
  writeFileSync(join(dir, 'materials', '长报告.md'), `# 季度报告\n${FILLER}\n## 最终结论\n重写后的答案 CHANGED-9。\n`, 'utf8')
  const after = await browse(engine, bot, '长报告.md')
  assert.notEqual(after.items[0].bytes, before.items[0].bytes, '文件长度变了必须反映出来')
  const p2 = await browse(engine, bot, `长报告.md @${after.items[0].nextOffset}`)
  assert.match(p2.items[0].snippet, /CHANGED-9/, '不能拿第一次读的缓存冒充新内容')
  assert.ok(!p2.items[0].snippet.includes('CHECK-16001'))
})

test('planUser 把 nextOffset 与续读说明放进尾部 user，稳定 system 前缀不变', async (t) => {
  const f = fakeFetch([
    message('{"actions":[{"kind":"reply","text":"a"}]}'),
    message('{"actions":[{"kind":"reply","text":"b"}]}'),
  ])
  t.after(f.restore)
  const m = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test' })
  await m.plan({
    text: '整理长报告.md', bot: { name: '它' }, memory: [],
    materials: [{ title: '长报告.md', snippet: '只有开头', truncated: true, offset: 0, nextOffset: BROWSE_PAGE_CHARS }],
  })
  await m.plan({ text: '再说一句', bot: { name: '它' }, memory: [] })
  assert.equal(f.calls[0].body.messages[0].content, f.calls[1].body.messages[0].content, 'system 前缀保持稳定')
  const u = JSON.parse(f.calls[0].body.messages[1].content)
  assert.equal(u.materials[0].nextOffset, BROWSE_PAGE_CHARS)
  assert.equal(u.materials[0].truncated, true)
  assert.match(u.how_to_answer, /@nextOffset/, '要告诉模型怎么续读')
  assert.match(u.how_to_answer, /不要编造/, '诚实约束不能被续读说明冲掉')
  assert.ok(!f.calls[0].body.messages[0].content.includes('nextOffset'), '动态信息只能在尾部 user')
})

test('模型契约：browse 动作里的 @offset 不被 normalize 剥掉，engine 能原样透传', async (t) => {
  const f = fakeFetch([message('{"actions":[{"kind":"browse","query":"长报告.md @16000","summary":"读下一页"}]}')])
  t.after(f.restore)
  const m = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test' })
  const actions = await m.plan({ text: '读下一页', bot: { name: '它' }, memory: [] })
  const b = actions.find((a) => a.kind === 'browse')
  assert.equal(b.query, '长报告.md @16000')
})

test('硬上限守卫：单次预算与 compose 预算都仍是 16000，不因为分页被抬高', () => {
  assert.equal(BROWSE_PAGE_CHARS, 16000)
  assert.equal(COMPOSE_BUDGET, 16000)
  assert.equal(BROWSE_PAGE_CHARS, COMPOSE_BUDGET)
})

test('第一次规划就告诉模型长文件要分几次 browse，不依赖「空话重规划」才看到续读线索', async (t) => {
  const f = fakeFetch([message('{"actions":[{"kind":"reply","text":"ok"}]}')])
  t.after(f.restore)
  const m = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test' })
  await m.plan({ text: '长报告.md 的最终结论是什么', bot: { name: '它' }, memory: [], catalog: [{ name: '长报告.md' }] })
  const u = JSON.parse(f.calls[0].body.messages[1].content)
  assert.deepEqual(u.available_files, ['长报告.md'])
  assert.match(u.how_to_read, /@16000/, '第一次规划就要给出分页写法')
  assert.match(u.how_to_read, /不要凭猜测/, '诚实约束要在')
})

test('端到端：模型一次规划给出两个 browse，engine 顺序执行，第二页真读到 16K 之外的答案', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-page-e2e-'))
  t.after(() => cleanup(dir))
  const model = {
    name: 'paging',
    async plan() {
      return [
        { kind: 'activity', summary: '按页读长报告' },
        { kind: 'browse', query: '长报告.md', summary: '读第一页' },
        { kind: 'browse', query: '长报告.md @16000', summary: '读第二页' },
        { kind: 'reply', text: '最终结论是 CHECK-16001。' },
      ]
    },
  }
  const engine = new Engine({ dataDir: dir, model })
  const bot = engine.createBot({ name: '它' })
  mkdirSync(join(dir, 'materials'), { recursive: true })
  writeFileSync(join(dir, 'materials', '长报告.md'), `# 季度报告\n${FILLER}\n## 最终结论\n${ANSWER}\n`, 'utf8')

  const r = engine.sendMessage({ botId: bot.id, text: '长报告.md 的最终结论是什么' })
  await engine.waitForTurn(r.turnId)
  const entries = engine.journal.all(bot.id)
  const calls = entries.filter((e) => e.kind === 'tool/call' && e.name === 'browse')
  assert.equal(calls.length, 2, '两个 browse 都要真的执行')
  assert.equal(calls[0].result.items[0].page, 1)
  assert.equal(calls[0].result.items[0].nextOffset, BROWSE_PAGE_CHARS)
  assert.ok(!calls[0].result.items[0].snippet.includes('CHECK-16001'))
  assert.equal(calls[1].result.items[0].page, 2)
  assert.match(calls[1].result.items[0].snippet, /CHECK-16001/, '16K 之外的真实答案进了时间线')

  const reply = entries.filter((e) => e.kind === 'assistant/message').at(-1)
  assert.equal(reply.viaOutbox, true, '统一出口不变量')
  assert.match(String(reply.text), /CHECK-16001/)
  assert.ok(entries.some((e) => e.kind === 'task/done'), '任务要正常收口')
  assert.ok(!entries.some((e) => e.kind === 'error'), '链路不能报错')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, splitMaterialsForCompose } from '../src/engine.mjs'
import { COMPOSE_BUDGET } from '../src/providers.mjs'

const FIRST = '第一页事实 PAGE_ONE_MARKER：启动命令 npm start。'
const SECOND = '最终结论 PAGE_TWO_MARKER：三件待办全部收口。'
const FILLER = '这一节是占位背景，与结论无关。'.repeat(1400)

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })
const page = (title, offset, snippet) => ({ title, offset, snippet })

// ---------------------------------------------------------------- pure function

test('单批：材料总量在预算内时不切，顺序不变', () => {
  const items = [page('a.md', 0, 'x'.repeat(100)), page('a.md', 100, 'y'.repeat(200))]
  const batches = splitMaterialsForCompose(items, 1000)
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0], items)
})

test('分批：累计超过预算就开新批，每批累计 ≤ 预算', () => {
  const items = [
    page('a.md', 0, 'x'.repeat(8000)),
    page('a.md', 8000, 'y'.repeat(8000)),
    page('a.md', 16000, 'z'.repeat(8000)),
  ]
  const batches = splitMaterialsForCompose(items, 16000)
  assert.equal(batches.length, 2, '前两页正好一满批，第三页另起一批')
  assert.equal(batches[0].length, 2, '一批可以含多页')
  assert.deepEqual(batches.flat().map((i) => i.offset), [0, 8000, 16000], '顺序保持')
  for (const b of batches) {
    const total = b.reduce((n, i) => n + i.snippet.length, 0)
    assert.ok(total <= 16000, `每批 ≤16000，实际 ${total}`)
  }
})

test('超长单页保底一批：绝不为守预算而丢材料', () => {
  const items = [page('huge.md', 0, 'x'.repeat(50000))]
  const batches = splitMaterialsForCompose(items, 16000)
  assert.equal(batches.length, 1)
  assert.equal(batches[0][0], items[0])
})

test('空输入与空材料：返回空批次数组', () => {
  assert.deepEqual(splitMaterialsForCompose([], 16000), [])
  assert.deepEqual(splitMaterialsForCompose(null, 16000), [])
  assert.deepEqual(splitMaterialsForCompose(undefined, 16000), [])
})

test('默认值就是既有 COMPOSE_BUDGET=16000，且该常量未被抬高', () => {
  assert.equal(COMPOSE_BUDGET, 16000)
  const items = [page('a.md', 0, 'x'.repeat(16000)), page('a.md', 16000, 'y')]
  assert.equal(splitMaterialsForCompose(items).length, 2, '默认预算下正好一页一批')
})

// ---------------------------------------------------------------- engine end-to-end

function make(model) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-compose-batches-'))
  const engine = new Engine({ dataDir: dir, model })
  const bot = engine.createBot({ name: '它' })
  mkdirSync(join(dir, 'materials'), { recursive: true })
  writeFileSync(join(dir, 'materials', '长报告.md'), `# 季度报告\n${FIRST}\n${FILLER}\n## 最终结论\n${SECOND}\n`, 'utf8')
  return { dir, engine, bot }
}
const bodyOf = (engine, art) => String(engine.store.readArtifactFile(art.artifactId) || '')
const artOf = (engine, bot) => engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
const twoPagePlan = () => [
  { kind: 'browse', query: '长报告.md', summary: '读第一页' },
  { kind: 'browse', query: '长报告.md @16000', summary: '读第二页' },
  { kind: 'write_artifact', filename: '整理.md', content: '', summary: '整理成文件' },
  { kind: 'reply', text: '整理好了' },
]

test('两页 25K：compose 分批产出拼接后交付物同时含两页真实答案', async (t) => {
  const calls = []
  const model = {
    name: 'batched',
    async plan() { return twoPagePlan() },
    async compose(args) {
      calls.push(args.materials)
      return args.materials.map((m) => m.snippet).join('\n')
    },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '把 长报告.md 整理成 整理.md' })
  await engine.waitForTurn(r.turnId)
  const art = artOf(engine, bot)
  assert.equal(calls.length, 2, '两页分两批')
  assert.equal(art.composeBatches, 2, '时间线明示分批')
  assert.equal(art.contentSource, 'compose')
  assert.equal(art.integrity, true)
  const body = bodyOf(engine, art)
  assert.match(body, /PAGE_ONE_MARKER/)
  assert.match(body, /PAGE_TWO_MARKER/, '第二页不再被 composeUser 静默丢掉')
  assert.ok(body.indexOf('PAGE_ONE_MARKER') < body.indexOf('PAGE_TWO_MARKER'))
})

test('任一批返回空：不拼接半截，整体降级到全文材料兜底并标 composeDegraded', async (t) => {
  let n = 0
  const model = {
    name: 'one-batch-empty',
    async plan() { return twoPagePlan() },
    async compose(args) {
      n++
      if (n === 2) return ''
      return args.materials.map((m) => m.snippet).join('\n')
    },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理 长报告.md' })
  await engine.waitForTurn(r.turnId)
  const art = artOf(engine, bot)
  assert.equal(n, 2, '失败的那一批绝不重试')
  assert.equal(art.composeBatches, 2)
  assert.equal(art.composeDegraded, true, '降级要显式说清楚，不许静默')
  assert.equal(art.contentSource, 'material')
  const body = bodyOf(engine, art)
  assert.match(body, /PAGE_ONE_MARKER/, '降级后仍有第一页')
  assert.match(body, /PAGE_TWO_MARKER/, '降级后仍有第二页')
  assert.match(body, /由本机 materials\/ 检索结果生成/, '确实是材料兜底正文')
})

test('任一批抛错：同样整体降级，交付物不缺页', async (t) => {
  let n = 0
  const model = {
    name: 'one-batch-throws',
    async plan() { return twoPagePlan() },
    async compose(args) {
      n++
      if (n === 2) throw new Error('upstream unavailable')
      return args.materials.map((m) => m.snippet).join('\n')
    },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理 长报告.md' })
  await engine.waitForTurn(r.turnId)
  const art = artOf(engine, bot)
  assert.equal(n, 2)
  assert.equal(art.composeDegraded, true)
  assert.equal(art.contentSource, 'material')
  assert.match(bodyOf(engine, art), /PAGE_TWO_MARKER/)
})

test('单页回归：只调用一次 compose，artifact 不带分批/降级字段（与原实现等价）', async (t) => {
  const calls = []
  const model = {
    name: 'single',
    async plan() { return [
      { kind: 'browse', query: '长报告.md', summary: '读文件' },
      { kind: 'write_artifact', filename: '单页.md', content: '', summary: '整理' },
      { kind: 'reply', text: '好了' },
    ] },
    async compose(args) { calls.push(args.materials); return '# 单页\n\n' + args.materials[0].snippet },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理 长报告.md' })
  await engine.waitForTurn(r.turnId)
  const art = artOf(engine, bot)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 1)
  assert.equal(art.composeBatches, undefined, '单批不新增字段')
  assert.equal(art.composeDegraded, undefined)
  assert.equal(art.contentSource, 'compose')
  assert.match(bodyOf(engine, art), /PAGE_ONE_MARKER/)
})

test('分批路径守住统一出口 / seq / task-done / integrity / 零 error', async (t) => {
  const model = {
    name: 'invariants',
    async plan() { return twoPagePlan() },
    async compose(args) { return args.materials.map((m) => m.snippet).join('\n') },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理 长报告.md' })
  await engine.waitForTurn(r.turnId)
  const entries = engine.journal.all(bot.id)
  const seqs = entries.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.equal(new Set(seqs).size, seqs.length)
  assert.ok(entries.some((e) => e.kind === 'task'))
  assert.ok(entries.some((e) => e.kind === 'task/done'))
  assert.ok(!entries.some((e) => e.kind === 'error'))
  const replies = entries.filter((e) => e.kind === 'assistant/message')
  assert.ok(replies.length >= 1)
  assert.ok(replies.every((e) => e.viaOutbox === true))
  assert.equal(entries.filter((e) => e.kind === 'tool/call' && e.name === 'browse').length, 2)
  const art = entries.find((e) => e.kind === 'artifact')
  assert.equal(art.integrity, true)
  assert.ok(Array.isArray(art.preview), '写完回读 preview 仍在')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, collectTurnMaterials, splitMaterialsForCompose } from '../src/engine.mjs'
import { COMPOSE_BUDGET } from '../src/providers.mjs'

const FIRST = '第一页事实 PAGE_ONE_MARKER：启动命令 npm start。'
const SECOND = '最终结论 PAGE_TWO_MARKER：三件待办全部收口。'
const FILLER = '这一节是占位背景，与结论无关。'.repeat(1400)

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })
const call = (seq, turnId, items, extra = {}) => ({
  seq, turnId, kind: 'tool/call', name: 'browse', result: { items }, ...extra,
})
const page = (title, offset, snippet, extra = {}) => ({ title, offset, snippet, ...extra })

// ---------------------------------------------------------------- pure function

test('把本 turn 的多页 browse 全部聚合，按 offset 排序', () => {
  const entries = [
    call(1, 't1', [page('长报告.md', 16000, SECOND, { page: 2 })]),
    call(2, 't1', [page('长报告.md', 0, FIRST, { page: 1 })]),
  ]
  const { items, clipped } = collectTurnMaterials(entries, 't1')
  assert.equal(clipped, false)
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((i) => i.offset), [0, 16000])
  assert.match(items[0].snippet, /PAGE_ONE_MARKER/)
  assert.match(items[1].snippet, /PAGE_TWO_MARKER/)
})

test('重复翻同一页只算一次，不把材料放大', () => {
  const entries = [
    call(1, 't1', [page('a.md', 0, FIRST)]),
    call(2, 't1', [page('a.md', 0, FIRST)]),
    call(3, 't1', [page('a.md', 16000, SECOND)]),
  ]
  const { items } = collectTurnMaterials(entries, 't1')
  assert.equal(items.length, 2)
})

test('只认本 turn：别的 turn（含并发 Bot 的）材料不串进来', () => {
  const entries = [
    call(1, 't1', [page('a.md', 0, FIRST)]),
    call(2, 't2', [page('SECRET_OTHER_TURN.md', 0, '别人的材料')]),
    call(3, 't1', [page('a.md', 16000, SECOND)]),
  ]
  const { items } = collectTurnMaterials(entries, 't1')
  assert.equal(items.length, 2)
  assert.ok(!JSON.stringify(items).includes('SECRET_OTHER_TURN'))
})

test('非 browse 事件、无 result 的事件被忽略；空输入返回空', () => {
  const entries = [
    { seq: 1, turnId: 't1', kind: 'activity', result: { items: [page('x.md', 0, FIRST)] } },
    { seq: 2, turnId: 't1', kind: 'tool/call', name: 'browse' },
    { seq: 3, turnId: 't1', kind: 'tool/call', name: 'run_command', result: { items: [page('y.md', 0, 'x')] } },
  ]
  assert.deepEqual(collectTurnMaterials(entries, 't1'), { items: [], clipped: false })
  assert.deepEqual(collectTurnMaterials([], 't1'), { items: [], clipped: false })
  assert.deepEqual(collectTurnMaterials(null, 't1'), { items: [], clipped: false })
})

test('有界且诚实：超过页数/字符上限停止并标 truncated', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    call(i + 1, 't1', [page('long.md', i * 16000, `第 ${i + 1} 页 ` + 'x'.repeat(100))]))
  const byPages = collectTurnMaterials(many, 't1', { maxPages: 3, maxChars: 1000000 })
  assert.equal(byPages.items.length, 3)
  assert.equal(byPages.clipped, true)
  assert.equal(byPages.items.at(-1).truncated, true, '要如实标注后面还有页')
  const byChars = collectTurnMaterials([call(1, 't1', [
    page('long.md', 0, 'x'.repeat(100)), page('long.md', 16000, 'y'.repeat(100)),
  ])], 't1', { maxPages: 8, maxChars: 150 })
  assert.equal(byChars.items.length, 1)
  assert.equal(byChars.clipped, true)
  assert.equal(byChars.items[0].truncated, true)
})

// ---------------------------------------------------------------- engine end-to-end

function make(model) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-artifact-pages-'))
  const engine = new Engine({ dataDir: dir, model })
  const bot = engine.createBot({ name: '它' })
  mkdirSync(join(dir, 'materials'), { recursive: true })
  writeFileSync(join(dir, 'materials', '长报告.md'), `# 季度报告\n${FIRST}\n${FILLER}\n## 最终结论\n${SECOND}\n`, 'utf8')
  return { dir, engine, bot }
}

function artifactBody(engine, entry) {
  return engine.store.readArtifactFile(entry.artifactId)
}

test('端到端：两页 browse 后写文件，交付物正文同时含第一页与第二页的真实答案', async (t) => {
  const model = {
    name: 'paging',
    async plan() {
      return [
        { kind: 'browse', query: '长报告.md', summary: '读第一页' },
        { kind: 'browse', query: '长报告.md @16000', summary: '读第二页' },
        { kind: 'write_artifact', filename: '整理.md', content: '', summary: '整理成文件' },
      ]
    },
    // No compose: force the material backstop, which is exactly the path that
    // used to see only the last browse.
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '把 长报告.md 整理成 整理.md 存下来' })
  await engine.waitForTurn(r.turnId)
  const entries = engine.journal.all(bot.id)
  const art = entries.find((e) => e.kind === 'artifact')
  assert.ok(art, '应生成交付物')
  const body = String(artifactBody(engine, art) || '')
  assert.match(body, /PAGE_ONE_MARKER/, '第一页事实不能丢（旧实现只留最后一页）')
  assert.match(body, /PAGE_TWO_MARKER/, '第二页结论要在')
  assert.equal(art.integrity, true, '写完回读要一致')
  assert.equal(art.contentSource, 'material')
  // One title, two pages in order.
  assert.equal((body.match(/## 长报告\.md/g) || []).length, 1, '同一文件标题只写一次')
  assert.ok(body.indexOf('PAGE_ONE_MARKER') < body.indexOf('PAGE_TWO_MARKER'), '页序按 offset')
})

test('端到端：compose 分批拿到全部页，每批都在既有 16000 预算内', async (t) => {
  // Contract aligned in AGENTS.md §3.3 (NOT widened): compose used to be one
  // call with all pages, which composeUser silently cut at COMPOSE_BUDGET.
  // Now it is one bounded batch per call. The original intent -- every page
  // must reach compose -- is kept, plus four stricter checks: batch count,
  // per-batch budget, page order and the timeline's composeBatches marker.
  const seen = []
  const model = {
    name: 'compose-paging',
    async plan() {
      return [
        { kind: 'browse', query: '长报告.md', summary: '读第一页' },
        { kind: 'browse', query: '长报告.md @16000', summary: '读第二页' },
        { kind: 'write_artifact', filename: '整理.md', content: '', summary: '整理成文件' },
      ]
    },
    async compose(args) {
      seen.push(args.materials)
      return '# 整理\n\n' + args.materials.map((m) => m.snippet).join('\n\n')
    },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理 长报告.md' })
  await engine.waitForTurn(r.turnId)
  assert.equal(seen.length, 2, '两页各 16000 字，应分两批调用')
  assert.equal(seen.flat().length, 2, '跨所有调用累计仍必须拿到两页（原断言意图不变）')
  for (const batch of seen) {
    const total = batch.reduce((n, m) => n + String(m.snippet || '').length, 0)
    assert.ok(total <= COMPOSE_BUDGET, `每批材料必须 ≤ ${COMPOSE_BUDGET}，实际 ${total}`)
  }
  assert.match(String(seen[0][0].snippet), /PAGE_ONE_MARKER/, '第一批是第一页')
  assert.match(String(seen[1][0].snippet), /PAGE_TWO_MARKER/, '第二批是第二页，不再被 composeUser 丢掉')
  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  assert.equal(art.composeBatches, 2, '时间线要明示分批，不静默')
  assert.equal(art.composeDegraded, undefined, '全部批次成功时不应标降级')
  const body = String(artifactBody(engine, art) || '')
  assert.match(body, /PAGE_ONE_MARKER/)
  assert.match(body, /PAGE_TWO_MARKER/)
})

test('端到端：单页场景行为不变（不引入重复或多余标题）', async (t) => {
  const model = {
    name: 'single-page',
    async plan() {
      return [
        { kind: 'browse', query: '长报告.md', summary: '读文件' },
        { kind: 'write_artifact', filename: '单页.md', content: '', summary: '整理' },
      ]
    },
  }
  const { dir, engine, bot } = make(model)
  t.after(() => cleanup(dir))
  const r = engine.sendMessage({ botId: bot.id, text: '整理 长报告.md' })
  await engine.waitForTurn(r.turnId)
  const art = engine.journal.all(bot.id).find((e) => e.kind === 'artifact')
  const body = String(artifactBody(engine, art) || '')
  assert.equal((body.match(/## 长报告\.md/g) || []).length, 1)
  assert.match(body, /PAGE_ONE_MARKER/)
  assert.ok(!body.includes('PAGE_TWO_MARKER'), '没读第二页就不能凭空出现')
})

test('端到端：统一出口 / seq / task-done / 零 error 不变量守住', async (t) => {
  const model = {
    name: 'invariants',
    async plan() {
      return [
        { kind: 'browse', query: '长报告.md', summary: '读第一页' },
        { kind: 'browse', query: '长报告.md @16000', summary: '读第二页' },
        { kind: 'write_artifact', filename: '整理.md', content: '占位待填写', summary: '整理' },
        { kind: 'reply', text: '整理好了' },
      ]
    },
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
})

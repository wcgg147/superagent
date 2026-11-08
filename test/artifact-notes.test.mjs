import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactNotes } from '../web/artifact-notes.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const texts = (e) => artifactNotes(e).map((n) => n.text)

// ---------------------------------------------------------------- pure function

test('正常单批 compose：不产生任何提示，DOM 零新增（低打扰 + 40 项冒烟兼容）', () => {
  assert.deepEqual(artifactNotes({
    kind: 'artifact', filename: '整理.md', bytes: 1200,
    contentSource: 'compose', integrity: true, preview: ['## 标题', '- 一条事实'],
    previewTruncated: false,
  }), [])
  assert.deepEqual(artifactNotes({ kind: 'artifact', contentSource: 'model' }), [])
})

test('分批 compose：如实说明按几页整理，不夸大不隐瞒', () => {
  const notes = artifactNotes({ composeBatches: 2, contentSource: 'compose' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].text, '按 2 页材料分段整理')
  assert.equal(notes[0].warn, false, '正常分批不该吓人')
  assert.deepEqual(artifactNotes({ composeBatches: 1 }), [], '单批不显示')
  assert.deepEqual(artifactNotes({ composeBatches: undefined }), [])
})

test('任一批失败降级：显式、醒目标注，且不与「材料来源」文案重复', () => {
  const notes = artifactNotes({ composeBatches: 2, composeDegraded: true, contentSource: 'material' })
  assert.equal(notes.length, 2, '降级 + 分批两条')
  assert.equal(notes[0].warn, true)
  assert.match(notes[0].text, /模型没写成.*原文兜底/)
  assert.ok(!texts({ composeBatches: 2, composeDegraded: true, contentSource: 'material' })
    .includes('内容来自本机检索材料，未经模型改写'), '降级已说清，不重复')
})

test('材料兜底（模型本就没给内容）：说明正文来源，不假装是模型写的', () => {
  const notes = artifactNotes({ contentSource: 'material' })
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /本机检索材料.*未经模型改写/)
  assert.equal(notes[0].warn, false)
})

test('没有材料也没生成内容：诚实告警', () => {
  const notes = artifactNotes({ contentSource: 'empty' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].warn, true)
  assert.match(notes[0].text, /没有读到可用材料/)
})

test('材料有界：预览里出现「材料有界」就提示用户分批续读', () => {
  const notes = artifactNotes({ preview: ['# 整理', '> 材料有界：还有后续页未纳入'] })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].warn, true)
  assert.match(notes[0].text, /还有后续材料未纳入.*分批续读/)
  assert.deepEqual(artifactNotes({ preview: ['# 整理', '- 普通一行'] }), [])
  assert.deepEqual(artifactNotes({ preview: 'not-an-array' }), [])
})

test('已有的卡片信息不重复：integrity 失败 / previewTruncated 各有原位置', () => {
  const e = { integrity: false, previewTruncated: true, preview: ['## 标题'] }
  assert.deepEqual(artifactNotes(e), [], '这两条由 artifact-head / artifact-more 负责')
  const src = read('web/app.js')
  assert.match(src, /写入校验失败/, '头部仍显示回读失败')
  assert.match(src, /点文件名下载完整内容/, '底部仍显示预览被截断')
})

test('多信号按严重度排序：降级 → 材料有界 → 分批', () => {
  const notes = artifactNotes({
    composeDegraded: true, composeBatches: 3,
    preview: ['> 材料有界：还有后续页未纳入'],
  })
  assert.deepEqual(notes.map((n) => n.warn), [true, true, false])
  assert.match(notes[0].text, /模型没写成/)
  assert.match(notes[1].text, /材料未纳入/)
  assert.match(notes[2].text, /按 3 页/)
})

test('文案中文化、不把内部错误码甩给用户', () => {
  const all = texts({
    composeDegraded: true, composeBatches: 2, contentSource: 'material',
    preview: ['> 材料有界'],
  }).join(' | ')
  assert.ok(!/NO_CREDENTIAL|COMPOSE_BUDGET|composeDegraded|contentSource|ARTIFACT_|undefined|null/i.test(all))
  assert.ok(/[一-龥]/.test(all))
})

test('空输入 / 非对象 / 未知字段安全，不抛错', () => {
  assert.deepEqual(artifactNotes(null), [])
  assert.deepEqual(artifactNotes(undefined), [])
  assert.deepEqual(artifactNotes('x'), [])
  assert.deepEqual(artifactNotes(42), [])
  assert.deepEqual(artifactNotes({ someFutureField: true }), [])
})

// ---------------------------------------------------------------- wiring / invariants

test('app.js 接线：只在卡片内部追加 notes，不动 cursor / seen / SSE 过滤', () => {
  const src = read('web/app.js')
  assert.match(src, /import \{ artifactNotes \} from '\.\/artifact-notes\.js'/)
  assert.match(src, /const notes = artifactNotes\(e\)/)
  assert.match(src, /class="artifact-notes"/)
  assert.match(src, /artifact-note\$\{n\.warn \? ' warn' : ''\}/, '降级要能加警示类')
  assert.match(src, /esc\(n\.text\)/, '文案必须转义，不能注入 HTML')
  // Forbidden zone: the pinned cursor / dedupe / botId filter logic.
  assert.match(src, /state\.cursor = 0/)
  assert.match(src, /state\.seen\.clear\(\)/)
  assert.match(src, /if \(msg\.type === 'entry' && msg\.botId === state\.botId\) renderEntry\(msg\.entry\)/)
  assert.equal((src.match(/case 'artifact': \{/g) || []).length, 1, '不能多出一个 artifact 分支')
})

test('纯模块 UI-only：不写时间线、不发请求、不碰 DOM', () => {
  const src = read('web/artifact-notes.js')
  for (const forbidden of ['document.', 'fetch(', 'appendChild', 'journal', 'localStorage', 'EventSource', 'innerHTML']) {
    assert.ok(!src.includes(forbidden), `artifact-notes.js 不该出现 ${forbidden}`)
  }
  assert.match(src, /export function artifactNotes/)
})

test('样式：正常提示低打扰，降级用琥珀色但不弹卡片', () => {
  const css = read('web/style.css')
  assert.match(css, /\.artifact-notes \{/)
  assert.match(css, /\.artifact-note \{/)
  assert.match(css, /\.artifact-note\.warn \{/)
  assert.match(css, /#fff8e8/, '与连接状态一致的暖色，不新增红色告警')
})

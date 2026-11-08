import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCopy } from '../web/error-copy.js'
import {
  MAX_ERROR_GROUPS, errorGroupKey, errorRepeat, repeatedLine, rememberErrorGroup,
} from '../web/error-repeat.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const LEAK = /DEEPSEEK_|NO_CREDENTIAL|USAGE_LIMIT|AGENT_FAILED|undefined|null/i

const QUIET = errorCopy({ code: 'NO_CREDENTIAL', title: '模型密钥未被接受', detail: '请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配' })
const LOUD = errorCopy({ code: 'USAGE_LIMIT', title: '用量已用完', detail: '本周额度已用尽' })

// ---------------------------------------------------------------- pure function

test('只有可自行重试的 quiet 错误才成组；额度 / 明确拒绝永远说全', () => {
  assert.match(errorGroupKey('bot_1', 'turn_1', QUIET), /bot_1\|turn_1/)
  assert.equal(QUIET.quiet, true)
  assert.equal(errorGroupKey('bot_1', 'turn_1', LOUD), null, '额度是真条件，不能被降权')
  assert.equal(LOUD.quiet, false)
  const refused = errorCopy({ code: 'ARTIFACT_INTEGRITY', title: '交付物没能正确写入', detail: '写完后回读与预期不一致，请重新生成一次。' })
  assert.equal(errorGroupKey('bot_1', 'turn_1', refused), null, '程序侧明确拒绝不能被降权')
})

test('分组键带 botId / turnId / 文案：跨 Bot、跨轮、不同问题互不串味', () => {
  const a = errorGroupKey('bot_1', 'turn_1', QUIET)
  assert.notEqual(a, errorGroupKey('bot_2', 'turn_1', QUIET), '切 Bot 天然隔离，不必改 selectBot')
  assert.notEqual(a, errorGroupKey('bot_1', 'turn_2', QUIET), '新的一轮重新说一次')
  const other = errorCopy({ code: 'AGENT_FAILED', detail: 'fetch failed' })
  assert.notEqual(a, errorGroupKey('bot_1', 'turn_1', other), '不同原因分行')
  assert.equal(errorGroupKey('bot_1', 'turn_1', QUIET), a, '同一件事键稳定')
})

test('成组键安全：空 / 非对象 / 缺字段都不抛错', () => {
  for (const c of [null, undefined, 'x', 42, {}, { quiet: 'true' }, { quiet: true }]) {
    assert.doesNotThrow(() => errorGroupKey('bot', 'turn', c))
  }
  assert.equal(errorGroupKey('bot', 'turn', null), null)
  assert.equal(errorGroupKey('bot', 'turn', { quiet: 'true' }), null, '只认布尔 true')
  assert.equal(typeof errorGroupKey('bot', 'turn', { quiet: true }), 'string')
})

test('首次出现不降权；只有首行还在屏上时才算重复', () => {
  const key = errorGroupKey('bot_1', 'turn_1', QUIET)
  assert.deepEqual(errorRepeat({ key, previous: null, alive: true }), { repeat: false, count: 1 })
  assert.deepEqual(errorRepeat({ key, previous: { count: 1 }, alive: false }), { repeat: false, count: 1 }, 'DOM 被清空 / 切 Bot 后重新说一次')
  assert.deepEqual(errorRepeat({ key, previous: { count: 3 }, alive: true }), { repeat: true, count: 4 })
})

test('连续瞬断计数严格单调递增，且从 2 起说「第 N 次」', () => {
  const key = errorGroupKey('bot_1', 'turn_1', QUIET)
  let previous = null
  let alive = false
  for (let n = 1; n <= 6; n += 1) {
    const r = errorRepeat({ key, previous, alive })
    assert.equal(r.count, n)
    assert.equal(r.repeat, n > 1)
    previous = { count: r.count }
    alive = true
  }
})

test('无 key / 空输入 / 脏计数不抛错，也不会误降权', () => {
  assert.deepEqual(errorRepeat(), { repeat: false, count: 1 })
  assert.deepEqual(errorRepeat({ key: null, previous: { count: 9 }, alive: true }), { repeat: false, count: 1 })
  for (const bad of [NaN, -3, 'oops', undefined, Infinity]) {
    const r = errorRepeat({ key: 'k', previous: { count: bad }, alive: true })
    assert.equal(r.repeat, true)
    assert.ok(Number.isFinite(r.count) && r.count >= 2, `脏计数 ${String(bad)} 也要安全`)
  }
})

test('重复行文案：中文化、诚实说明第几次、零内部名、零 HTML 特殊字符', () => {
  for (const n of [2, 3, 8, 99]) {
    const s = repeatedLine(n)
    assert.match(s, /同样的问题/)
    assert.match(s, new RegExp(`第 ${n} 次`))
    assert.ok(/[一-龥]/.test(s))
    assert.ok(!LEAK.test(s))
    assert.ok(!/[<>&"']/.test(s), 'app.js 会 esc()，文案本身也不该带标签')
  }
  assert.equal(repeatedLine(0), '· 同样的问题，第 2 次')
  assert.equal(repeatedLine(undefined), '· 同样的问题，第 2 次')
  assert.equal(repeatedLine(1), '· 同样的问题，第 2 次', '第 1 次不该出现')
})

test('有界记账：最多 64 组，超限删最旧而不是无限涨', () => {
  const map = new Map()
  for (let i = 0; i < MAX_ERROR_GROUPS; i += 1) rememberErrorGroup(map, `k${i}`, { count: 1 })
  assert.equal(map.size, MAX_ERROR_GROUPS)
  rememberErrorGroup(map, 'k-new', { count: 1 })
  assert.equal(map.size, MAX_ERROR_GROUPS, '不许无限增长')
  assert.equal(map.has('k0'), false, '最旧一组被忘掉')
  assert.equal(map.has('k-new'), true)
  // Updating an existing group never evicts anyone.
  rememberErrorGroup(map, 'k-new', { count: 7 })
  assert.equal(map.get('k-new').count, 7)
  assert.equal(map.size, MAX_ERROR_GROUPS)
})

test('记账安全：key 为空 / map 为空 / 非 Map 都不写', () => {
  assert.doesNotThrow(() => rememberErrorGroup(null, 'k', {}))
  assert.doesNotThrow(() => rememberErrorGroup(new Map(), null, {}))
  assert.doesNotThrow(() => rememberErrorGroup({}, 'k', {}))
  const map = new Map()
  rememberErrorGroup(map, null, {})
  assert.equal(map.size, 0)
})

test('模拟上一轮真模型连续编排：4 条同款瞬断 = 1 次说全 + 3 条极淡计数', () => {
  const events = Array.from({ length: 4 }, (_, i) => ({
    seq: i + 1, kind: 'error', turnId: 'turn_1', code: 'NO_CREDENTIAL',
    title: '模型密钥未被接受', detail: '请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配',
  }))
  const map = new Map()
  const lines = []
  for (const e of events) {
    const c = errorCopy(e)
    const key = errorGroupKey('bot_1', e.turnId, c)
    const previous = key ? map.get(key) : null
    const r = errorRepeat({ key, previous, alive: !!previous })
    const line = r.repeat ? repeatedLine(r.count) : `${c.title} / ${c.detail}`
    lines.push(line)
    if (key) rememberErrorGroup(map, key, { count: r.count })
  }
  assert.equal(lines.length, 4, '四条事件一条不少，绝不折叠')
  assert.match(lines[0], /模型服务这次没接上/)
  assert.match(lines[0], /不用改本机配置/)
  assert.deepEqual(lines.slice(1), ['· 同样的问题，第 2 次', '· 同样的问题，第 3 次', '· 同样的问题，第 4 次'])
  for (const l of lines) assert.ok(!LEAK.test(l), '时间线上不能出现内部变量名')
})

// ---------------------------------------------------------------- wiring / invariants

test('app.js 接线：import / state.errorGroups / 四个纯函数都用上并 esc', () => {
  const src = read('web/app.js')
  assert.match(src, /import \{ errorGroupKey, errorRepeat, repeatedLine, rememberErrorGroup \} from '\.\/error-repeat\.js'/)
  assert.match(src, /errorGroups: new Map\(\)/)
  assert.match(src, /const c = errorCopy\(e\)/, '上一轮的错误文案仍生效')
  assert.match(src, /const key = errorGroupKey\(state\.botId, e\.turnId, c\)/)
  assert.match(src, /const rep = errorRepeat\(\{ key, previous, alive: !!previous\?\.node\?\.isConnected \}\)/)
  assert.match(src, /esc\(repeatedLine\(rep\.count\)\)/, '重复文案必须转义')
  assert.match(src, /'row error quiet repeat'/)
  assert.match(src, /rememberErrorGroup\(state\.errorGroups, key/)
  assert.equal((src.match(/case 'error': \{/g) || []).length, 1)
})

test('硬不变量：每条 error 仍 append 一行，绝不吞时间线（DOM/API 不丢不重不多）', () => {
  const src = read('web/app.js')
  assert.match(src, /box\.appendChild\(node\)/, '公共尾部仍在')
  assert.match(src, /node\.dataset\.seq = e\.seq/, '每行仍带自己的 seq')
  assert.match(src, /box\.scrollTop = box\.scrollHeight/)
  const caseBody = src.slice(src.indexOf("case 'error': {"), src.indexOf("case 'observation':"))
  assert.ok(!/\breturn\b/.test(caseBody), 'error 分支不得早返回而跳过 appendChild')
  assert.ok(!/node = null/.test(caseBody), '不得把 node 置空来折叠行')
  assert.match(caseBody, /node = el\('div', 'row error quiet repeat'/, '重复行仍是一个真实 DOM 行')
  assert.match(caseBody, /node = el\('div', `row error\$\{c\.quiet/, '首行仍是一个真实 DOM 行')
})

test('禁改区守卫：cursor / seen / SSE 过滤未动，公共尾部无条件，src 一行未改', () => {
  const src = read('web/app.js')
  assert.match(src, /if \(state\.seen\.has\(e\.seq\)\) return/)
  assert.match(src, /state\.seen\.add\(e\.seq\)/)
  assert.match(src, /state\.cursor = Math\.max\(state\.cursor, e\.seq\)/)
  assert.match(src, /state\.cursor = 0/)
  assert.match(src, /state\.seen\.clear\(\)/)
  assert.match(src, /if \(msg\.type === 'entry' && msg\.botId === state\.botId\) renderEntry\(msg\.entry\)/)
  assert.match(src, /const notes = artifactNotes\(e\)/, '交付物诚实信号仍在')
  assert.equal((src.match(/case 'artifact': \{/g) || []).length, 1)
  const providers = read('src/providers.mjs')
  assert.match(providers, /export const Family = \{ TRANSPORT: 'transport', ENTITLEMENT: 'entitlement', AGENT: 'agent' \}/)
  assert.match(providers, /请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配/, '内部原文仍在 journal')
})

test('纯模块 UI-only：不写时间线、不发请求、不碰 DOM', () => {
  const src = read('web/error-repeat.js')
  for (const forbidden of ['document.', 'fetch(', 'appendChild', 'journal', 'localStorage', 'EventSource', 'innerHTML', 'renderEntry', 'state.cursor', 'state.seen']) {
    assert.ok(!src.includes(forbidden), `error-repeat.js 不该出现 ${forbidden}`)
  }
  for (const name of ['errorGroupKey', 'errorRepeat', 'repeatedLine', 'rememberErrorGroup']) {
    assert.match(src, new RegExp(`export function ${name}\\b`))
  }
  assert.match(src, /NOT a fold/, '设计意图写进代码，防止后人顺手改成折叠')
})

test('样式：重复行极淡，首行与醒目错误都没有被削弱', () => {
  const css = read('web/style.css')
  assert.match(css, /\.row\.error\.quiet\.repeat \{/)
  assert.match(css, /border:0; background:transparent/, '重复行无框无底')
  assert.match(css, /font-size:10px/, '比正文小')
  assert.match(css, /\.row\.error\.quiet \{ border-color:#f0e2c0; background:#fffaf0; \}/, '上一轮柔和样式仍在')
  assert.match(css, /\.row\.error \{ flex-direction:column; border:1px solid #f2c4c4/, '真正要注意的错误仍醒目')
})

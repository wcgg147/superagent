import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyConnection, CONNECTION_LOST_TEXT } from '../web/connection.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const appSrc = () => read('../web/app.js')
const htmlSrc = () => read('../web/index.html')
const cssSrc = () => read('../web/style.css')
const connSrc = () => read('../web/connection.js')
const fakeEl = () => ({ hidden: true, textContent: '' })

test('断线显示中文化提示，重连后隐藏并清空', () => {
  const el = fakeEl()
  applyConnection(el, false)
  assert.equal(el.hidden, false)
  assert.equal(el.textContent, CONNECTION_LOST_TEXT)
  applyConnection(el, true)
  assert.equal(el.hidden, true)
  assert.equal(el.textContent, '')
})

test('重复断开 / 重连幂等，不会堆提示', () => {
  const el = fakeEl()
  applyConnection(el, false)
  applyConnection(el, false)
  assert.equal(el.textContent, CONNECTION_LOST_TEXT)
  applyConnection(el, true)
  applyConnection(el, true)
  assert.equal(el.hidden, true)
})

test('状态条元素缺失时静默不抛，提示不该打断页面', () => {
  assert.doesNotThrow(() => applyConnection(null, false))
  assert.doesNotThrow(() => applyConnection(undefined, true))
})

test('文案低打扰、中文化、不把内部错误码甩给用户', () => {
  assert.match(CONNECTION_LOST_TEXT, /连接|重连/)
  assert.ok(!/AGENT_FAILED|ECONN|fetch|timeout|429|error/i.test(CONNECTION_LOST_TEXT))
  assert.ok(CONNECTION_LOST_TEXT.length <= 20)
})

test('连接状态模块 UI-only：不写时间线、不碰游标 / 去重、不发请求', () => {
  const src = connSrc()
  for (const forbidden of ['document.', 'fetch(', 'appendChild', 'renderEntry', 'state.cursor', 'state.seen', 'EventSource']) {
    assert.ok(!src.includes(forbidden), `connection.js 不该出现 ${forbidden}`)
  }
})

test('app.js 接线：断线显示 / 重连隐藏，且重连仍按游标补拉增量', () => {
  const src = appSrc()
  assert.match(src, /import \{ applyConnection \} from '\.\/connection\.js'/)
  const onerror = src.match(/events\.onerror = ([^\n]+)/)?.[1] || ''
  assert.match(onerror, /applyConnection\(\$\('connStatus'\), false\)/)
  assert.ok(!/renderEntry|appendChild|refresh\(/.test(onerror), '断线提示只改状态条，不写时间线')
  const onopen = src.match(/events\.onopen = \(\) => \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(onopen, /applyConnection\(\$\('connStatus'\), true\)/)
  assert.match(onopen, /refresh\(\)\.catch\(\(\) => \{\}\)/, '重连仍要补拉断线期间的事件')
})

test('禁改区不变量仍在：SSE 按 botId 过滤、切 Bot 重置 cursor / seen', () => {
  const src = appSrc()
  assert.match(src, /if \(msg\.type === 'entry' && msg\.botId === state\.botId\) renderEntry\(msg\.entry\)/)
  assert.match(src, /state\.cursor = 0/)
  assert.match(src, /state\.seen\.clear\(\)/)
})

test('首屏元素默认隐藏，样式保证 hidden 在 flex 容器里真的生效', () => {
  assert.match(htmlSrc(), /id="connStatus"[^>]*hidden[^>]*>连接断了，正在重连…</)
  assert.match(cssSrc(), /\.conn-status\[hidden\] \{ display:none; \}/)
})

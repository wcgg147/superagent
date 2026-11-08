import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import {
  DshExecutor, DSH_PINNED_VERSION, assertPinnedVersion, parseDshStream, parseDshFinal,
} from '../src/providers.mjs'

/** A fake `dsh` CLI entry so contract tests never need the real 616-package install. */
function fakeCli(dir, { version = DSH_PINNED_VERSION, exitCode = 0 } = {}) {
  const path = join(dir, 'fake-dsh.mjs')
  writeFileSync(path, `
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0) }
if (${exitCode} !== 0) process.exit(${exitCode})
process.stdin.resume()
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  const i = args.indexOf('--session-id')
  const resumed = i >= 0
  const sid = resumed ? args[i + 1] : 'session-fake-1'
  console.log(JSON.stringify({ type: 'session', sessionId: sid }))
  console.log(JSON.stringify({ type: 'final', text: resumed ? 'RESUMED_RESULT' : 'FIRST_RESULT' }))
})
`, 'utf8')
  return path
}

function make(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-dsh-'))
  const entry = fakeCli(dir, options)
  const dsh = new DshExecutor({ store: new Store(dir), workspace: dir, entry, timeoutMs: 10000 })
  return { dir, dsh }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('解析 --json 事件流：final 文本与 sessionId', () => {
  const ndjson = [
    JSON.stringify({ type: 'session', sessionId: 'session-abc' }),
    JSON.stringify({ type: 'status', phase: 'turn_start' }),
    JSON.stringify({ type: 'final', text: 'DSH 答案' }),
  ].join('\n')
  assert.equal(parseDshStream(ndjson).finalText, 'DSH 答案')
  assert.equal(parseDshStream(ndjson).sessionId, 'session-abc')
  assert.equal(parseDshFinal(ndjson), 'DSH 答案')
  assert.equal(parseDshStream('diagnostic line\n' + ndjson).finalText, 'DSH 答案')
})

test('钉扎版本：一致通过，漂移显式报错', async (t) => {
  assert.equal(assertPinnedVersion('0.2.1-rc.5\n'), DSH_PINNED_VERSION)
  assert.throws(() => assertPinnedVersion('9.9.9'), (e) => e.code === 'DSH_VERSION_MISMATCH')
  const good = make()
  t.after(() => cleanup(good.dir))
  assert.equal(await good.dsh.verify(), DSH_PINNED_VERSION)
  const bad = make({ version: '9.9.9' })
  t.after(() => cleanup(bad.dir))
  await assert.rejects(() => bad.dsh.verify(), (e) => e.code === 'DSH_VERSION_MISMATCH')
})

test('首次 browse 建立会话，同一 Bot 第二次复用，不同 Bot 独立', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  const first = await ctx.dsh.browse({ query: 'q1', botId: 'bot_1' })
  assert.match(first.items[0].snippet, /FIRST_RESULT/)
  const sid = ctx.dsh.sessions.get('bot_1')
  assert.equal(sid, 'session-fake-1')
  const second = await ctx.dsh.browse({ query: 'q2', botId: 'bot_1' })
  assert.match(second.items[0].snippet, /RESUMED_RESULT/)
  assert.equal(ctx.dsh.sessions.get('bot_1'), sid)
  const other = await ctx.dsh.browse({ query: 'q3', botId: 'bot_2' })
  assert.match(other.items[0].snippet, /FIRST_RESULT/)
})

test('非零退出转成 agent 族错误', async (t) => {
  const ctx = make({ exitCode: 3 })
  t.after(() => cleanup(ctx.dir))
  await assert.rejects(
    () => ctx.dsh.browse({ query: 'q', botId: 'bot_1' }),
    (e) => e.family === 'agent' && e.code === 'AGENT_FAILED',
  )
})

test('接深之后命令与文件仍走本机安全边界', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  await assert.rejects(
    () => ctx.dsh.runCommand({ command: 'rm -rf /' }),
    (e) => e.code === 'COMMAND_NOT_ALLOWED',
  )
  const art = await ctx.dsh.writeArtifact({ filename: 'a.md', content: 'x' })
  assert.match(art.url, /^\/api\/artifacts\//)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel, DeepSeekModel, AppError } from '../src/providers.mjs'
import { DshExecutor, parseDshFinal } from '../src/providers.mjs'
import { contentDisposition } from '../src/http-util.mjs'

function make(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-'))
  const engine = new Engine({ dataDir: dir, model: new MockModel(), ...options })
  return { dir, engine }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('命名 Bot 有自己的持久 transcript', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手', job: '帮我处理日常事务' })
  assert.match(bot.id, /^bot_/)
  const entries = engine.journal.all(bot.id)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'system')
  assert.match(entries[0].text, /小助手/)
})

test('发送只承诺 accepted；相同 clientNonce 不产生第二条用户消息', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const a = engine.sendMessage({ botId: bot.id, text: '你好', clientNonce: 'n-1' })
  const b = engine.sendMessage({ botId: bot.id, text: '你好', clientNonce: 'n-1' })
  assert.equal(a.accepted, true)
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, true)
  assert.equal(b.turnId, a.turnId)
  await engine.waitForTurn(a.turnId)
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'user/message').length, 1)
})

test('游标续传不重复、不遗漏', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  await engine.waitForTurn(turnId)
  const first = engine.getTranscript(bot.id, 0, 1000)
  assert.ok(first.items.length > 0)
  const second = engine.getTranscript(bot.id, first.nextCursor, 1000)
  assert.equal(second.items.length, 0)
  assert.equal(first.items[0].seq, 1)
})

test('一件事从聊天到交付：完成闭环，交付物是链接不是本机路径', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份周报' })
  const turn = await engine.waitForTurn(turnId)
  assert.equal(turn.status, 'completed')
  const entries = engine.journal.all(bot.id)
  assert.ok(entries.some((e) => e.kind === 'assistant/message'))
  const art = entries.find((e) => e.kind === 'artifact')
  assert.ok(art, '应产出交付物')
  assert.match(art.url, /^\/api\/artifacts\/art_/)
  assert.ok(!art.url.includes('\\'), '不能暴露本机路径')
  assert.match(engine.readArtifactFile(art.artifactId), /周报/)
  assert.equal(engine.getBot(bot.id).memory.length, 1, '上下文应累积')
})

test('有后果的动作停在审批点，批准后才执行', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '执行命令 `node --version`' })
  const waiting = await engine.waitForTurn(turnId)
  assert.equal(waiting.status, 'waiting_approval')
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  assert.equal(card.cardType, 'approval')
  assert.ok(!engine.journal.all(bot.id).some((e) => e.kind === 'tool/call'), '批准前不能执行')
  engine.approve(card.approvalId, true)
  const done = await engine.waitForTurn(turnId)
  assert.equal(done.status, 'completed')
  assert.ok(engine.journal.all(bot.id).some((e) => e.kind === 'tool/call'))
})

test('拒绝审批后任务终态为 denied，且不执行命令', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '执行命令 `node --version`' })
  await engine.waitForTurn(turnId)
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  engine.approve(card.approvalId, false)
  assert.equal(engine.getTurn(turnId).status, 'denied')
  assert.ok(!engine.journal.all(bot.id).some((e) => e.kind === 'tool/call'))
})

test('运行中可中断，且后台步骤不会把状态覆盖回 running', async (t) => {
  const { dir, engine } = make({
    executor: {
      name: 'slow',
      capabilities: () => ['terminal', 'file', 'headless_browser', 'artifact'],
      async browse() { await new Promise((r) => setTimeout(r, 150)); return { items: [] } },
      async runCommand() { return { stdout: 'ok' } },
      async writeArtifact() { return { id: 'art_x', url: '/api/artifacts/art_x', filename: 'x' } },
    },
  })
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '搜索 一些资料' })
  await new Promise((r) => setTimeout(r, 25))
  engine.interrupt(turnId)
  const stopped = await engine.waitForTurn(turnId)
  assert.equal(stopped.status, 'interrupted')
  await new Promise((r) => setTimeout(r, 220))
  assert.equal(engine.getTurn(turnId).status, 'interrupted')
  const interrupts = engine.journal.all(bot.id).filter((e) => e.kind === 'interrupt')
  assert.equal(interrupts.length, 1)
})

test('敏感值不进 transcript，只留引用标记', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { ref } = engine.submitSecret('SUPER_SECRET_123')
  const { turnId } = engine.sendMessage({ botId: bot.id, text: `用 @secret:${ref} 登录` })
  await engine.waitForTurn(turnId)
  const raw = JSON.stringify(engine.journal.all(bot.id))
  assert.ok(!raw.includes('SUPER_SECRET_123'), 'transcript 里不能出现明文')
  const user = engine.journal.all(bot.id).find((e) => e.kind === 'user/message')
  assert.match(user.text, /\[已提供\]/)
  assert.equal(user.secretProvided, true)
  assert.equal(engine.broker.resolve(ref), 'SUPER_SECRET_123')
})

test('白名单之外的命令被拒绝，错误按族分类写入 transcript', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '执行命令 `rm -rf /`' })
  await engine.waitForTurn(turnId)
  const card = engine.journal.all(bot.id).find((e) => e.kind === 'card')
  engine.approve(card.approvalId, true)
  const failed = await engine.waitForTurn(turnId)
  assert.equal(failed.status, 'failed')
  const err = engine.journal.all(bot.id).find((e) => e.kind === 'error')
  assert.equal(err.family, 'agent')
  assert.equal(err.code, 'COMMAND_NOT_ALLOWED')
})

test('重启后 Bot 与 transcript 仍在；未完成的 turn 被如实标记为中断', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '小助手' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '帮我写一份报告' })
  await engine.waitForTurn(turnId)
  const count = engine.journal.all(bot.id).length

  const restarted = new Engine({ dataDir: dir, model: new MockModel() })
  assert.equal(restarted.getBot(bot.id).name, '小助手')
  assert.equal(restarted.journal.all(bot.id).length, count)
  restarted.store.saveTurn({ id: 'turn_test1', botId: bot.id, status: 'running', index: 0, actions: [], text: 'x' })
  restarted.store.indexTurn('turn_test1')
  restarted.recover()
  assert.equal(restarted.getTurn('turn_test1').status, 'interrupted')
  assert.ok(restarted.journal.all(bot.id).some((e) => e.recovered))
})

test('错误族：404 是 transport，缺密钥是 entitlement，标题各自不同', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  assert.throws(() => engine.getBot('bot_missing'), (e) => e instanceof AppError && e.family === 'transport' && e.status === 404)
  assert.throws(() => engine.submitSecret(''), (e) => e instanceof AppError && e.family === 'transport')
  const model = new DeepSeekModel({ apiKey: '' })
  await assert.rejects(
    () => model.plan({ text: 'x', bot: { name: 'a' }, memory: [] }),
    (e) => e instanceof AppError && e.family === 'entitlement' && e.code === 'NO_CREDENTIAL',
  )
})

test('中文文件名下载头用 RFC 5987，不含非 ASCII（真实模型暴露的边界）', () => {
  const header = contentDisposition('工作周报.md')
  assert.ok(/^[\x00-\x7F]*$/.test(header), 'header 值必须全为 ASCII，否则 Node 会抛 500')
  assert.match(header, /filename\*=UTF-8''/)
  const encoded = header.split("filename*=UTF-8''")[1]
  assert.equal(decodeURIComponent(encoded), '工作周报.md')
  assert.match(header, /filename="_.+?"/)
  const ascii = contentDisposition('result.md')
  assert.equal(decodeURIComponent(ascii.split("filename*=UTF-8''")[1]), 'result.md')
  assert.equal(contentDisposition('a"b\r\nc.md').includes('\r'), false)
})

test('默认执行面仍是 local，只有 EXECUTOR_PROVIDER=dsh 才切换', (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  assert.equal(engine.capabilities().executor, 'local')
  const prev = process.env.EXECUTOR_PROVIDER
  process.env.EXECUTOR_PROVIDER = 'dsh'
  try {
    const e2 = new Engine({ dataDir: dir, model: new MockModel() })
    assert.equal(e2.capabilities().executor, 'dsh')
    assert.ok(e2.capabilities().capabilities.includes('dsh_tools'))
  } finally {
    if (prev === undefined) delete process.env.EXECUTOR_PROVIDER
    else process.env.EXECUTOR_PROVIDER = prev
  }
})

test('DshExecutor 解析 headless --json 的 final 事件', () => {
  const ndjson = [
    JSON.stringify({ type: 'session', id: 's1' }),
    JSON.stringify({ type: 'tool_call', name: 'bash' }),
    JSON.stringify({ type: 'final', text: 'DSH 的最终答案' }),
  ].join('\n')
  assert.equal(parseDshFinal(ndjson), 'DSH 的最终答案')
  assert.equal(parseDshFinal(`diagnostic\n${ndjson}`), 'DSH 的最终答案')
  assert.equal(parseDshFinal('plain text output'), 'plain text output')
})

test('DshExecutor 的命令与交付物仍走本机安全边界', async (t) => {
  const { dir, engine } = make()
  t.after(() => cleanup(dir))
  const dsh = new DshExecutor({ store: engine.store, workspace: dir })
  await assert.rejects(
    () => dsh.runCommand({ command: 'rm -rf /' }),
    (e) => e.code === 'COMMAND_NOT_ALLOWED',
  )
  const art = await dsh.writeArtifact({ filename: 'a.md', content: 'hello' })
  assert.match(art.url, /^\/api\/artifacts\//)
})

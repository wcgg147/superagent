import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { Store } from '../src/store.mjs'
import { MockModel, DeepSeekModel, DshExecutor, DSH_PINNED_VERSION, COMPOSE_BUDGET } from '../src/providers.mjs'

function envGuard(t) {
  const keys = ['EXECUTOR_PROVIDER', 'DSH_CLI_ENTRY']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

function make(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-exec-'))
  if (mode === null) delete process.env.EXECUTOR_PROVIDER
  else process.env.EXECUTOR_PROVIDER = mode
  const engine = new Engine({ dataDir: dir, model: new MockModel() })
  return { dir, engine }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

function fakeCli(dir) {
  const path = join(dir, 'fake-dsh.mjs')
  writeFileSync(path, `
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log(${JSON.stringify(DSH_PINNED_VERSION)}); process.exit(0) }
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  const i = args.indexOf('--session-id')
  const resumed = i >= 0
  const sid = resumed ? args[i + 1] : 'session-persisted'
  console.log(JSON.stringify({ type: 'session', sessionId: sid }))
  console.log(JSON.stringify({ type: 'final', text: resumed ? 'RESUMED_RESULT' : 'FIRST_RESULT' }))
})
`, 'utf8')
  return path
}

test('默认 local：不可灰度到 dsh', (t) => {
  envGuard(t)
  delete process.env.DSH_CLI_ENTRY
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  assert.equal(engine.capabilities().mode, 'local')
  assert.equal(engine.capabilities().dshAvailable, false)
  const bot = engine.createBot({ name: '甲' })
  assert.equal(engine.executorFor(bot.id), engine.localExecutor)
  assert.throws(() => engine.setBotExecutor(bot.id, 'dsh'), (e) => e.family === 'transport')
})

test('EXECUTOR_PROVIDER=dsh：全量走 DSH', (t) => {
  envGuard(t)
  const { dir, engine } = make('dsh')
  t.after(() => cleanup(dir))
  assert.equal(engine.capabilities().executor, 'dsh')
  const a = engine.createBot({ name: '甲' })
  const b = engine.createBot({ name: '乙' })
  assert.equal(engine.executorFor(a.id), engine.dshExecutor)
  assert.equal(engine.executorFor(b.id), engine.dshExecutor)
})

test('gray：按 Bot 灰度、非法值拒绝、一键回退', (t) => {
  envGuard(t)
  const { dir, engine } = make('gray')
  t.after(() => cleanup(dir))
  assert.equal(engine.capabilities().executor, 'local', '灰度模式默认仍是 local')
  assert.equal(engine.capabilities().dshAvailable, true)
  const a = engine.createBot({ name: '甲' })
  const b = engine.createBot({ name: '乙' })
  assert.equal(engine.executorFor(a.id), engine.localExecutor)
  engine.setBotExecutor(a.id, 'dsh')
  assert.equal(engine.executorFor(a.id), engine.dshExecutor)
  assert.equal(engine.executorFor(b.id), engine.localExecutor)
  assert.deepEqual(engine.executorStatus().grayBots, [a.id])
  assert.throws(() => engine.setBotExecutor(a.id, 'bogus'), (e) => e.family === 'transport')
  engine.setBotExecutor(b.id, 'dsh')
  assert.equal(engine.executorStatus().grayBots.length, 2)
  assert.equal(engine.rollbackExecutors().rolledBack, 2)
  assert.deepEqual(engine.executorStatus().grayBots, [])
  assert.equal(engine.executorFor(a.id), engine.localExecutor)
  assert.equal(engine.executorFor(b.id), engine.localExecutor)
})

test('灰度真的路由到 DSH：browse 动作由 dsh provider 执行', async (t) => {
  envGuard(t)
  const dir = mkdtempSync(join(tmpdir(), 'p0a-exec-'))
  t.after(() => cleanup(dir))
  process.env.DSH_CLI_ENTRY = fakeCli(dir)
  process.env.EXECUTOR_PROVIDER = 'gray'
  const engine = new Engine({ dataDir: dir, model: new MockModel() })
  const bot = engine.createBot({ name: '甲' })
  engine.setBotExecutor(bot.id, 'dsh')
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '搜索 一些资料' })
  await engine.waitForTurn(turnId)
  const call = engine.journal.all(bot.id).find((e) => e.kind === 'tool/call' && e.name === 'browse')
  assert.ok(call)
  assert.equal(call.result.provider, 'dsh')
  assert.match(call.result.items[0].snippet, /FIRST_RESULT/)
})

test('会话持久化：重启 DshExecutor 后复用同一 sessionId', async (t) => {
  envGuard(t)
  const dir = mkdtempSync(join(tmpdir(), 'p0a-exec-'))
  t.after(() => cleanup(dir))
  const entry = fakeCli(dir)
  const store = new Store(dir)
  const first = new DshExecutor({ store, workspace: dir, entry, timeoutMs: 10000 })
  await first.browse({ query: 'q1', botId: 'bot_1' })
  assert.equal(first.sessions.get('bot_1'), 'session-persisted')
  const restarted = new DshExecutor({ store, workspace: dir, entry, timeoutMs: 10000 })
  assert.equal(restarted.sessions.get('bot_1'), 'session-persisted', '从 store 恢复')
  const again = await restarted.browse({ query: 'q2', botId: 'bot_1' })
  assert.match(again.items[0].snippet, /RESUMED_RESULT/, '恢复后带 --session-id')
})

test('browse 真读本机 materials/：命中返回片段，未命中如实说明，不泄漏路径', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const ex = engine.localExecutor

  const none = await ex.browse({ query: 'DeepSeek' })
  assert.equal(none.items.length, 0)
  assert.equal(none.source, 'local')
  assert.match(none.note, /materials/)

  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'release.md'), '# 发布说明\n\nDeepSeek V4 Flash 已上线，支持结构化 actions。\n')
  writeFileSync(join(m, 'notes.txt'), '本周待办：整理周报。\n')
  writeFileSync(join(m, 'ignored.bin'), 'not a text file')

  const hit = await ex.browse({ query: 'DeepSeek' })
  assert.equal(hit.items.length, 1)
  assert.equal(hit.items[0].title, 'release.md')
  assert.match(hit.items[0].snippet, /V4 Flash/)
  assert.match(hit.note, /命中 1 处/)
  assert.ok(hit.items.every((i) => !/[/\\]/.test(i.title) && !('path' in i) && !('full' in i)),
    '返回给 transcript 的不能是本机绝对路径')

  const miss = await ex.browse({ query: '完全无关的关键词' })
  assert.equal(miss.items.length, 0)
  assert.match(miss.note, /没有与/)
})

test('检索结果会作为活动摘要落到时间线，用户看得见它到底查到什么', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'a.md'), 'DeepSeek 资料：结构化 actions 可用。\n')
  const bot = engine.createBot({ name: '它' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: '搜索 DeepSeek 资料' })
  await engine.waitForTurn(turnId)
  const acts = engine.journal.all(bot.id).filter((e) => e.kind === 'activity')
  assert.ok(acts.some((e) => e.detail && /命中/.test(e.detail)), '不能只写一句「检索完成」就当查过了')
})

test('browse 认得代码文件，也能按文件名命中（用户说「解释 sort.js」）', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'sort.js'), 'function sortItems(a, b) { return a - b }\n')
  writeFileSync(join(m, 'readme.md'), '无关说明\n')

  const hit = await engine.localExecutor.browse({ query: '解释一下 sort.js 在做什么' })
  assert.equal(hit.items.length, 1)
  assert.equal(hit.items[0].title, 'sort.js')
  assert.equal(hit.items[0].via, 'exact', 'query 里点名文件，就按整份文件读')
  assert.equal(hit.items[0].offset, 0)
  assert.match(hit.items[0].snippet, /sortItems/)
})

test('模型没给交付物内容时，用真实检索材料兜底而不是写空文件', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'a.md'), 'DeepSeek 检索片段 A\n')
  const bot = engine.createBot({ name: '它' })

  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'browse', query: 'DeepSeek', summary: '读取材料' },
        { kind: 'write_artifact', filename: 'result.md', summary: '生成结果' },
        { kind: 'reply', text: '好了' },
      ]
    },
  }
  const custom = new Engine({ dataDir: dir, model, executor: engine.localExecutor })
  const { turnId } = custom.sendMessage({ botId: bot.id, text: '基于材料生成结果' })
  await custom.waitForTurn(turnId)
  const arts = custom.journal.all(bot.id).filter((e) => e.kind === 'artifact')
  assert.equal(arts.length, 1)
  const text = custom.readArtifactFile(arts[0].artifactId)
  assert.match(text, /检索片段 A/)
  assert.match(text, /系统兜底/)
  assert.ok(text.trim().length > 40, '交付物不能是空文件')
})

test('两阶段规划：检索材料递给模型 compose，交付物是模型写的而不是系统拼贴', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'code.md'), 'DeepSeek 真实片段 42\n')
  const bot = engine.createBot({ name: '它' })
  const seen = []
  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'browse', query: 'DeepSeek', summary: '读取材料' },
        { kind: 'write_artifact', filename: 'result.md', summary: '生成结果' },
        { kind: 'reply', text: '好了' },
      ]
    },
    async compose(args) {
      seen.push(args)
      return `# 模型基于材料撰写\n\n${args.materials[0].snippet}\n`
    },
  }
  const custom = new Engine({ dataDir: dir, model, executor: engine.localExecutor })
  const { turnId } = custom.sendMessage({ botId: bot.id, text: '基于材料写文档' })
  await custom.waitForTurn(turnId)

  assert.equal(seen.length, 1)
  assert.match(seen[0].materials[0].snippet, /真实片段 42/, '递给模型的必须是真实检索到的材料')
  const arts = custom.journal.all(bot.id).filter((e) => e.kind === 'artifact')
  assert.equal(arts.length, 1)
  assert.equal(arts[0].composed, true)
  const text = custom.readArtifactFile(arts[0].artifactId)
  assert.match(text, /模型基于材料撰写/)
  assert.match(text, /真实片段 42/)
  assert.ok(!text.includes('系统兜底'))
})

test('@last 只展开成本轮生成的交付物，并且真的被 node 执行', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '它' })
  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'write_artifact', filename: 'run.js', content: "console.log('GENERATED_RAN')\n" },
        { kind: 'run_command', command: 'node @last', summary: '运行生成物' },
        { kind: 'reply', text: '跑过了' },
      ]
    },
  }
  const custom = new Engine({ dataDir: dir, model, executor: engine.localExecutor })
  const { turnId } = custom.sendMessage({ botId: bot.id, text: '写个脚本并运行' })
  await custom.waitForTurn(turnId)

  const arts = custom.journal.all(bot.id).filter((e) => e.kind === 'artifact')
  const calls = custom.journal.all(bot.id).filter((e) => e.kind === 'tool/call' && e.name === 'run_command')
  assert.equal(arts.length, 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0].resolved, new RegExp(`artifacts/${arts[0].artifactId}`))
  assert.match(calls[0].result.stdout, /GENERATED_RAN/, '执行的必须是刚生成的那个文件')
  assert.equal(custom.getTurn(turnId).status, 'completed')
})

test('长文件不再只给模型 240 字符，且截断被如实标注', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  const lines = []
  for (let i = 1; i <= 60; i += 1) lines.push(`function step${i}() { return ${i} }  // 关键逻辑 ${i}`)
  writeFileSync(join(m, 'big.js'), lines.join('\n'))
  writeFileSync(join(m, 'small.js'), 'function tiny() { return 1 }')

  const big = (await engine.localExecutor.browse({ query: '解释 big.js 在做什么' })).items[0]
  assert.ok(big.snippet.length > 600, `片段要给足上下文，实际 ${big.snippet.length}`)
  assert.equal(big.truncated, undefined, '指名文件且整份在预算内：给全文，不标截断')
  assert.equal(big.bytes, lines.join('\n').length)
  assert.equal(big.shown, big.bytes, '全文给到，覆盖到文件末尾')

  // Beyond the full-file budget, the reader must still say it saw only part.
  const huge = Array.from({ length: 700 }, (_, i) => `function h${i}() { return ${i} }`).join('\n')
  writeFileSync(join(m, 'huge.js'), huge)
  const part = (await engine.localExecutor.browse({ query: 'huge.js' })).items[0]
  assert.equal(part.truncated, true, '超出预算必须如实标截断')
  assert.ok(part.shown < part.bytes)

  const small = (await engine.localExecutor.browse({ query: 'tiny' })).items[0]
  assert.equal(small.truncated, undefined, '整份都在片段里就不该标截断')
})

test('compose 的材料按总预算裁剪，不无限堆给模型', async (t) => {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    seen.push(body)
    return {
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"content":"ok"}' } }] }),
    }
  }
  t.after(() => { globalThis.fetch = original })
  const model = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test', model: 'ds-test' })
  const materials = Array.from({ length: 10 }, (_, i) => ({
    title: `f${i}.js`, snippet: 'x'.repeat(2000),
  }))
  await model.compose({ text: '写文档', materials })
  const user = JSON.parse(seen[0].messages[1].content)
  const total = user.materials.reduce((n, i) => n + i.snippet.length, 0)
  assert.ok(total <= COMPOSE_BUDGET, `总材料必须受预算约束，实际 ${total}`)
  assert.ok(user.materials.length >= 1)
  assert.ok(user.materials.at(-1).truncated === true || total === COMPOSE_BUDGET, '被裁的材料要标 truncated')
})

test('模型用 cat 读文件时，翻译成安全的 browse 而不是执行命令', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'notes.md'), '真实材料内容\n')
  const bot = engine.createBot({ name: '它' })
  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'run_command', command: 'cat notes.md', summary: '读取文件' },
        { kind: 'reply', text: '读完了。' },
      ]
    },
  }
  const custom = new Engine({ dataDir: dir, model, executor: engine.localExecutor })
  const { turnId } = custom.sendMessage({ botId: bot.id, text: '读一下 notes.md' })
  await custom.waitForTurn(turnId)
  const calls = custom.journal.all(bot.id).filter((e) => e.kind === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'browse', 'cat 不该被当命令执行')
  assert.equal(calls[0].via, 'read-command')
  assert.match(calls[0].result.items[0].snippet, /真实材料内容/)
  assert.equal(custom.getTurn(turnId).status, 'completed', '不能因为 cat 不在白名单就整轮失败')
})

test('模型写文件前还没读材料时，先读再写，交付物不为空', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'data.log'), 'GET /a 500\n')
  const bot = engine.createBot({ name: '它' })
  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'write_artifact', filename: 'out.json', summary: '生成' },
        { kind: 'reply', text: '好了。' },
      ]
    },
    async compose({ materials }) { return `based on ${materials[0].snippet}` },
  }
  const custom = new Engine({ dataDir: dir, model, executor: engine.localExecutor })
  const { turnId } = custom.sendMessage({ botId: bot.id, text: '把 data.log 统计一下' })
  await custom.waitForTurn(turnId)
  const arts = custom.journal.all(bot.id).filter((e) => e.kind === 'artifact')
  assert.equal(arts.length, 1)
  const text = custom.readArtifactFile(arts[0].artifactId)
  assert.match(text, /GET \/a 500/, '交付物必须来自真实材料')
  assert.ok(text.trim().length > 10)
})

test('命令里引用刚生成的交付物文件名时，自动解析成 artifacts/<id>', async (t) => {
  const { dir, engine } = make(null)
  t.after(() => cleanup(dir))
  const bot = engine.createBot({ name: '它' })
  const model = {
    name: 'stub',
    async plan() {
      return [
        { kind: 'write_artifact', filename: 'run.js', content: "console.log('BARE_FILENAME_RAN')\n" },
        { kind: 'run_command', command: 'node run.js', summary: '运行生成物' },
        { kind: 'reply', text: '跑过了' },
      ]
    },
  }
  const custom = new Engine({ dataDir: dir, model, executor: engine.localExecutor })
  const { turnId } = custom.sendMessage({ botId: bot.id, text: '写脚本并运行' })
  await custom.waitForTurn(turnId)
  const arts = custom.journal.all(bot.id).filter((e) => e.kind === 'artifact')
  const calls = custom.journal.all(bot.id).filter((e) => e.kind === 'tool/call' && e.name === 'run_command')
  assert.equal(calls.length, 1)
  assert.match(calls[0].resolved, new RegExp(`artifacts/${arts[0].artifactId}`), '裸文件名要解析到 artifacts/')
  assert.match(calls[0].result.stdout, /BARE_FILENAME_RAN/)
})

test('模型只读不答时，带真实材料重规划，最终真的回答问题', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-exec-'))
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'a.md'), '待办一：补回归测试\n待办二：复核进度文案\n')

  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const user = JSON.parse(body.messages[1].content)
    const withMaterials = Boolean(user.materials?.length)
    seen.push(withMaterials)
    const actions = withMaterials
      ? [{ kind: 'reply', text: '没做的两件：补回归测试、复核进度文案' }]
      : [{ kind: 'browse', query: 'a.md', summary: '读取材料' }]
    return {
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions }) } }] }),
    }
  }
  t.after(() => { globalThis.fetch = original })

  const model = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test', model: 'ds-test' })
  const engine = new Engine({ dataDir: dir, model })
  const bot = engine.createBot({ name: '它' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: 'a.md 里还有哪两件没做' })
  await engine.waitForTurn(turnId)

  const reply = engine.journal.all(bot.id).find((e) => e.kind === 'assistant/message')
  assert.ok(reply, '必须有一句回复')
  assert.match(reply.text, /补回归测试/, '答复要用上真实材料，而不是「做完了」')
  assert.ok(!/做完了/.test(reply.text))
  assert.deepEqual(seen, [false, true], '第一次只读，第二次带材料重规划')
  assert.equal(engine.getTurn(turnId).status, 'completed')
})

test('模型两次都不答时，用本机真实材料兜底回复，不编造也不打发用户', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-exec-'))
  t.after(() => cleanup(dir))
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'a.md'), '真实材料片段 42：待办 A 与待办 B\n')

  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    const user = JSON.parse(JSON.parse(opts.body).messages[1].content)
    // Neither pass gives a reply; the second one still has the material in hand.
    const actions = user.materials?.length
      ? [{ kind: 'activity', summary: '整理材料' }]
      : [{ kind: 'browse', query: 'a.md', summary: '读取材料' }]
    return {
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions }) } }] }),
    }
  }
  t.after(() => { globalThis.fetch = original })

  const model = new DeepSeekModel({ apiKey: 'fake', baseUrl: 'https://example.test', model: 'ds-test' })
  const engine = new Engine({ dataDir: dir, model })
  const bot = engine.createBot({ name: '它' })
  const { turnId } = engine.sendMessage({ botId: bot.id, text: 'a.md 里写了什么' })
  await engine.waitForTurn(turnId)

  const reply = engine.journal.all(bot.id).find((e) => e.kind === 'assistant/message')
  assert.ok(reply)
  assert.match(reply.text, /真实材料片段 42/, '必须给出真实读到的内容')
  assert.match(reply.text, /没能整理成答案/, '如实说明这不是模型整理的答案')
  assert.ok(!/再问我一次/.test(reply.text), '不能把用户打发走')
  assert.equal(engine.getTurn(turnId).status, 'completed')
})

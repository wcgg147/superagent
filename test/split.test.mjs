import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { MockModel } from '../src/providers.mjs'

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }
function tmp() { return mkdtempSync(join(tmpdir(), 'p0a-split-')) }

function make({ model, maxConcurrent } = {}) {
  const dir = tmp()
  const engine = new Engine({ dataDir: dir, model: model || new MockModel(), maxConcurrent })
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, bot }
}

/** A model that reports one message as several independent jobs. */
function splittingModel(branches) {
  return {
    name: 'stub-split',
    async plan() {
      const actions = [{ kind: 'reply', text: '一件事做完了' }]
      actions.branches = branches.map((b, i) => ({
        label: b.label || `活 ${i + 1}`,
        text: b.text || b.label || `活 ${i + 1}`,
        actions: b.actions || [{ kind: 'reply', text: b.text || `活 ${i + 1} 做完了` }],
      }))
      return actions
    },
  }
}

// ---------------------------------------------------------------- split

test('一条消息里的多件事：自己拆开并行跑，各自带任务与结果', async (t) => {
  const model = splittingModel([
    { label: '读 README', text: '读 README' },
    { label: '看 package.json', text: '看 package.json' },
  ])
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '读一下 README，并且看一下 package.json' })
  await engine.waitForTurn(turnId)

  const parent = engine.getTurn(turnId)
  assert.equal(parent.status, 'completed', '父 turn 应正常收口')
  assert.equal(parent.branchCount, 2)
  assert.equal(parent.childTurns.length, 2)

  const children = parent.childTurns.map((id) => engine.getTurn(id))
  assert.deepEqual(children.map((c) => c.status), ['completed', 'completed'], '两支都要完成')
  assert.deepEqual(children.map((c) => c.taskLabel), ['任务 1·1', '任务 1·2'], '子任务带父任务标签')
  assert.ok(children.every((c) => c.parentTurnId === parent.id), '子任务记住父任务')

  const entries = engine.journal.all(bot.id)
  const split = entries.find((e) => e.kind === 'split')
  assert.ok(split, '时间线应有 split 节点')
  assert.equal(split.count, 2)
  assert.deepEqual(split.labels, ['任务 1·1', '任务 1·2'])

  // Both branches are marked as running together.
  const branchTasks = entries.filter((e) => e.kind === 'task' && e.branch)
  assert.equal(branchTasks.length, 2)
  assert.deepEqual(branchTasks.map((t) => t.parallel), [2, 2], '两个分支都标明同时进行')

  // Each branch speaks for itself, through the one outbound voice.
  const replies = entries.filter((e) => e.kind === 'assistant/message')
  assert.equal(replies.length, 2, '两支各出一条回复')
  assert.ok(replies.every((r) => r.viaOutbox === true), '回复仍走统一出口')
  assert.ok(replies.some((r) => r.taskLabel === '任务 1·1'))
  assert.ok(replies.some((r) => r.taskLabel === '任务 1·2'))

  // Every task row is paired with exactly one done row.
  for (const child of children) {
    const opened = entries.filter((e) => e.kind === 'task' && e.turnId === child.id).length
    const closed = entries.filter((e) => e.kind === 'task/done' && e.turnId === child.id).length
    assert.equal(opened, 1)
    assert.equal(closed, 1)
  }
})

test('拆分是并行跑的：两支同时在飞，不是排着来', async (t) => {
  const model = {
    name: 'stub-overlap',
    async plan() {
      const actions = [{ kind: 'reply', text: 'ok' }]
      actions.branches = [
        { label: 'A', text: 'A', actions: [{ kind: 'reply', text: 'A 完成' }] },
        { label: 'B', text: 'B', actions: [{ kind: 'reply', text: 'B 完成' }] },
      ]
      return actions
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '两件事' })
  await engine.waitForTurn(turnId)

  assert.equal(engine.getTurn(turnId).status, 'completed')
  assert.ok(engine.coordinator.status().peak >= 2,
    `两支应同时在飞，引擎记录的并发峰值为 ${engine.coordinator.status().peak}`)
})

// ---------------------------------------------------------------- guards

test('只有一件事时不拆：仍然是一条普通任务', async (t) => {
  const model = splittingModel([{ label: '只有一件', text: '只有一件' }])
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '就一件事' })
  await engine.waitForTurn(turnId)

  const turn = engine.getTurn(turnId)
  assert.equal(turn.status, 'completed')
  assert.equal(turn.branchCount, undefined, '单支不触发拆分')
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'split').length, 0)
})

test('拆得太多会被收住：并行支数不超过槽位', async (t) => {
  const model = splittingModel(Array.from({ length: 5 }, (_, i) => ({ label: `活 ${i + 1}`, text: `活 ${i + 1}` })))
  const { dir, engine, bot } = make({ model, maxConcurrent: 2 })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '五件事' })
  await engine.waitForTurn(turnId)

  const parent = engine.getTurn(turnId)
  assert.equal(parent.branchCount, 2, '并行支数不得超过槽位')
  assert.equal(parent.childTurns.length, 2)
  assert.equal(parent.status, 'completed')
})

// ---------------------------------------------------------------- interrupt

test('停掉父任务会连它拆出来的活一起停', async (t) => {
  // The branches wait for a human approval, so they are still open when the
  // human stops the group.
  const model = {
    name: 'stub-slow',
    async plan() {
      const actions = [{ kind: 'reply', text: 'ok' }]
      actions.branches = [
        { label: '慢活', text: '慢活', actions: [{ kind: 'run_command', command: 'node --version', requiresApproval: true, summary: '等一下' }] },
        { label: '慢活二', text: '慢活二', actions: [{ kind: 'run_command', command: 'node --version', requiresApproval: true, summary: '等一下' }] },
      ]
      return actions
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '两件慢事' })
  // Wait until the group exists.
  for (let i = 0; i < 100; i += 1) {
    const turn = engine.getTurn(turnId)
    if (turn.childTurns?.length) break
    await new Promise((r) => setTimeout(r, 5))
  }
  const parent = engine.getTurn(turnId)
  assert.ok(parent.childTurns?.length, '应已拆出子任务')

  engine.interrupt(turnId)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(engine.getTurn(turnId).status, 'interrupted', '父任务被停')
  for (const id of parent.childTurns) {
    assert.equal(engine.getTurn(id).status, 'interrupted', '子任务也一起停')
  }
  const entries = engine.journal.all(bot.id)
  assert.ok(entries.filter((e) => e.kind === 'task/done' && e.status === 'interrupted').length >= 2,
    '每个被停的活都要有终态记录')
})

// ---------------------------------------------------------------- resume

test('拆过的父任务恢复时不再拆一次，避免重复干活', async (t) => {
  let calls = 0
  const model = {
    name: 'stub-count',
    async plan() {
      calls += 1
      const actions = [{ kind: 'reply', text: 'ok' }]
      actions.branches = [
        { label: 'A', text: 'A', actions: [{ kind: 'run_command', command: 'node --version', requiresApproval: true, summary: '等一下' }] },
        { label: 'B', text: 'B', actions: [{ kind: 'run_command', command: 'node --version', requiresApproval: true, summary: '等一下' }] },
      ]
      return actions
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({ botId: bot.id, text: '两件事' })
  for (let i = 0; i < 100; i += 1) {
    if (engine.getTurn(turnId).childTurns?.length) break
    await new Promise((r) => setTimeout(r, 5))
  }
  const parent = engine.getTurn(turnId)
  assert.equal(parent.branchCount, 2)

  // The human stops the group, then asks to continue it.
  engine.interrupt(turnId)
  await new Promise((r) => setTimeout(r, 20))
  const before = calls
  const resumed = engine.resume(turnId)
  assert.ok(resumed.accepted)
  await engine.waitForTurn(turnId)
  assert.equal(calls, before + 1, '恢复只重新规划一次')
  assert.equal(engine.getTurn(turnId).branchCount, 2, '恢复时不重复拆分')
})

// ---------------------------------------------------------------- fallback

test('模型忘了吐 branches 时，显式并列句由系统拆开并行', async (t) => {
  const plans = []
  const model = {
    name: 'stub-forget-branches',
    async plan(args) {
      plans.push(args)
      return [{ kind: 'reply', text: `处理：${args.text.slice(0, 12)}` }]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))

  const { turnId } = engine.sendMessage({
    botId: bot.id,
    text: '读一下 README.md 整理启动命令，并且看看 package.json 有哪些脚本',
  })
  await engine.waitForTurn(turnId)

  const parent = engine.getTurn(turnId)
  assert.equal(parent.status, 'completed')
  assert.equal(parent.branchCount, 2, '系统应拆成两支')
  const children = parent.childTurns.map((id) => engine.getTurn(id))
  assert.deepEqual(children.map((c) => c.status), ['completed', 'completed'])

  const entries = engine.journal.all(bot.id)
  assert.ok(entries.some((e) => e.kind === 'split' && e.count === 2), '时间线要有 split 节点')
  assert.ok(entries.some((e) => e.kind === 'activity' && /系统拆开并行做/.test(e.summary || '')),
    '系统拆分要在时间线上可见')
  assert.ok(plans.length >= 3, '应为两段各规划一次（外加原始规划）')
  assert.ok(plans.slice(1).some((p) => /README\.md/.test(p.text)))
  assert.ok(plans.slice(1).some((p) => /package\.json/.test(p.text)))
})

test('有依赖的第二句不拆，避免把一个任务劈成两半', async (t) => {
  const model = {
    name: 'stub-dependent',
    async plan() { return [{ kind: 'reply', text: 'ok' }] },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  const { turnId } = engine.sendMessage({
    botId: bot.id,
    text: '读一下 README.md 整理启动命令，并且基于这份材料写一份摘要',
  })
  await engine.waitForTurn(turnId)
  assert.equal(engine.getTurn(turnId).branchCount, undefined, '依赖句不该被拆')
  assert.equal(engine.journal.all(bot.id).filter((e) => e.kind === 'split').length, 0)
})

test('拆分兜底某段规划失败时，显式降级为单任务且不崩', async (t) => {
  let calls = 0
  const model = {
    name: 'stub-split-fails',
    async plan(args) {
      calls += 1
      if (calls === 2) throw new Error('模型服务不可达：fetch failed')
      return [{ kind: 'reply', text: `处理：${args.text.slice(0, 12)}` }]
    },
  }
  const { dir, engine, bot } = make({ model })
  t.after(() => cleanup(dir))
  const { turnId } = engine.sendMessage({
    botId: bot.id,
    text: '读一下 README.md 整理启动命令，并且看看 package.json 有哪些脚本',
  })
  await engine.waitForTurn(turnId)

  assert.equal(engine.getTurn(turnId).status, 'completed', '降级后仍要正常收口')
  assert.equal(engine.getTurn(turnId).branchCount, undefined, '失败时不硬拆')
  const entries = engine.journal.all(bot.id)
  assert.equal(entries.filter((e) => e.kind === 'split').length, 0)
  assert.ok(entries.some((e) => e.kind === 'activity' && /没能拆开并行/.test(e.summary || '')),
    '降级要在时间线上说清楚，不能静默')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.mjs'
import { CardBook } from '../src/cards.mjs'
import { ObservationLoop } from '../src/observer.mjs'

function stubModel(results = []) {
  const calls = []
  return {
    name: 'stub',
    calls,
    async plan() { return [{ kind: 'reply', text: 'ok' }] },
    async judge({ text, source, effort }) {
      calls.push({ text, source, effort })
      return results.shift() || { worthwhile: false, reason: 'stub-no' }
    },
  }
}

function make({ model = stubModel(), mode = 'observe' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p0a-observe-'))
  const engine = new Engine({ dataDir: dir, model })
  engine.cards = new CardBook(engine)
  const observer = new ObservationLoop(engine, { mode, intervalMs: 999999 })
  const bot = engine.createBot({ name: '它' })
  return { dir, engine, observer, bot, model }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('Fast Path：空/短/纯符号/噪音来源/重复都不调用模型', (t) => {
  const model = stubModel()
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  assert.equal(ctx.observer.observe({ text: '' }).accepted, false)
  assert.equal(ctx.observer.observe({ text: 'abc' }).accepted, false)
  assert.equal(ctx.observer.observe({ text: '123456' }).accepted, false)
  assert.equal(ctx.observer.observe({ source: 'heartbeat', text: '正常心跳信号' }).accepted, false)
  const first = ctx.observer.observe({ source: 'github', text: 'defect reported here' })
  const second = ctx.observer.observe({ source: 'github', text: 'defect reported here' })
  assert.equal(first.accepted, true)
  assert.equal(second.reason, 'duplicate')
  assert.equal(model.calls.length, 0)
  assert.equal(ctx.observer.status().filtered, 5)
})

test('低 effort 判否：不写时间线、不出卡片、不派 turn', async (t) => {
  const ctx = make()
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'github', text: '日常讨论内容' })
  await ctx.observer.flush()
  const entries = ctx.engine.journal.all(ctx.bot.id)
  assert.equal(entries.length, 1, '只有创建 Bot 的 system 行')
  assert.equal(ctx.model.calls[0].effort, 'low')
  assert.equal(ctx.observer.status().judgedNo, 1)
})

test('observe 默认：值得做的事只浮现卡片，不自动派 turn', async (t) => {
  const model = stubModel([{ worthwhile: true, reason: '疑似缺陷' }])
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'github', text: '#12 needs repro 报错' })
  await ctx.observer.flush()
  const entries = ctx.engine.journal.all(ctx.bot.id)
  assert.ok(entries.some((e) => e.kind === 'observation'))
  const card = entries.find((e) => e.kind === 'card' && e.cardType === 'observation-offer')
  assert.ok(card)
  assert.deepEqual(card.actions.map((a) => a.id), ['delegate', 'dismiss'])
  assert.equal(entries.some((e) => e.kind === 'user/message'), false, 'observe 不自动执行')
  assert.deepEqual(model.calls.map((c) => c.effort), ['low'])
  assert.equal(ctx.observer.status().offered, 1)
})

test('点「交给它」才派 turn；点「不用了」只记录', async (t) => {
  const model = stubModel([{ worthwhile: true, reason: '疑似缺陷' }])
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'github', text: '#12 needs repro 报错' })
  await ctx.observer.flush()
  const card = ctx.engine.journal.all(ctx.bot.id).find((e) => e.kind === 'card')
  const acted = ctx.engine.cards.resolve(card.cardId, 'delegate')
  assert.equal(acted.status, 'saved')
  assert.equal(acted.resultKind, 'turn')
  await ctx.engine.waitForTurn(acted.result.turnId)
  assert.ok(ctx.engine.journal.all(ctx.bot.id).some((e) => e.kind === 'user/message'))
})

test('auto 模式：低 effort 过了还要高 effort 复查，复查否就不派', async (t) => {
  const pass = make({ model: stubModel([
    { worthwhile: true, reason: 'coarse' }, { worthwhile: true, reason: 'fine' },
  ]), mode: 'auto' })
  t.after(() => cleanup(pass.dir))
  pass.observer.observe({ source: 'ci', text: 'build failed 报错' })
  await pass.observer.flush()
  assert.deepEqual(pass.model.calls.map((c) => c.effort), ['low', 'high'])
  assert.equal(pass.observer.status().delegated, 1)
  assert.ok(pass.engine.journal.all(pass.bot.id).some((e) => e.kind === 'user/message'))

  const reject = make({ model: stubModel([
    { worthwhile: true, reason: 'coarse' }, { worthwhile: false, reason: 'fine-no' },
  ]), mode: 'auto' })
  t.after(() => cleanup(reject.dir))
  reject.observer.observe({ source: 'ci', text: 'build failed 报错' })
  await reject.observer.flush()
  assert.equal(reject.observer.status().delegated, 0)
  assert.equal(reject.engine.journal.all(reject.bot.id).some((e) => e.kind === 'user/message'), false)
})

test('off 模式全部拒绝；去重在重启后仍生效', (t) => {
  const ctx = make({ mode: 'off' })
  t.after(() => cleanup(ctx.dir))
  assert.equal(ctx.observer.observe({ text: '报错 needs repro' }).reason, 'observer-off')

  const base = make()
  t.after(() => cleanup(base.dir))
  assert.equal(base.observer.observe({ source: 'github', text: 'same defect signal' }).accepted, true)
  const restarted = new ObservationLoop(new Engine({ dataDir: base.dir, model: stubModel() }), { mode: 'observe' })
  assert.equal(restarted.observe({ source: 'github', text: 'same defect signal' }).reason, 'duplicate')
})
test('judge 遇用量限制时重排队而不是丢事件，去抖后正常判否', async (t) => {
  const model = stubModel()
  let call = 0
  model.judge = async () => {
    call += 1
    if (call === 1) { const e = new Error('limit'); e.code = 'USAGE_LIMIT'; throw e }
    return { worthwhile: false, reason: 'stub-no' }
  }
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'github', text: '日常讨论' })
  await ctx.observer.flush()
  assert.equal(ctx.observer.status().rateLimited, 1, '限流计数 +1')
  assert.equal(ctx.observer.queue.length, 1, '事件被重新入队，不丢')
  assert.equal(ctx.observer.status().judgedNo, 0, '还没真正判过')
  await ctx.observer.flush()
  assert.equal(ctx.observer.status().judgedNo, 1, '重排后正常判否')
  assert.equal(ctx.observer.queue.length, 0)
})

test('judge 遇瞬时网络错误时也重排队，不静默丢事件', async (t) => {
  const model = stubModel()
  let call = 0
  model.judge = async () => {
    call += 1
    if (call === 1) {
      const e = new Error('模型服务不可达：fetch failed')
      e.code = 'AGENT_FAILED'
      throw e
    }
    return { worthwhile: true, reason: 'stub-yes' }
  }
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'ci', text: 'build failed 报错' })
  await ctx.observer.flush()
  assert.equal(ctx.observer.queue.length, 1, '网络抖动时事件要重排队，不能丢')
  assert.equal(ctx.engine.journal.all(ctx.bot.id).filter((e) => e.kind === 'observation/error').length, 0,
    '不该落成错误事件就丢弃')
  await ctx.observer.flush()
  assert.equal(ctx.observer.queue.length, 0, '重试后正常处理完')
  assert.equal(ctx.observer.status().offered, 1, '最终摆出了卡片')
})

test('judge 持续用量限制：封顶 5 次后失败闭合，不无限重排', async (t) => {
  const model = stubModel()
  model.judge = async () => { const e = new Error('limit'); e.code = 'USAGE_LIMIT'; throw e }
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'ci', text: 'build failed 报错' })
  for (let i = 0; i < 8; i += 1) await ctx.observer.flush()
  assert.equal(ctx.observer.queue.length, 0, '不再无限重排')
  assert.equal(ctx.observer.status().rateLimited, 5, '最多重排 5 次')
  assert.equal(ctx.observer.status().judgedNo, 1, '封顶后失败闭合（不打断）')
})
test('flush 与常驻循环互斥：不会并发发起两次真模型 judge', async (t) => {
  let active = 0
  let peak = 0
  let releaseFirst
  const gate = new Promise((r) => { releaseFirst = r })
  let call = 0
  const model = stubModel()
  model.judge = async () => {
    call += 1
    active += 1
    peak = Math.max(peak, active)
    if (call === 1) await gate
    active -= 1
    return { worthwhile: false, reason: 'no' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'p0a-observe-'))
  const engine = new Engine({ dataDir: dir, model })
  engine.cards = new CardBook(engine)
  const observer = new ObservationLoop(engine, { mode: 'observe', intervalMs: 10 })
  const bot = engine.createBot({ name: '它' })
  observer.start()
  t.after(() => { observer.stop(); cleanup(dir) })

  observer.observe({ source: 'ci', text: '第一条观察事件', botId: bot.id })
  for (let i = 0; i < 100 && call === 0; i += 1) await new Promise((r) => setTimeout(r, 5))
  assert.equal(call, 1, '定时器已开始第一次 judge')

  observer.observe({ source: 'ci', text: '第二条观察事件', botId: bot.id })
  const flushing = observer.flush()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(call, 1, '第一次 judge 未结束时，flush 不得并发发起第二次')
  assert.equal(observer.queue.length, 1, '第二条仍在队列里，不丢')

  observer.stop()  // 停掉定时器，让 flush 独自拿锁，避免竞争导致断言抖动
  releaseFirst()
  const n = await flushing
  assert.equal(n, 1, '锁释放后 flush 处理了第二条')
  assert.equal(peak, 1, '任意时刻只有一个 judge 在飞')
  assert.equal(observer.status().judgedNo, 2)
})

test('单条事件处理失败只落错误时间线，不拖垮整批 drain', async (t) => {
  const model = stubModel()
  let call = 0
  model.judge = async () => {
    call += 1
    if (call === 1) throw new Error('模型服务不可达')
    return { worthwhile: false, reason: 'ok' }
  }
  const ctx = make({ model })
  t.after(() => cleanup(ctx.dir))
  ctx.observer.observe({ source: 'ci', text: '第一条会失败的事件' })
  ctx.observer.observe({ source: 'ci', text: '第二条正常事件' })

  const n = await ctx.observer.flush()
  assert.equal(n, 2, '两条都被驱动')
  assert.equal(call, 2, '第一条失败没有打断第二条')
  const errs = ctx.engine.journal.all(ctx.bot.id).filter((e) => e.kind === 'observation/error')
  assert.equal(errs.length, 1, '错误如实落在时间线上')
  assert.equal(ctx.observer.status().judgedNo, 1)
})

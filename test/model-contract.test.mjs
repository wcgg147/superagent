import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeepSeekModel, JUDGE_SYSTEM } from '../src/providers.mjs'

const ok = (body) => ({ status: 200, body })
const message = (content) => ok({ choices: [{ message: { content } }] })

function fakeFetch(responses) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    calls.push({ body: JSON.parse(opts.body) })
    const next = responses.shift() || ok({ choices: [] })
    return { status: next.status, text: async () => JSON.stringify(next.body) }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const model = () => new DeepSeekModel({
  apiKey: 'fake', baseUrl: 'https://example.test', model: 'ds-test', reasoningEffort: 'high',
})
const bot = { name: '它', job: '协助用户' }

test('稳定 system 前缀：动态信息只在尾部 user，不改写开头', async (t) => {
  const f = fakeFetch([
    message('{"actions":[{"kind":"reply","text":"a"}]}'),
    message('{"actions":[{"kind":"reply","text":"b"}]}'),
  ])
  t.after(f.restore)
  const m = model()
  await m.plan({ text: '第一句', bot, memory: [] })
  await m.plan({ text: '第二句', bot, memory: [{ text: '之前的记忆' }] })
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].body.messages[0].content, f.calls[1].body.messages[0].content)
  assert.match(f.calls[0].body.messages[1].content, /第一句/)
  assert.match(f.calls[1].body.messages[1].content, /之前的记忆/)
})

test('reasoningEffort 是顶层旁路字段，不进 messages / 不增加输入 token', async (t) => {
  const f = fakeFetch([message('{"actions":[{"kind":"reply","text":"a"}]}')])
  t.after(f.restore)
  await model().plan({ text: 'x', bot, memory: [] })
  assert.equal(f.calls[0].body.reasoning_effort, 'high')
  assert.ok(!JSON.stringify(f.calls[0].body.messages).includes('reasoning_effort'))
})

test('judge 用独立稳定的观察哨 prompt 与 low effort', async (t) => {
  const f = fakeFetch([message('{"worthwhile":true,"reason":"疑似缺陷"}')])
  t.after(f.restore)
  const r = await model().judge({ text: 'CI 报错', source: 'ci', effort: 'low' })
  assert.equal(r.worthwhile, true)
  assert.equal(f.calls[0].body.reasoning_effort, 'low')
  assert.match(f.calls[0].body.messages[0].content, /观察哨/)
  assert.match(f.calls[0].body.messages[1].content, /CI 报错/)
})

test('content 为空时从 reasoning_content 兜底解析', async (t) => {
  const f = fakeFetch([
    ok({ choices: [{ message: { content: '', reasoning_content: '{"actions":[{"kind":"reply","text":"from-reasoning"}]}' } }] }),
  ])
  t.after(f.restore)
  const actions = await model().plan({ text: 'x', bot, memory: [] })
  assert.equal(actions[0].text, 'from-reasoning')
})

test('网关不支持 response_format/reasoning_effort 时降级重发', async (t) => {
  const f = fakeFetch([
    { status: 400, body: { error: { message: 'response_format not supported' } } },
    message('{"actions":[{"kind":"reply","text":"retry-ok"}]}'),
  ])
  t.after(f.restore)
  const actions = await model().plan({ text: 'x', bot, memory: [] })
  assert.equal(f.calls.length, 2)
  assert.equal('response_format' in f.calls[1].body, false)
  assert.equal('reasoning_effort' in f.calls[1].body, false)
  assert.equal(actions[0].text, 'retry-ok')
})

test('compose 第二阶段：稳定 system 前缀，材料只放尾部 user，effort 仍是旁路', async (t) => {
  const f = fakeFetch([
    message('{"actions":[{"kind":"reply","text":"a"}]}'),
    message('{"content":"# 正文\\n\\n真实片段"}'),
    message('{"content":"# 正文2"}'),
  ])
  t.after(f.restore)
  const m = model()
  const materials = [{ title: 'sort.js', snippet: 'function sortItems() {}' }]
  await m.plan({ text: 'plan', bot, memory: [] })
  const first = await m.compose({ text: '写文档', materials })
  const second = await m.compose({ text: '再写', materials: [] })

  assert.equal(first, '# 正文\n\n真实片段')
  assert.equal(second, '# 正文2')
  const c1 = f.calls[1].body
  const c2 = f.calls[2].body
  assert.equal(c1.messages[0].content, c2.messages[0].content, 'compose 的 system 前缀不随材料变化')
  assert.match(c1.messages[0].content, /交付物撰写器/)
  const u1 = JSON.parse(c1.messages[1].content)
  assert.equal(u1.materials[0].snippet, 'function sortItems() {}')
  assert.ok(!c1.messages[0].content.includes('sortItems'), 'system 不能带动态材料')
  assert.equal(c1.reasoning_effort, 'high')
})
test('judge 解析容错：模型用 ```json 围栏包裹也能抽到 worthwhile', async (t) => {
  const f = fakeFetch([message('```json\n{"worthwhile":true,"reason":"疑似缺陷"}\n```')])
  t.after(f.restore)
  const r = await model().judge({ text: 'CI 报错', source: 'ci', effort: 'low' })
  assert.equal(r.worthwhile, true)
  assert.equal(r.reason, '疑似缺陷')
})

test('judge 解析容错：content 为空时从 reasoning_content 兜底', async (t) => {
  const f = fakeFetch([ok({ choices: [{ message: { content: '', reasoning_content: '{"worthwhile":false,"reason":"日常信息"}' } }] })])
  t.after(f.restore)
  const r = await model().judge({ text: 'star 到 1000', source: 'github', effort: 'low' })
  assert.equal(r.worthwhile, false)
})

test('judge 解析容错：非法 JSON 失败闭合（宁可漏也不误打扰）', async (t) => {
  const f = fakeFetch([message('抱歉，我无法判断这条消息')])
  t.after(f.restore)
  const r = await model().judge({ text: '随便一句闲聊', source: 'slack', effort: 'low' })
  assert.equal(r.worthwhile, false)
  assert.equal(r.reason, 'unparseable')
})

test('judge 遇 429 退避重试，最终仍返回结果', async (t) => {
  const f = fakeFetch([
    { status: 429, body: { error: { message: 'rate limit' } } },
    { status: 429, body: { error: { message: 'rate limit' } } },
    message('{"worthwhile":true,"reason":"告警"}'),
  ])
  t.after(f.restore)
  const r = await model().judge({ text: '磁盘快满了', source: 'email', effort: 'low' })
  assert.equal(r.worthwhile, true)
  assert.equal(f.calls.length, 3, '退避重试到第三次拿到 200')
})

test('judge 持续 429 抛出用量限制（交由 observer 重排队而非静默丢失）', async (t) => {
  const f = fakeFetch(Array.from({ length: 6 }, () => ({ status: 429, body: { error: { message: 'rate limit' } } })))
  t.after(f.restore)
  await assert.rejects(
    () => model().judge({ text: 'x', source: 'ci', effort: 'low' }),
    (e) => e.code === 'USAGE_LIMIT',
  )
})

test('JUDGE_SYSTEM 明示「一般用户提问属噪音、不打断」，覆盖低打扰边界', (t) => {
  // 直接断言 prompt 意图，防止后续改写把低打扰边界改丢。
  const sys = JUDGE_SYSTEM
  assert.ok(/观察哨/.test(sys))
  assert.ok(/缺陷|报错|失败|告警/.test(sys), '必须保留「真问题」信号词')
  assert.ok(/噪音/.test(sys), '必须明说什么是噪音')
  assert.ok(/不打断/.test(sys), '必须明示不打断用户')
})

test('模型没给 reply 时，兜底 reply 诚实且标记 fallback，不再谎称做完', async (t) => {
  const f = fakeFetch([message('{"actions":[{"kind":"browse","query":"材料"}]}')])
  t.after(f.restore)
  const actions = await model().plan({ text: '读一下材料', bot, memory: [] })
  const reply = actions.find((a) => a.kind === 'reply')
  assert.ok(reply, '至少要有一个 reply')
  assert.equal(reply.fallback, true)
  assert.ok(!/做完了|已完成/.test(reply.text), `不能假装完成：${reply.text}`)
  assert.ok(actions.some((a) => a.kind === 'browse'), '模型给的动作要保留')
})

test('模型给了空文本 reply，同样标记 fallback 而不是当成真答复', async (t) => {
  const f = fakeFetch([message('{"actions":[{"kind":"reply","text":"  "}]}')])
  t.after(f.restore)
  const actions = await model().plan({ text: 'x', bot, memory: [] })
  assert.equal(actions[0].fallback, true)
  assert.ok(!/做完了/.test(actions[0].text))
})

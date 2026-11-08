import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCopy } from '../web/error-copy.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const words = (c) => `${c.title} ${c.detail}`

// Anything that looks like an internal identifier or a raw error object must
// never appear in the words a person reads on the timeline.
const LEAK = /DEEPSEEK_|NO_CREDENTIAL|USAGE_LIMIT|AGENT_FAILED|DSH_|ENTITLEMENT|TRANSPORT|__status|response_format|AppError|LocalExecutor|ECONN|fetch failed|timeout|timed out|TypeError|ReferenceError|Cannot read|undefined|null/i

const CREDENTIAL_401 = {
  kind: 'error', code: 'NO_CREDENTIAL', family: 'entitlement',
  title: '模型密钥未被接受', detail: '请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配',
}

// ---------------------------------------------------------------- pure function

test('代理瞬断落 NO_CREDENTIAL(401/403)：中文、不甩环境变量名、明确不用改配置', () => {
  const c = errorCopy(CREDENTIAL_401)
  assert.equal(c.title, '模型服务这次没接上')
  assert.ok(!LEAK.test(words(c)), '不能出现 DEEPSEEK_API_KEY / NO_CREDENTIAL 等内部名')
  assert.match(c.detail, /再发一次/)
  assert.match(c.detail, /不用改本机配置/, '上一轮真模型实跑里用户被误导去改配置，这里必须反过来')
  assert.equal(c.quiet, true, '可自行重试的瞬断不该是刺眼红块')
})

test('另一种 NO_CREDENTIAL 原文（还没配置模型密钥 / 本地模拟）同样脱敏', () => {
  const c = errorCopy({
    code: 'NO_CREDENTIAL', family: 'entitlement',
    title: '还没有配置模型密钥',
    detail: '设置 DEEPSEEK_API_KEY 后即可使用真实模型，当前为本地模拟模式',
  })
  assert.ok(!LEAK.test(words(c)))
  assert.match(c.detail, /再发一次/)
  assert.equal(c.quiet, true)
})

test('老记录丢了 code，只要原文还带内部名也照样兜住', () => {
  const c = errorCopy({ title: '模型密钥未被接受', detail: '请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配' })
  assert.equal(c.title, '模型服务这次没接上')
  assert.ok(!LEAK.test(words(c)))
})

test('USAGE_LIMIT：额度/限流单独成族、中文明确，且仍醒目（方案 §2 的反面教训）', () => {
  const c = errorCopy({
    code: 'USAGE_LIMIT', family: 'entitlement',
    title: '用量已用完', detail: '本周额度已用尽，请升级或等待重置',
  })
  assert.match(c.title, /额度|限流/)
  assert.match(c.detail, /用量到上限|额度|用量/)
  assert.ok(!LEAK.test(words(c)))
  assert.equal(c.quiet, false, '这是真条件，不能糊成「再发一次就行」')
})

test('网络/服务端瞬断（503 / fetch failed / ECONN / timeout / 429）统一低调文案', () => {
  for (const detail of ['模型服务返回 503：bad gateway', 'fetch failed', 'ECONNRESET', '请求 timeout', '上游 429 限流']) {
    const c = errorCopy({ code: 'AGENT_FAILED', family: 'agent', title: 'Bot 没能完成这一步', detail })
    assert.equal(c.title, '刚才没连上模型')
    assert.match(c.detail, /再发一次/)
    assert.ok(!LEAK.test(words(c)), `不该把 ${detail} 原样甩给用户`)
    assert.equal(c.quiet, true)
  }
})

test('停在第 N 步（可续跑的暂停态）：说清现场已保留、点「接着做」', () => {
  const c = errorCopy({ title: '刚没连上模型', detail: '停在第 1/2 步：模型服务返回 503' })
  assert.match(c.title, /这一步先停住了/)
  assert.match(c.detail, /接着做/)
  assert.match(c.detail, /现场已保留/)
  assert.ok(!LEAK.test(words(c)))
  assert.equal(c.quiet, true)
})

test('程序侧明确拒绝（白名单 / 版本钉扎 / 完整性 / 未接入）保留诚实的中文原文', () => {
  const cases = [
    { code: 'COMMAND_NOT_ALLOWED', family: 'agent', title: '这条命令没被允许', detail: '本机执行器只允许白名单命令，收到：rm' },
    { code: 'DSH_VERSION_MISMATCH', family: 'agent', title: 'DSH 版本与钉扎版本不一致', detail: '钉住 0.2.1-rc.5，实际 0.2.1-rc.2；升级适配层后再改钉扎常量' },
    { code: 'ARTIFACT_INTEGRITY', family: 'agent', title: '交付物没能正确写入', detail: '写完后回读与预期不一致，请重新生成一次。' },
  ]
  for (const e of cases) {
    const c = errorCopy(e)
    assert.equal(c.title, e.title, '明确的拒绝理由不能被通用文案盖掉')
    assert.ok(!LEAK.test(words(c)))
    assert.equal(c.quiet, false, '需要用户知道的事仍用醒目样式')
  }
  // An internal implementation name slipped into a kept message: drop that
  // line, keep the honest Chinese title.
  const notImpl = errorCopy({
    code: 'NOT_IMPLEMENTED', title: '远端执行面尚未接入',
    detail: '远端执行面是预留的执行面 provider，请切换到 LocalExecutor 或完成接入',
  })
  assert.equal(notImpl.title, '远端执行面尚未接入')
  assert.ok(!LEAK.test(words(notImpl)))
  assert.equal(notImpl.quiet, false)
})

test('英文错误对象 / 内部名混进 detail：降级成通用中文，不把原始错误甩给用户', () => {
  const c = errorCopy({
    code: 'AGENT_FAILED', family: 'agent',
    title: '出错了', detail: 'TypeError: Cannot read properties of undefined',
  })
  assert.equal(c.title, '出错了')
  assert.match(c.detail, /现场已保留/)
  assert.ok(!LEAK.test(words(c)))
})

test('showError 用的 Error 对象（message 而非 detail）一样脱敏、中文化', () => {
  const c = errorCopy(Object.assign(new Error('请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配'), {
    title: '模型密钥未被接受', family: 'entitlement', code: 'NO_CREDENTIAL',
  }))
  assert.equal(c.title, '模型服务这次没接上')
  assert.ok(!LEAK.test(words(c)))
  assert.equal(c.quiet, true)
})

test('空输入 / 非对象 / 未知字段：不抛错，仍给出中文化的下一步', () => {
  for (const e of [null, undefined, 'x', 42, {}, { someFutureField: true }]) {
    const c = errorCopy(e)
    assert.ok(/[一-龥]/.test(words(c)))
    assert.ok(!LEAK.test(words(c)))
  }
  assert.equal(errorCopy({}).quiet, true, '无分类的本地失败属可重试，低打扰')
})

test('所有固定文案：中文化、零内部名、零 HTML 特殊字符（供 app.js esc 前后都安全）', () => {
  const fixed = [
    errorCopy(CREDENTIAL_401),
    errorCopy({ code: 'USAGE_LIMIT', detail: '本周额度已用尽' }),
    errorCopy({ code: 'AGENT_FAILED', detail: 'fetch failed' }),
    errorCopy({ detail: '停在第 2/3 步：不可达' }),
    errorCopy({}),
    errorCopy(null),
  ]
  for (const c of fixed) {
    assert.ok(/[一-龥]/.test(words(c)))
    assert.ok(!LEAK.test(words(c)))
    assert.ok(!/[<>&"']/.test(words(c)))
  }
})

test('返回契约恒定：恰好 title / detail / quiet，且类型正确', () => {
  for (const e of [null, {}, { code: 'X' }, CREDENTIAL_401, { code: 'USAGE_LIMIT' }, { detail: '停在第 1/1 步' }]) {
    const c = errorCopy(e)
    assert.deepEqual(Object.keys(c).sort(), ['detail', 'quiet', 'title'])
    assert.equal(typeof c.title, 'string')
    assert.equal(typeof c.detail, 'string')
    assert.equal(typeof c.quiet, 'boolean')
    assert.ok(c.title.length && c.detail.length, '永不返回空白')
  }
})

test('保留的长原文有界截断，不把整段错误对象铺在时间线上', () => {
  const c = errorCopy({ code: 'ARTIFACT_INTEGRITY', title: '交付物没能正确写入', detail: '测'.repeat(300) })
  assert.ok(c.detail.length <= 201)
  assert.match(c.detail, /…$/)
  assert.equal(c.title, '交付物没能正确写入')
})

// ---------------------------------------------------------------- wiring / invariants

test('app.js 接线：时间线 error 与本地 showError 都走纯函数并 esc', () => {
  const src = read('web/app.js')
  assert.match(src, /import \{ errorCopy \} from '\.\/error-copy\.js'/)
  assert.match(src, /const c = errorCopy\(e\)/)
  assert.match(src, /const c = errorCopy\(err\)/)
  assert.match(src, /esc\(c\.title\)/)
  assert.match(src, /esc\(c\.detail\)/)
  assert.match(src, /row error\$\{c\.quiet \? ' quiet' : ''\}/)
  assert.ok(!/const transient = \/不可达/.test(src), '旧的脆弱 detail 正则已由结构化分类取代')
  assert.ok(!/DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|NO_CREDENTIAL/.test(src), '前端不得硬编码内部变量名')
})

test('禁改区守卫：cursor / seen / SSE 过滤未动，error 分支唯一，交付物诚实信号仍在', () => {
  const src = read('web/app.js')
  assert.match(src, /state\.cursor = 0/)
  assert.match(src, /state\.seen\.clear\(\)/)
  assert.match(src, /if \(msg\.type === 'entry' && msg\.botId === state\.botId\) renderEntry\(msg\.entry\)/)
  assert.equal((src.match(/case 'error': \{/g) || []).length, 1)
  assert.equal((src.match(/case 'artifact': \{/g) || []).length, 1)
  assert.match(src, /const notes = artifactNotes\(e\)/)
})

test('纯模块 UI-only：不写时间线、不发请求、不碰 DOM', () => {
  const src = read('web/error-copy.js')
  for (const forbidden of ['document.', 'fetch(', 'appendChild', 'journal', 'localStorage', 'EventSource', 'innerHTML']) {
    assert.ok(!src.includes(forbidden), `error-copy.js 不该出现 ${forbidden}`)
  }
  assert.match(src, /export function errorCopy/)
})

test('样式：瞬断柔和暖色，真正需要用户注意的错误仍保持醒目', () => {
  const css = read('web/style.css')
  assert.match(css, /\.row\.error\.quiet \{/)
  assert.match(css, /#fffaf0/, '与交付物降级提示一致的暖色，不新增红色告警')
  assert.match(css, /\.row\.error \{ flex-direction:column; border:1px solid #f2c4c4/, '原醒目样式未被削弱')
})

test('src/providers.mjs 错误族与码一行未改：内部文案留给 journal，前端只做呈现', () => {
  const src = read('src/providers.mjs')
  assert.match(src, /export const Family = \{ TRANSPORT: 'transport', ENTITLEMENT: 'entitlement', AGENT: 'agent' \}/)
  assert.match(src, /noCredential: \(\) => new AppError\(Family\.ENTITLEMENT, 'NO_CREDENTIAL'/)
  assert.match(src, /usageLimit: \(\) => new AppError\(Family\.ENTITLEMENT, 'USAGE_LIMIT'/)
  assert.match(src, /请检查 DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 是否匹配/, '结构化内部文案原样保留')
})

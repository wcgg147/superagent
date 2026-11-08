import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const acceptance = join(root, 'acceptance')
const read = (p) => readFileSync(p, 'utf8')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// Same normalizer as the sanitize generator: hide read_key() so the rest of the
// file (all check(...) assertions, ports, reports) can be hashed as one unit.
const READ_KEY = /def read_key\(\):[\s\S]*?(?=\r?\ndef |\r?\n\r?\nclass |\r?\n[a-zA-Z_]+\s*=)/
const assertionsSha = (p) => createHash('sha256').update(read(p).replace(READ_KEY, '<<<READ_KEY>>>'), 'utf8').digest('hex')

function pyFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue
      out.push(...pyFiles(p))
    } else if (name.endsWith('.py')) out.push(p)
  }
  return out
}

test('确定性验收清单 13 个哈希与项目内文件一致', () => {
  const m = JSON.parse(read(join(acceptance, 'manifest.json')))
  assert.equal(Object.keys(m.files).length, 13)
  for (const [rel, expected] of Object.entries(m.files)) {
    const p = join(acceptance, rel)
    assert.ok(existsSync(p), `缺少 ${rel}`)
    assert.equal(sha(p), expected, `${rel} 被改动：断言变更须先走 AGENTS.md §3`)
  }
})

test('真模型验收清单 11 个逐字节原始哈希与项目内文件一致', () => {
  const m = JSON.parse(read(join(acceptance, 'manifest-real.json')))
  assert.equal(Object.keys(m.files).length, 11)
  for (const [rel, expected] of Object.entries(m.files)) {
    const p = join(acceptance, rel)
    assert.ok(existsSync(p), `缺少 ${rel}`)
    assert.equal(sha(p), expected, `${rel} 被改动`)
  }
})

test('项目内任何验收脚本都不得从会话日志抠 key（AGENTS.md §2）', () => {
  const bad = []
  for (const p of pyFiles(acceptance)) {
    const text = read(p)
    if (/sessions\\.*\.jsonl|re\.findall\(r["']sk-/.test(text)) bad.push(relative(root, p))
  }
  assert.deepEqual(bad, [], 'key 只能通过命令环境变量注入，绝不从日志/文件读取')
})

test('5 个脱敏版：违规原版不得进项目，断言区与原始逐字一致', () => {
  const m = JSON.parse(read(join(acceptance, 'manifest-real.json')))
  const entries = Object.entries(m.sanitized.files)
  assert.equal(entries.length, 5)
  for (const [rel, meta] of entries) {
    const p = join(acceptance, rel)
    assert.ok(existsSync(p), `缺少 ${rel}`)
    assert.equal(sha(p), meta.sha256, `${rel} 脱敏版被改动`)
    assert.notEqual(sha(p), meta.originalSha256, `${rel} 违规原版形态不得出现在项目内`)
    assert.equal(meta.assertionsSha256, meta.originalAssertionsSha256, `${rel} 清单里断言区哈希必须自洽`)
    assert.equal(assertionsSha(p), meta.assertionsSha256, `${rel} check(...) 断言区与原始不一致`)
  }
})

test('run-real.mjs 只把 key 放进子进程 env：不写文件、不打印值', () => {
  const src = read(join(acceptance, 'run-real.mjs'))
  assert.ok(!/writeFile|appendFile|createWriteStream|rmSync/.test(src), '驱动不得写任何文件')
  assert.ok(!/console\.(log|error)\([^)]*\$\{?key\}?/.test(src), '驱动不得把 key 值打进日志')
  assert.match(src, /env\.DSH_TEST_KEY = key/, '应通过子进程 env 注入')
  assert.match(src, /env\.DEEPSEEK_API_KEY = key/, '两种历史变量名都要覆盖')
  assert.match(src, /REAL_ACCEPTANCE=NOT_VERIFIED/, '无 key 必须明确未验证，不能冒充通过')
})

test('npm 脚本：acceptance 与 acceptance:real 都在，test/check 未被动过', () => {
  const p = JSON.parse(read(join(root, 'package.json')))
  assert.equal(p.scripts.acceptance, 'node acceptance/run.mjs')
  assert.equal(p.scripts['acceptance:real'], 'node acceptance/run-real.mjs')
  assert.match(p.scripts.test, /browse-page\.test\.mjs/)
  assert.match(p.scripts.check, /browse-page\.test\.mjs/)
  assert.match(p.scripts.test, /artifact-pages\.test\.mjs/, '新增长文档交付测试必须注册')
  assert.match(p.scripts.check, /artifact-pages\.test\.mjs/)
  assert.match(p.scripts.test, /acceptance-guard\.test\.mjs/, '新增守卫必须注册')
  assert.match(p.scripts.check, /acceptance-guard\.test\.mjs/)
})

test('5 个脱敏版 read_key 只读命令环境变量，不碰任何文件', () => {
  const m = JSON.parse(read(join(acceptance, 'manifest-real.json')))
  for (const [rel] of Object.entries(m.sanitized.files)) {
    const text = read(join(acceptance, rel))
    assert.match(text, /return os\.environ\.get\("DSH_TEST_KEY", ""\)\.strip\(\) or None/, `${rel} 必须只读 env`)
    assert.ok(!/open\(|\.jsonl|sessions\\|re\.findall/.test(text.split('def read_key():')[1].split(/\r?\ndef /)[0]),
      `${rel} 的 read_key 里不得有任何文件读取或正则抠 key`)
  }
})

test('run-real.mjs 编排包含 5 个脱敏版与 soak_all 定时器自驱', () => {
  const src = read(join(acceptance, 'run-real.mjs'))
  for (const name of ['trunc_accept.py', 'soak_all.py', 'multibot_accept.py', 'p12_accept.py', 'nudge_accept.py']) {
    assert.ok(src.includes(`real/${name}`), `${name} 应接入有 key 的编排`)
  }
  assert.match(src, /timers: true/, 'soak_all 要标注为 §5 step 4 定时器自驱')
  assert.match(src, /SANITIZED \$\{/, '驱动要如实说明脱敏版，不冒充逐字节原始')
  assert.match(src, /SYNCED \$\{/, '驱动要如实说明断言同步版')
})

test('清单结构完整：11 原始 + 5 脱敏 + 1 断言同步，且不含过时的 excluded_conflict', () => {
  const m = JSON.parse(read(join(acceptance, 'manifest-real.json')))
  assert.equal(Object.keys(m.files).length, 11)
  assert.equal(Object.keys(m.sanitized.files).length, 5)
  assert.equal(Object.keys(m.synced.files).length, 1)
  assert.equal(m.excluded_conflict, undefined, '冲突已消解，不应再留过时状态')
  assert.deepEqual(m.key_env, ['DSH_TEST_KEY', 'DEEPSEEK_API_KEY'])
  // The synced file is NOT byte-identical to its original, but its new hash is
  // pinned, and the single-outbox invariant still covers ALL replies.
  const meta = m.synced.files['real/conc_e2e_real.py']
  const p = join(acceptance, 'real', 'conc_e2e_real.py')
  assert.equal(sha(p), meta.sha256)
  assert.notEqual(meta.sha256, meta.originalSha256)
  const text = read(p)
  assert.match(text, /interjection acks also come from the single outbox/, '新断言必须补上')
  assert.match(text, /all\(e\.get\("viaOutbox"\) is True for e in all_replies\)/, '统一出口检查仍覆盖全部回复，未放宽')
  assert.match(text, /acks = \[e for e in all_replies if e\.get\("interjection"\)\]/, '应按插话标记拆分')
})

test('驱动判定以脚本自身 RESULT= 为准，不把状态值 failed 误判为失败', () => {
  // Real bug found in the first keyed run: dsh_real_accept.py printed
  // RESULT=VERIFIED / HARD 23/23 but also `turn 不是 completed  failed`
  // as a normal status value, and the old bare /FAILED/i regex marked it FAIL.
  const src = read(join(acceptance, 'run-real.mjs'))
  assert.ok(src.includes('RESULT=(VERIFIED|ACCEPTED'), '应优先采用脚本自身的结论行')
  assert.ok(!src.includes('|FAILED|Traceback/i'), '裸 FAILED 正则会误判普通状态值')
  assert.ok(src.includes('turn 不是 completed  failed'), '应保留该回归案例的说明')
  assert.ok(src.includes('SUMMARY:\\s*(\\d+)\\/(\\d+)\\s+passed'), '无 RESULT 时用 SUMMARY 判定')
})

test('长文档交付：engine 从时间线读回本 turn 全部 browse 页，不建第二套记忆', () => {
  const src = read(join(root, 'src', 'engine.mjs'))
  assert.match(src, /export function collectTurnMaterials/, '纯函数应可单测')
  assert.match(src, /collectTurnMaterials\(this\.journal\.all\(turn\.botId\), turn\.id\)/, '材料来源必须是时间线')
  assert.match(src, /e\.turnId !== turnId/, '并发按 turnId 隔离，不串别的 turn')
  assert.match(src, /gathered\.clipped \?/, '超预算要诚实标注')
  assert.ok(!src.includes('let source = turn.lastBrowse?.items'), '旧实现（只取最后一页）应被替换')
  const providers = read(join(root, 'src', 'providers.mjs'))
  assert.match(providers, /export const COMPOSE_BUDGET = 16000/, 'compose 预算不变')
  assert.match(src, /const integrity = landed === null \? null : landed === content/, '写完回读校验不变')
})

test('分段 compose：预算仍是 16000，providers.mjs 的裁剪逻辑与稳定前缀未动', () => {
  const engine = read(join(root, 'src', 'engine.mjs'))
  const providers = read(join(root, 'src', 'providers.mjs'))
  assert.match(providers, /export const COMPOSE_BUDGET = 16000/, '预算不许抬高')
  assert.match(providers, /if \(used \+ snippet\.length > COMPOSE_BUDGET && picked\.length\) break/, 'composeUser 裁剪逻辑未改')
  assert.match(providers, /system: COMPOSE_SYSTEM/, '稳定 system 前缀契约不变')
  assert.match(engine, /export function splitMaterialsForCompose/, '纯函数应可单测')
  assert.match(engine, /splitMaterialsForCompose\(source, COMPOSE_BUDGET\)/, '分批必须用同一个预算常量')
  assert.match(engine, /composeBatches = batches\.length/, '记录分批数')
  assert.match(engine, /composeDegraded = batches\.length > 1/, '失败要整体降级、显式标注')
  assert.match(engine, /parts\.join\('\\n\\n'\)/, '分批产出按序拼接')
  assert.match(engine, /collectTurnMaterials\(this\.journal\.all\(turn\.botId\), turn\.id\)/, '材料仍从时间线现读')
  assert.ok(!engine.includes('materials: source, bot: this.getBot(turn.botId)'), '旧的一次性 compose 调用应被替换')
})

test('npm 脚本注册了新的分段 compose 测试（只增）', () => {
  const p = JSON.parse(read(join(root, 'package.json')))
  assert.match(p.scripts.test, /compose-batches\.test\.mjs/)
  assert.match(p.scripts.check, /compose-batches\.test\.mjs/)
  assert.match(p.scripts.test, /artifact-pages\.test\.mjs/, '既有长文档交付测试仍在')
})

test('组合验收驱动：固化 3211 服务 + 三份夹具 + 5 脚本，不碰 pinned 断言', () => {
  const p = join(acceptance, 'run-composition.mjs')
  assert.ok(existsSync(p), '组合驱动应存在')
  const src = read(p)
  assert.match(src, /const PORT = 3211/, '5 个脚本硬编码 3211，驱动必须与之对齐')
  assert.match(src, /never kills an existing service/, '端口占用时不许杀别人的服务')
  assert.match(src, /COMPOSITION=NOT_VERIFIED/, '无 key 必须明确未验证')
  assert.match(src, /COMPOSITION=SKELETON_VERIFIED/, '--mock 只证明编排，不冒充模型结论')
  assert.match(src, /redact/, '输出要脱敏')
  const fixtureBody = src.split('function fixtures')[1]?.split('function serviceEnv')[0] || ''
  assert.ok(!/\bkey\b|DSH_TEST_KEY|DEEPSEEK_API_KEY/.test(fixtureBody), '夹具里绝不能写入任何凭据')
  assert.match(src, /const key = process\.env\.DSH_TEST_KEY \|\| process\.env\.DEEPSEEK_API_KEY/, 'key 只从命令 env 读')
  for (const name of ['delivery_accept.py', 'entity_accept.py', 'interject_accept.py', 'split_accept.py', 'split_quant.py']) {
    assert.ok(src.includes(name), `${name} 应纳入编排`)
    const script = read(join(acceptance, 'real', name))
    assert.match(script, /"http:\/\/127\.0\.0\.1:3211"/, `${name} 的服务地址不许被改`)
  }
})

test('npm 脚本注册了组合验收入口（只增）', () => {
  const p = JSON.parse(read(join(root, 'package.json')))
  assert.equal(p.scripts['acceptance:composition'], 'node acceptance/run-composition.mjs')
  assert.equal(p.scripts.acceptance, 'node acceptance/run.mjs', '确定性 243 入口不变')
  assert.equal(p.scripts['acceptance:real'], 'node acceptance/run-real.mjs', '真模型入口不变')
})

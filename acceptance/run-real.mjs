// Real-model / combination acceptance driver (AGENTS.md §5 step 3 + step 4).
//
// It is deliberately NOT part of `npm run acceptance`: that command is the
// deterministic 243-item gate and must stay green without any key. This driver
// has three modes:
//
//   node acceptance/run-real.mjs --list    inventory + integrity + key/dep status, runs nothing
//   node acceptance/run-real.mjs           no key -> run the 2 deterministic
//                                         scenario scripts, then report the
//                                         real-model part as NOT_VERIFIED
//   DSH_TEST_KEY=... node acceptance/run-real.mjs
//                                         run the self-contained real-model
//                                         suites (key passed ONLY through
//                                         child process env; never printed,
//                                         never written to any file)
//
// A NOT_VERIFIED is not a pass. Nothing here claims "全功能跑通".
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PY = process.env.PYTHON || 'python'
const scratch = process.env.PI_SCRATCH_DIR || tmpdir()
const listOnly = process.argv.slice(2).includes('--list')

const baseManifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))
const realManifest = JSON.parse(readFileSync(join(here, 'manifest-real.json'), 'utf8'))

// Deterministic scenarios: local stub model, no third-party key needed.
const DETERMINISTIC = [
  { rel: 'real/capability_probe.py', label: '能力探针（14 件工作，stub）', marker: /\bok\b/i },
  { rel: 'real/task_battery.py', label: '真实任务剧本跑批（stub）', marker: /invariants OK/i },
]
// Self-contained real-model suites: they start their own service / call the API.
const SELF_CONTAINED = [
  { rel: 'e2e/e2e_real.py', label: '真模型单链路（11 项）' },
  { rel: 'real/observe_e2e_real.py', label: '主动观察端到端（24 条结构断言）' },
  { rel: 'real/conc_e2e_real.py', label: '并发 turn 真模型（17 条）' },
  { rel: 'real/judge_probe.py', label: '观察哨 27 条标注样本（直接打 API）' },
  { rel: 'real/real_model_probe.py', label: '14 件能力矩阵（直接打 API）' },
  { rel: 'real/dsh_real_accept.py', label: 'DSH 真实 CLI HARD 23/23', needsDshCli: true },
  // Sanitized versions: only read_key() was changed to an env-only lookup.
  { rel: 'real/trunc_accept.py', label: '截断诚实性 HARD 5/5 + SOFT（脱敏版）' },
  { rel: 'real/multibot_accept.py', label: '多 Bot / 群聊 / SSE HARD 30/30（脱敏版）' },
  { rel: 'real/p12_accept.py', label: 'P1/P2 真模型 HARD 23/23（脱敏版）' },
  { rel: 'real/nudge_accept.py', label: '主动回访真模型 9/9（脱敏版）' },
  { rel: 'real/soak_all.py', label: '全功能联调：三个常驻循环定时器自驱（脱敏版，§5 step 4）', timers: true },
]
// These connect to an ALREADY RUNNING service on 3211. Not auto-started: the
// composition is unverified in this session, so it must not be presented as
// if it had run. See acceptance/README.md for the exact manual procedure.
const ATTACHED = [
  'real/delivery_accept.py', 'real/entity_accept.py', 'real/interject_accept.py',
  'real/split_accept.py', 'real/split_quant.py',
]

// ---------------------------------------------------------------- integrity
const problems = []
const sanitizedFiles = realManifest.sanitized?.files || {}
const syncedFiles = realManifest.synced?.files || {}
const expected = {
  ...baseManifest.files,
  ...realManifest.files,
  ...Object.fromEntries(Object.entries(sanitizedFiles).map(([rel, meta]) => [rel, meta.sha256])),
  ...Object.fromEntries(Object.entries(syncedFiles).map(([rel, meta]) => [rel, meta.sha256])),
}
let verified = 0
for (const [rel, hash] of Object.entries(expected)) {
  const p = join(here, rel)
  if (!existsSync(p)) { problems.push(`missing: ${rel}`); continue }
  const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (actual !== hash) problems.push(`MODIFIED: ${rel} (assertion change must go through AGENTS.md §3)`)
  else verified++
}
for (const [rel] of Object.entries(expected)) {
  if (!rel.endsWith('.py')) continue
  const text = readFileSync(join(here, rel), 'utf8')
  // BASE is sometimes a service URL (http://127.0.0.1:3211), so only a value
  // that starts with a drive letter can be the hardcoded workspace path.
  for (const m of text.matchAll(/^(?:WORKSPACE|BASE)\s*=\s*r?"([A-Za-z]:[\\/][^"]+)"/gm)) {
    if (resolve(m[1]) !== root) problems.push(`hardcoded workspace in ${rel}: ${m[1]} != ${root}`)
  }
  // Hard guard: no script in the project may fish a key out of a session log.
  if (/sessions\\.*\.jsonl|re\.findall\(r["']sk-/.test(text)) {
    problems.push(`UNSAFE key source in ${rel}: conflicts with AGENTS.md §2`)
  }
}
if (problems.length) {
  console.error('INTEGRITY_FAIL')
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
console.log(`INTEGRITY ${verified}/${verified} acceptance files unchanged and key-safe (SHA-256)`)

// ---------------------------------------------------------------- key & deps
const key = process.env.DSH_TEST_KEY || process.env.DEEPSEEK_API_KEY || ''
const hasKey = key.length > 0
console.log(`KEY ${hasKey ? 'PRESENT (command env only; never printed or written)' : 'ABSENT'}`)
const dshCli = join(scratch, 'dsh_rc5', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
console.log(`EXTERNAL dsh rc.5 CLI: ${existsSync(dshCli) ? 'present' : 'MISSING (dsh_real_accept.py will be NOT_VERIFIED)'}`)
console.log(`SANITIZED ${Object.keys(sanitizedFiles).length} scripts admitted (only read_key() changed; assertions byte-identical)`)
console.log('  reason:', realManifest.sanitized._)
console.log(`SYNCED ${Object.keys(syncedFiles).length} script(s) with stale assertions aligned to the deterministic group`)
console.log('  reason:', realManifest.synced._)
if (hasKey) {
  // e2e_real.py does NOT hardcode a proxy/model: with a key alone the service
  // validates it against the default endpoint and reports NO_CREDENTIAL.
  const missing = ['DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DSH_TEST_BASE', 'DSH_TEST_MODEL']
    .filter((k) => !process.env[k])
  if (missing.length) console.log(`HINT missing ${missing.join(', ')} — a key alone yields NO_CREDENTIAL in e2e_real.py`)
}

if (listOnly) {
  console.log('\nINVENTORY')
  for (const s of DETERMINISTIC) console.log(`  [deterministic] ${s.rel} — ${s.label}`)
  for (const s of SELF_CONTAINED) console.log(`  [real model]    ${s.rel} — ${s.label}`)
  for (const s of ATTACHED) console.log(`  [needs :3211]   ${s} — manual composition`)
  console.log('\nLIST_ONLY: nothing was executed, nothing was verified.')
  process.exit(0)
}

// ---------------------------------------------------------------- helpers
function run(rel) {
  const env = { ...process.env, PI_SCRATCH_DIR: scratch }
  if (hasKey) {
    // Historical scripts use two different names. Inject both, env only.
    env.DSH_TEST_KEY = key
    env.DEEPSEEK_API_KEY = key
  } else {
    delete env.DSH_TEST_KEY
    delete env.DEEPSEEK_API_KEY
  }
  for (const k of ['DSH_TEST_BASE', 'DSH_TEST_MODEL', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']) {
    if (process.env[k]) env[k] = process.env[k]
  }
  const r = spawnSync(PY, [join(here, rel)], {
    cwd: root, env, encoding: 'utf8', timeout: 600000,
  })
  return { ...r, out: (r.stdout || '') + (r.stderr || '') }
}
const flags = (out) => String(out).split(/\r?\n/)
  .filter((l) => /RESULT=|SUMMARY:|HARD |SOFT |VERIFIED|BROKEN|ACCEPTED|REJECTED|FAILED|invariants OK|STABLE|PARTIAL|Traceback/.test(l))
  .slice(-8)
function verdict(r) {
  if (r.error) return 'ERROR'
  const out = String(r.out || '')
  // Prefer the script's own authoritative verdict. A bare word like "failed"
  // is NOT a verdict: dsh_real_accept.py prints `turn 不是 completed  failed`
  // as a normal status value while reporting RESULT=VERIFIED.
  const result = out.match(/RESULT=(VERIFIED|ACCEPTED|STABLE|PASS|BROKEN|REJECTED|NONE|PARTIAL)\b/)
  if (result) return /BROKEN|REJECTED|NONE/.test(result[1]) ? 'FAIL' : 'PASS'
  const sum = out.match(/SUMMARY:\s*(\d+)\/(\d+)\s+passed/)
  if (sum) return sum[1] === sum[2] && r.status === 0 ? 'PASS' : 'FAIL'
  if (r.status !== 0) return 'FAIL'
  if (/^\s*FAILED:|Traceback|BROKEN:/m.test(out)) return 'FAIL'
  return 'PASS'
}

// ---------------------------------------------------------------- 1. deterministic
console.log('\n--- deterministic scenario scripts (no key needed) ---')
let detPass = 0
for (const s of DETERMINISTIC) {
  const r = run(s.rel)
  let v = verdict(r)
  if (v === 'PASS' && !s.marker.test(r.out)) v = 'NO_MARKER'
  if (v === 'PASS') detPass++
  console.log(`  ${s.rel.padEnd(30)} ${v}`)
  if (v !== 'PASS') { flags(r.out).forEach((l) => console.log('      ' + l)); problems.push(`${s.rel}: ${v}`) }
}
console.log(`DETERMINISTIC ${detPass}/${DETERMINISTIC.length} PASS`)

// ---------------------------------------------------------------- 2. real model
if (!hasKey) {
  console.log('\n--- real-model suites ---')
  console.log('  NOT RUN: no DSH_TEST_KEY / DEEPSEEK_API_KEY in the command environment.')
  console.log('  NOT RUN: composition / reboot / three resident-loop timers on their own schedule (soak_all.py).')
  console.log('  NOT RUN: the 5 sanitized real-model suites (they need the key too).')
  console.log('\nREAL_ACCEPTANCE=NOT_VERIFIED')
  console.log('  This is NOT a pass. The deterministic scenarios above passed; the real-model')
  console.log('  layer still has to be run with a key injected only via the command env.')
  if (problems.length) process.exit(1)
  process.exit(0)
}

console.log('\n--- real-model suites (key injected via child env) ---')
let realPass = 0
let realTotal = 0
for (const s of SELF_CONTAINED) {
  realTotal++
  if (s.needsDshCli && !existsSync(dshCli)) {
    console.log(`  ${s.rel.padEnd(30)} NOT_VERIFIED (external dsh rc.5 CLI missing)`)
    continue
  }
  const r = run(s.rel)
  const v = verdict(r)
  if (v === 'PASS') realPass++
  console.log(`  ${s.rel.padEnd(30)} ${v}`)
  flags(r.out).forEach((l) => console.log('      ' + l))
  if (v !== 'PASS') problems.push(`${s.rel}: ${v}`)
}
console.log(`REAL_MODEL ${realPass}/${realTotal} scripts clean (per-script HARD/SOFT markers printed verbatim above)`)

console.log('\n--- composition (needs a running :3211 service) ---')
console.log('  NOT auto-run by default. To run it: start the resident service with the key')
console.log('  in the command env, then execute these in order:')
for (const rel of ATTACHED) console.log(`    python ${rel}`)
console.log('  §5 step 4 requires soak_all.py to let the three resident loops tick')
console.log('  themselves (no manual flush/scan/tick). It IS in the self-contained list')
console.log('  above as a sanitized version, so run this driver with a key to cover it.')

if (problems.length) {
  console.error('\nREAL_ACCEPTANCE=FAIL')
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
console.log('\nREAL_ACCEPTANCE=PARTIAL')
console.log('  Self-contained real-model suites ran (including the 5 sanitized ones and')
console.log('  soak_all.py timer self-drive). Manual :3211 composition is still')
console.log('  NOT_VERIFIED unless you ran the ATTACHED scripts listed above.')
console.log('  Per §5, do not read this as "全功能跑通" without that + HARD/SOFT report.')

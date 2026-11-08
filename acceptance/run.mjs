// One-command §5 frontend/HTTP acceptance. The scripts under acceptance/ are
// byte-identical copies of the ones that produced the historical "DOM 冒烟 40/40
// + HTTP 端到端 10 组 203 项" result. This driver does NOT modify them; it only
// (1) verifies their SHA-256 against manifest.json, (2) runs them in order,
// (3) aggregates their own SUMMARY lines. Any change to a historical assertion
// fails before a single test runs, so a regression cannot be quietly widened.
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
const env = { ...process.env, PI_SCRATCH_DIR: scratch }

// The 10 deterministic groups. e2e_real.py is archived but deliberately NOT in
// this list: it needs a real third-party model key, so running it here would
// produce a false red. It belongs to §5 step 3 (真模型验收), not step 2.
const HTTP_SUITES = [
  'e2e.py', 'e2e_cards.py', 'e2e_concurrency.py', 'e2e_continuity.py',
  'e2e_executor.py', 'e2e_observer.py', 'e2e_p1.py', 'e2e_p2.py',
  'e2e_threads.py', 'e2e_watchdog.py',
]

const problems = []
const die = (...lines) => { for (const l of lines) console.error(l); process.exit(1) }

// ---------------------------------------------------------------- 1. integrity
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))
let verified = 0
for (const [rel, expected] of Object.entries(manifest.files)) {
  const p = join(here, rel)
  if (!existsSync(p)) problems.push(`missing: ${rel}`)
  else {
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
    if (actual !== expected) problems.push(`MODIFIED: ${rel} (assertion change must go through AGENTS.md §3 first)`)
    else verified++
  }
}
// Deterministic scripts now derive the workspace from their own location
// (AGENTS.md 3.4), so a clone at ANY path runs the same 243 checks. Reject any
// leftover developer-machine absolute path: that would silently test some
// other tree or leak a personal directory into a public repo.
for (const rel of Object.keys(manifest.files)) {
  if (!/\.(py|mjs)$/.test(rel)) continue
  const text = readFileSync(join(here, rel), 'utf8')
  if (/[A-Za-z]:[\\/]Users[\\/]/i.test(text) || /file:\/\/\/[A-Za-z]:/i.test(text)) {
    problems.push(`portability: ${rel} still contains a developer-machine absolute path`)
  }
}
if (problems.length) die('INTEGRITY_FAIL', ...problems.map((p) => '  ' + p))
console.log(`INTEGRITY ${verified}/${verified} acceptance files unchanged (SHA-256)`)

// ---------------------------------------------------------------- 2. helpers
function summary(out) {
  const m = String(out || '').match(/SUMMARY:\s*(\d+)\/(\d+)\s+passed/)
  return m ? { pass: Number(m[1]), total: Number(m[2]) } : null
}
function diagnostic(out) {
  return String(out || '').split(/\r?\n/)
    .filter((l) => /FAIL|Traceback|Error|SUMMARY|FAILED:/.test(l))
    .slice(-12)
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 240000, ...opts, env: { ...env, ...(opts.env || {}) } })
}

// ---------------------------------------------------------------- 3. HTTP e2e
let httpPass = 0
let httpTotal = 0
const httpGroups = []
for (const name of HTTP_SUITES) {
  const r = run(PY, [join(here, 'e2e', name)])
  const out = (r.stdout || '') + (r.stderr || '')
  const s = summary(out)
  if (r.error) {
    console.log(`HTTP  ${name.padEnd(24)} ERROR ${r.error.message}`)
    problems.push(`${name}: ${r.error.message}`)
    continue
  }
  if (!s) {
    console.log(`HTTP  ${name.padEnd(24)} NO SUMMARY (exit=${r.status})`)
    diagnostic(out).forEach((l) => console.log('      ' + l))
    problems.push(`${name}: no SUMMARY line`)
    continue
  }
  httpPass += s.pass
  httpTotal += s.total
  httpGroups.push(`${s.pass}/${s.total}`)
  const bad = r.status !== 0 || s.pass !== s.total
  console.log(`HTTP  ${name.padEnd(24)} ${String(s.pass).padStart(3)}/${s.total}${bad ? '  <-- FAIL' : ''}`)
  if (bad) {
    diagnostic(out).forEach((l) => console.log('      ' + l))
    problems.push(`${name}: ${s.pass}/${s.total}, exit=${r.status}`)
  }
}
console.log(`HTTP TOTAL ${httpPass}/${httpTotal} (${HTTP_SUITES.length} groups: ${httpGroups.join('+')})`)

// ---------------------------------------------------------------- 4. DOM smoke
const jsdomDir = join(here, 'ui-smoke', 'node_modules', 'jsdom')
if (!existsSync(join(jsdomDir, 'package.json'))) {
  die('DOM_FAIL  jsdom 未安装：npm install --prefix acceptance/ui-smoke  （仅验收依赖，运行时仍零依赖）')
}
const d = run(process.execPath, [join(here, 'ui-smoke', 'run.mjs')])
const dout = (d.stdout || '') + (d.stderr || '')
const ds = summary(dout)
if (!ds || ds.pass !== ds.total || d.status !== 0) {
  console.log(`DOM   ui-smoke/run.mjs       ${ds ? `${ds.pass}/${ds.total}` : 'NO SUMMARY'}  <-- FAIL`)
  diagnostic(dout).forEach((l) => console.log('      ' + l))
  problems.push(`DOM smoke: ${ds ? `${ds.pass}/${ds.total}` : 'no SUMMARY'}, exit=${d.status}`)
} else {
  console.log(`DOM   ui-smoke/run.mjs       ${ds.pass}/${ds.total}`)
}

// ---------------------------------------------------------------- 5. verdict
console.log('')
console.log('NOT RUN (needs a real model key / not part of §5 step 2):')
console.log('  e2e_real.py, 真模型分层 HARD/SOFT, soak_all.py 定时器自驱, 组合/重启场景')
console.log('  不要拿本驱动的通过冒充这些已验完。')
if (problems.length) {
  console.error('\nACCEPTANCE_FAIL')
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
console.log(`\nACCEPTANCE=PASS  HTTP ${httpPass}/${httpTotal} + DOM ${ds.pass}/${ds.total} = ${httpPass + ds.pass}/${httpTotal + ds.total}`)

// Composition acceptance driver (AGENTS.md §5 step 4, manual part).
//
// The five "attached" scripts all hardcode http://127.0.0.1:3211 and are
// SHA-256 pinned, so they cannot be repointed. Historically running them meant
// a human started a resident service, pre-seeded three material fixtures and
// executed five commands by hand. This driver does exactly that, repeatably.
//
//   node acceptance/run-composition.mjs --list    show the plan, start nothing
//   node acceptance/run-composition.mjs           no key -> deterministic
//                                                SKELETON self-check, then
//                                                COMPOSITION=NOT_VERIFIED
//   node acceptance/run-composition.mjs --mock    run all 5 scripts against a
//                                                MockModel service to prove
//                                                the orchestration itself works
//   DSH_TEST_KEY=... node acceptance/run-composition.mjs
//                                                run all 5 against the real
//                                                model (key: command env only)
//
// A NOT_VERIFIED / SKELETON-only result is not a pass. No assertion is changed.
import { spawn, spawnSync } from 'node:child_process'
import { createServer as netServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = 3211
const HOST = '127.0.0.1'
const PY = process.env.PYTHON || 'python'
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const mockRun = args.includes('--mock')
const key = process.env.DSH_TEST_KEY || process.env.DEEPSEEK_API_KEY || ''
const hasKey = key.length > 0

const SCRIPTS = [
  'delivery_accept.py', 'entity_accept.py', 'interject_accept.py',
  'split_accept.py', 'split_quant.py',
]
const MANIFEST = JSON.parse(readFileSync(join(here, 'manifest-real.json'), 'utf8'))

// Same three fixtures used in the successful real-model run. Not project data:
// they live only in a throwaway DATA_DIR created for this invocation.
const SMALL = '# 项目现状\n\n启动命令：npm start\n测试命令：npm test\n\n## 还没做的三件事\n1. 接入渠道通知\n2. 补一份周报\n3. 换成向量检索\n'
const FILLER = '本节是占位背景，与最终结论无关，仅用于把待办推到长文件后半部分。\n'.repeat(40)
const LONG = '# 项目现状（长文）\n\n启动命令：npm start\n测试命令：npm test\n\n' + FILLER
  + '\n## 还没做的三件事\n1. 接入渠道通知\n2. 补一份周报\n3. 换成向量检索\n'
const PKG = '{"name":"resident-agent-p0a","version":"0.1.0","scripts":{"start":"node src/server.mjs","test":"node --test","check":"node --test","acceptance":"node acceptance/run.mjs"}}\n'

const base = `http://${HOST}:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (s) => String(s || '').replace(/sk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED]')
const problems = []

function portFree() {
  return new Promise((done) => {
    const s = netServer()
    s.once('error', () => done(false))
    s.once('listening', () => s.close(() => done(true)))
    s.listen(PORT, HOST)
  })
}

function fixtures(dir) {
  const m = join(dir, 'materials')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, '项目现状.md'), SMALL, 'utf8')
  writeFileSync(join(m, '项目现状_长.md'), LONG, 'utf8')
  writeFileSync(join(m, 'package.json'), PKG, 'utf8')
}

function serviceEnv(dir) {
  const env = { ...process.env, PORT: String(PORT), HOST, DATA_DIR: dir, PYTHONIOENCODING: 'utf-8' }
  // In mock/skeleton mode deliberately give the server NO credential, so the
  // built-in MockModel is selected. In real mode inject the key ONLY into this
  // child process environment (never printed, never written to any file).
  delete env.DSH_TEST_KEY
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_BASE_URL
  delete env.DEEPSEEK_MODEL
  if (hasKey && !mockRun) {
    env.DEEPSEEK_API_KEY = key
    env.DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.qnaigc.com/v1'
    env.DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4-flash'
  }
  return env
}

async function waitHealth(child, logs) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('service exited early: ' + redact(logs()))
    try {
      const r = await fetch(base + '/api/health')
      if (r.ok) return await r.json()
    } catch { /* not up yet */ }
    await sleep(100)
  }
  throw new Error('service did not become healthy: ' + redact(logs()))
}

function scriptEnv() {
  const env = { ...process.env, PI_SCRATCH_DIR: process.env.PI_SCRATCH_DIR || tmpdir() }
  if (hasKey && !mockRun) {
    env.DSH_TEST_KEY = key
    env.DEEPSEEK_API_KEY = key
    env.DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.qnaigc.com/v1'
    env.DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4-flash'
  }
  return env
}

function verdict(out) {
  const text = String(out || '')
  const result = text.match(/RESULT=(VERIFIED|ACCEPTED|STABLE|PASS|PARTIAL|BROKEN|REJECTED|NONE)\b/)
  if (result) return /BROKEN|REJECTED|NONE/.test(result[1]) ? 'FAIL' : result[1]
  const sum = text.match(/SUMMARY:\s*(\d+)\/(\d+)\s+passed/)
  if (sum) return sum[1] === sum[2] ? 'PASS' : 'FAIL'
  const quant = text.match(/拆分遵守率:\s*(\d+)\/(\d+)/)
  if (quant) return quant[1] === quant[2] ? 'STABLE' : 'PARTIAL'
  return 'NO_MARKER'
}

if (listOnly) {
  console.log('COMPOSITION PLAN (starts nothing)')
  console.log(`  port            ${PORT} (must be free; existing services are never killed)`)
  console.log(`  fixtures        ${['项目现状.md', '项目现状_长.md', 'package.json'].join(', ')} in a throwaway DATA_DIR`)
  console.log(`  scripts         ${SCRIPTS.join(', ')}`)
  console.log(`  key             ${hasKey ? 'PRESENT (command env only)' : 'ABSENT -> skeleton self-check or --mock'}`)
  console.log('  modes           (default) / --mock / with DSH_TEST_KEY')
  process.exit(0)
}

// Integrity: the five scripts stay byte-identical to the pinned originals.
for (const name of SCRIPTS) {
  const rel = `real/${name}`
  const expected = MANIFEST.files[rel] || MANIFEST.sanitized?.files?.[rel]?.sha256 || MANIFEST.synced?.files?.[rel]?.sha256
  const p = join(here, rel)
  if (!existsSync(p)) { problems.push(`missing ${rel}`); continue }
  if (expected) {
    const { createHash } = await import('node:crypto')
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
    if (actual !== expected) problems.push(`MODIFIED ${rel}: assertions must go through AGENTS.md §3`)
  }
  const text = readFileSync(p, 'utf8')
  if (!text.includes(`"http://${HOST}:${PORT}"`)) problems.push(`${rel} no longer targets ${base}`)
}
if (problems.length) {
  console.error('INTEGRITY_FAIL')
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
console.log(`INTEGRITY ${SCRIPTS.length}/${SCRIPTS.length} attached scripts unchanged and pinned to ${base}`)

if (!(await portFree())) {
  console.error(`PORT_BUSY ${PORT} is already in use. This driver never kills an existing service; stop it manually and retry.`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'p0a-composition-'))
fixtures(dir)
let logs = ''
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root, env: serviceEnv(dir), stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => { logs += d })
child.stderr.on('data', (d) => { logs += d })

const checks = []
const ok = (n) => checks.push(n)

try {
  const health = await waitHealth(child, () => logs)
  ok(`service health 200 (model=${health.model}, executor=${health.executor})`)
  const m = join(dir, 'materials')
  assert.ok(existsSync(join(m, '项目现状.md')) && existsSync(join(m, '项目现状_长.md')) && existsSync(join(m, 'package.json')))
  ok('three material fixtures seeded in throwaway DATA_DIR')

  if (!hasKey && !mockRun) {
    console.log('\nSKELETON self-check only: no key in the command environment.')
    console.log('  NOT RUN: the 5 attached scripts need a real model (or --mock for orchestration only).')
    console.log('\nCOMPOSITION=NOT_VERIFIED')
    console.log('  This is NOT a pass. Skeleton proven; real-model composition still needs a key.')
  } else {
    const mode = mockRun ? 'MockModel (orchestration proof, NOT a model verdict)' : 'real model (key via command env only)'
    console.log(`\n--- attached scripts [${mode}] ---`)
    let clean = 0
    for (const name of SCRIPTS) {
      const r = spawnSync(PY, [join(here, 'real', name)], {
        cwd: root, env: scriptEnv(), encoding: 'utf8', timeout: 600000,
      })
      const out = redact((r.stdout || '') + (r.stderr || ''))
      const v = r.error ? 'ERROR' : verdict(out)
      const marker = (out.split(/\r?\n/).filter((l) => /RESULT=|SUMMARY:|拆分遵守率|\[FAIL\]/.test(l)).slice(-4)).join(' | ')
      console.log(`  ${name.padEnd(24)} ${String(v).padEnd(10)} ${marker}`)
      if (v === 'PASS' || v === 'VERIFIED' || v === 'ACCEPTED' || v === 'STABLE') clean++
      // In --mock mode the scripts' real-model assertions are EXPECTED to
      // fail (MockModel cannot satisfy them). Only a script that could not
      // run at all, or whose output we could not parse, breaks the
      // orchestration proof. Real-key mode stays strict.
      if (mockRun) {
        if (v === 'ERROR' || v === 'NO_MARKER') problems.push(`${name}: ${v}`)
      } else if (v === 'ERROR' || v === 'FAIL' || v === 'NO_MARKER') {
        problems.push(`${name}: ${v}`)
      }
    }
    console.log(`ATTACHED ${clean}/${SCRIPTS.length} scripts clean`)
    ok(`ran ${SCRIPTS.length} attached scripts in pinned order (${clean} clean)`)
    if (mockRun) {
      console.log('\nCOMPOSITION=SKELETON_VERIFIED')
      console.log('  MockModel proves the orchestration (service, fixtures, order, output capture).')
      console.log('  Script verdicts above are NOT model-quality verdicts. Real composition still needs a key.')
    } else if (problems.length) {
      console.error('\nCOMPOSITION=FAIL')
    } else {
      console.log('\nCOMPOSITION=PASS')
    }
  }
  console.log(`\nSERVICE_CHECKS=${checks.length}/${checks.length} PASS`)
  checks.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
} catch (e) {
  console.error('COMPOSITION_FAIL:', redact(e.stack || e.message))
  console.error('server logs:', redact(logs))
  process.exitCode = 1
} finally {
  child.kill()
  // Give the OS a moment to release the port, then clean the throwaway data.
  await sleep(200)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}
if (problems.length) {
  console.error('COMPOSITION_PROBLEMS')
  problems.forEach((p) => console.error('  ' + p))
  process.exitCode = 1
}

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine.mjs'
import { AppError, Errors, Family } from './providers.mjs'
import { contentDisposition } from './http-util.mjs'
import { SkillBook, RoutineScheduler, RoomHub } from './features.mjs'
import { CardBook } from './cards.mjs'
import { TeamBook, QuotaBook, ChannelBook } from './p2.mjs'
import { ObservationLoop } from './observer.mjs'
import { ThreadBook } from './threads.mjs'
import { Watchdog } from './watchdog.mjs'
import { ProactiveNudge } from './nudge.mjs'

const webRoot = normalize(fileURLToPath(new URL('../web/', import.meta.url)))
const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3080)
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../.data/', import.meta.url))

export const engine = new Engine({ dataDir: DATA_DIR })

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

const skills = new SkillBook(engine)
const routines = new RoutineScheduler(engine)
const rooms = new RoomHub(engine)
routines.start()
const cards = new CardBook(engine)
engine.cards = cards
const threads = new ThreadBook(engine)
engine.threads = threads
const teams = new TeamBook(engine)
const quota = new QuotaBook(engine)
engine.quota = quota
const channels = new ChannelBook(engine)
const observer = new ObservationLoop(engine)
observer.start()
const watchdog = new Watchdog(engine)
engine.watchdog = watchdog
const nudge = new ProactiveNudge(engine)
engine.nudge = nudge
engine.recover()
watchdog.start()
nudge.start()

const sseClients = new Set()
engine.on((msg) => {
  const line = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of sseClients) { try { res.write(line) } catch { sseClients.delete(res) } }
})

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendError(res, err) {
  const e = err instanceof AppError
    ? err
    : new AppError(Family.AGENT, 'INTERNAL', 'Bot 遇到内部错误', err?.message || String(err), 500)
  json(res, e.status, { error: e.toJSON() })
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1_000_000) throw Errors.invalid('请求体（超过 1MB）')
  }
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw Errors.invalid('JSON 请求体') }
}

function match(pathname, pattern) {
  const p = pattern.replace(/:[A-Za-z]+/g, '([A-Za-z0-9_-]+)')
  return pathname.match(new RegExp(`^${p}$`))
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname
  const method = req.method || 'GET'

  if (path === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache', connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 15000)
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res) })
    return
  }

  if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true, ...engine.capabilities() })
  if (path === '/api/capabilities' && method === 'GET') return json(res, 200, engine.capabilities())

  if (path === '/api/bots' && method === 'GET') {
    return json(res, 200, { items: engine.listBots().filter((b) => b.kind !== 'room') })
  }
  if (path === '/api/bots' && method === 'POST') {
    return json(res, 201, engine.createBot(await readBody(req)))
  }

  let m = match(path, '/api/bots/:id')
  if (m && method === 'GET') return json(res, 200, engine.getBot(m[1]))

  m = match(path, '/api/bots/:id/transcript')
  if (m && method === 'GET') {
    const cursor = Number(url.searchParams.get('cursor') || 0)
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500)
    return json(res, 200, engine.getTranscript(m[1], cursor, limit))
  }

  m = match(path, '/api/bots/:id/messages')
  if (m && method === 'POST') {
    const body = await readBody(req)
    return json(res, 202, engine.sendMessage({ botId: m[1], text: body.text, clientNonce: body.clientNonce }))
  }

  m = match(path, '/api/turns/:id')
  if (m && method === 'GET') return json(res, 200, engine.getTurn(m[1]))

  m = match(path, '/api/turns/:id/interrupt')
  if (m && method === 'POST') return json(res, 200, engine.interrupt(m[1]))

  m = match(path, '/api/turns/:id/resume')
  if (m && method === 'POST') return json(res, 202, engine.resume(m[1]))

  // ---------------------------------------------------------------- long-task visibility / watchdog
  if (path === '/api/watchdog' && method === 'GET') return json(res, 200, watchdog.status())
  if (path === '/api/watchdog/tick' && method === 'POST') return json(res, 200, watchdog.tick())
  if (path === '/api/nudges' && method === 'GET') return json(res, 200, nudge.status())
  if (path === '/api/nudges/scan' && method === 'POST') {
    return json(res, 200, await nudge.scan(await readBody(req)))
  }

  m = match(path, '/api/approvals/:id')
  if (m && method === 'GET') return json(res, 200, engine.getApproval(m[1]))
  if (m && method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, engine.approve(m[1], body.approve === true))
  }

  m = match(path, '/api/artifacts/:id')
  if (m && method === 'GET') {
    const a = engine.getArtifact(m[1])
    const content = engine.readArtifactFile(m[1]) ?? ''
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': contentDisposition(a.filename),
    })
    return res.end(content)
  }

  if (path === '/api/secrets' && method === 'POST') {
    const body = await readBody(req)
    return json(res, 201, engine.submitSecret(body.value))
  }

  // ---------------------------------------------------------------- observation (proactivity)
  if (path === '/api/observations' && method === 'GET') return json(res, 200, observer.status())
  if (path === '/api/observations' && method === 'POST') return json(res, 202, observer.observe(await readBody(req)))
  if (path === '/api/observations/flush' && method === 'POST') {
    const flushed = await observer.flush()
    return json(res, 200, { flushed, ...observer.status() })
  }

  // ---------------------------------------------------------------- threads (chained events + delta recall)
  if (path === '/api/threads' && method === 'GET') return json(res, 200, { items: threads.list(), ...threads.status() })
  if (path === '/api/threads/ingest' && method === 'POST') return json(res, 202, threads.ingest(await readBody(req)))
  m = match(path, '/api/threads/:id/recall')
  if (m && method === 'GET') {
    const afterSeq = Number(url.searchParams.get('afterSeq') || 0)
    return json(res, 200, threads.recall(m[1], afterSeq))
  }
  m = match(path, '/api/threads/:id')
  if (m && method === 'GET') return json(res, 200, threads.get(m[1]))

  // ---------------------------------------------------------------- P2: teams / quota / channels
  if (path === '/api/teams' && method === 'GET') return json(res, 200, { items: teams.list() })
  if (path === '/api/teams' && method === 'POST') return json(res, 201, teams.create(await readBody(req)))
  m = match(path, '/api/teams/:id/assign')
  if (m && method === 'POST') {
    const b = await readBody(req)
    return json(res, 200, teams.assignBot(b.botId, m[1]))
  }
  if (path === '/api/quota' && method === 'GET') return json(res, 200, quota.status())
  if (path === '/api/channels' && method === 'GET') return json(res, 200, { items: channels.list() })
  if (path === '/api/channels' && method === 'POST') return json(res, 201, channels.create(await readBody(req)))
  m = match(path, '/api/channels/:id')
  if (m && method === 'GET') {
    const c = channels.get(m[1])
    const { tokenHash, ...safe } = c
    return json(res, 200, safe)
  }
  if (m && method === 'DELETE') return json(res, 200, channels.revoke(m[1]))
  m = match(path, '/api/channels/:id/toggle')
  if (m && method === 'POST') {
    const b = await readBody(req)
    return json(res, 200, channels.setEnabled(m[1], b.enabled))
  }
  m = match(path, '/api/channels/:id/ingest')
  if (m && method === 'POST') return json(res, 202, channels.ingest(m[1], await readBody(req)))
  m = match(path, '/api/channels/:id/audit')
  if (m && method === 'GET') return json(res, 200, channels.audit(m[1]))

  // ---------------------------------------------------------------- executor rollout
  if (path === '/api/executors' && method === 'GET') return json(res, 200, engine.executorStatus())
  if (path === '/api/executors/rollback' && method === 'POST') return json(res, 200, engine.rollbackExecutors())
  m = match(path, '/api/bots/:id/executor')
  if (m && method === 'POST') {
    const b = await readBody(req)
    return json(res, 200, engine.setBotExecutor(m[1], b.provider))
  }

  // ---------------------------------------------------------------- cards
  m = match(path, '/api/cards/:id')
  if (m && method === 'GET') return json(res, 200, cards.get(m[1]))
  m = match(path, '/api/cards/:id/act')
  if (m && method === 'POST') {
    const b = await readBody(req)
    return json(res, 200, cards.resolve(m[1], b.action))
  }

  // ---------------------------------------------------------------- P1
  if (path === '/api/skills' && method === 'GET') return json(res, 200, { items: skills.list() })
  if (path === '/api/skills' && method === 'POST') return json(res, 201, skills.save(await readBody(req)))
  if (path === '/api/skills/from-turn' && method === 'POST') {
    const b = await readBody(req)
    return json(res, 201, skills.fromTurn(b.turnId, { name: b.name, description: b.description }))
  }
  m = match(path, '/api/skills/:id')
  if (m && method === 'GET') return json(res, 200, skills.get(m[1]))
  m = match(path, '/api/skills/:id/run')
  if (m && method === 'POST') return json(res, 202, skills.run(m[1], await readBody(req)))

  if (path === '/api/routines' && method === 'GET') return json(res, 200, { items: routines.list() })
  if (path === '/api/routines' && method === 'POST') return json(res, 201, routines.create(await readBody(req)))
  m = match(path, '/api/routines/:id')
  if (m && method === 'GET') return json(res, 200, routines.get(m[1]))
  if (m && method === 'DELETE') return json(res, 200, routines.remove(m[1]))
  m = match(path, '/api/routines/:id/toggle')
  if (m && method === 'POST') {
    const b = await readBody(req)
    return json(res, 200, routines.setEnabled(m[1], b.enabled))
  }
  m = match(path, '/api/routines/:id/test')
  if (m && method === 'POST') return json(res, 202, routines.fire(m[1], { reason: 'test' }))
  if (path === '/api/events/ingest' && method === 'POST') {
    return json(res, 202, { accepted: true, fired: routines.ingest(await readBody(req)) })
  }

  if (path === '/api/rooms' && method === 'GET') return json(res, 200, { items: rooms.list() })
  if (path === '/api/rooms' && method === 'POST') return json(res, 201, rooms.create(await readBody(req)))
  m = match(path, '/api/rooms/:id')
  if (m && method === 'GET') return json(res, 200, rooms.get(m[1]))
  m = match(path, '/api/rooms/:id/messages')
  if (m && method === 'POST') return json(res, 202, rooms.send({ ...(await readBody(req)), roomId: m[1] }))

  if (!path.startsWith('/api/') && (method === 'GET' || method === 'HEAD')) {
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    const full = normalize(join(webRoot, rel))
    if (!full.startsWith(webRoot) || !existsSync(full)) throw Errors.notFound('页面')
    const buf = await readFile(full)
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' })
    return res.end(method === 'HEAD' ? undefined : buf)
  }

  throw Errors.notFound('接口')
}

export const server = createServer((req, res) => {
  Promise.resolve(route(req, res)).catch((err) => sendError(res, err))
})

if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  server.listen(PORT, HOST, () => {
    const caps = engine.capabilities()
    console.log(`resident-agent P0-A  http://${HOST}:${PORT}`)
    console.log(`data=${DATA_DIR}  model=${caps.model}  executor=${caps.executor}`)
  })
}

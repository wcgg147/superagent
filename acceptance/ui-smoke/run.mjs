import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { JSDOM } from 'jsdom'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
const html = readFileSync(`${WEB}/index.html`, 'utf8')
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3080/', runScripts: 'outside-only', pretendToBeVisual: true })
const { window } = dom

globalThis.window = window
globalThis.document = window.document
globalThis.localStorage = window.localStorage
globalThis.CustomEvent = window.CustomEvent
let sse = null
globalThis.EventSource = class { constructor() { sse = this } addEventListener() {} close() {} }

const CARD = {
  seq: 1, id: 'e1', kind: 'card', cardId: 'crd_1', cardType: 'followup-offer',
  title: '要不要把这件事变成常规？', summary: '存成技能，或让它定时自动跑一次',
  actions: [
    { id: 'save-skill', label: '存成技能' },
    { id: 'save-routine', label: '每小时自动跑' },
    { id: 'dismiss', label: '不用了' },
  ],
}
const RESOLVED = { seq: 2, id: 'e2', kind: 'card/resolved', cardId: 'crd_1', actionId: 'save-skill', status: 'saved' }
const OBS = {
  seq: 3, id: 'e3', kind: 'observation', observationId: 'obs_1', source: 'github',
  summary: '它注意到一件可能值得做的事', detail: '来自 github',
}
const TASK = { seq: 4, id: 'e4', kind: 'task', turnId: 'turn_1', taskLabel: '任务 1', status: 'running', parallel: 2 }
const REPLY = { seq: 5, id: 'e5', kind: 'assistant/message', turnId: 'turn_1', text: '两件事都办好了', taskLabel: '任务 1', viaOutbox: true }
const TASK_DONE = { seq: 6, id: 'e6', kind: 'task/done', turnId: 'turn_1', taskLabel: '任务 1', status: 'completed' }
const THREAD_EVENT = { seq: 11, id: 'e11', kind: 'thread/event', threadId: 'thr_1', source: 'github', entity: 'issue/12', text: 'CI 报错了', count: 2, coalesced: true }
const PROGRESS = { seq: 12, id: 'e12', kind: 'progress', turnId: 'turn_1', step: 2, total: 4, summary: '检索', elapsedMs: 120 }

const DB = {
  bots: [{ id: 'bot_1', name: '甲', job: '测试', memory: [] }, { id: 'bot_2', name: '乙', job: '', memory: [] }],
  rooms: [], skills: [], routines: [], channels: [], teams: [],
}
const calls = []
let resolved = false

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  calls.push([u, method, opts.body])
  let data = {}
  if (u.includes('/api/cards/') && u.endsWith('/act')) { resolved = true; data = { status: 'saved' } }
  else if (u === '/api/bots' && method === 'GET') data = { items: DB.bots }
  else if (u === '/api/rooms' && method === 'GET') data = { items: DB.rooms }
  else if (u === '/api/skills' && method === 'GET') data = { items: DB.skills }
  else if (u === '/api/routines' && method === 'GET') data = { items: DB.routines }
  else if (u === '/api/channels' && method === 'GET') data = { items: DB.channels }
  else if (u === '/api/teams' && method === 'GET') data = { items: DB.teams }
  else if (u === '/api/quota' && method === 'GET') data = { day: '2026-11-05', teams: [], unlimitedBots: 2 }
  else if (u === '/api/health') data = { ok: true, model: 'mock', executor: 'local', capabilities: [] }
  else if (u === '/api/capabilities') data = { model: 'mock', executor: 'local', capabilities: [] }
  else if (u.includes('/transcript')) data = {
    items: [...(resolved ? [CARD, RESOLVED, OBS] : [CARD, OBS]), TASK, REPLY, PROGRESS, TASK_DONE, THREAD_EVENT],
    nextCursor: 11, hasMore: false,
  }
  return { ok: true, status: 200, json: async () => data }
}

const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms))
const checks = []
function check(name, cond, extra = '') {
  checks.push([name, !!cond])
  console.log(`${cond ? 'PASS  ' : 'FAIL  '}${name}${extra ? '  ' + extra : ''}`)
}

await import(new URL('../../web/app.js', import.meta.url).href)
await import(new URL('../../web/p1.js', import.meta.url).href)
await wait(150)

const doc = window.document
check('Bot 列表已渲染', doc.querySelectorAll('#botList .bot-item').length === 2)
check('默认选中第一个 Bot', doc.getElementById('botName').textContent === '甲')
check('本地快照记住 Bot', window.localStorage.getItem('p0a.botId') === 'bot_1')
check('群聊 @ 选择器默认隐藏', doc.getElementById('roomMentionWrap').hidden === true)
check('顶部只有一个工作台入口', doc.querySelectorAll('.controls button').length === 2)
const cardEl = doc.querySelector('.row.card[data-card-id="crd_1"]')
check('对话里渲染出渐进披露卡片', !!cardEl && cardEl.textContent.includes('存成技能'))
check('卡片有三个动作按钮', cardEl?.querySelectorAll('[data-card-action]').length === 3)
check('观察行出现在同一条时间线上', doc.querySelectorAll('.row.observation').length === 1)
check('卡片默认不展示工具调用', doc.querySelectorAll('.row.detail').length === 0)
check('并行任务的开始与结束都落在同一条时间线上', doc.querySelectorAll('.row.task').length === 2)
check('并行回复标注来自哪件事', doc.querySelector('.row.bot .task-label')?.textContent === '任务 1')
check('线索串联事件也落在同一条时间线上', doc.querySelectorAll('.row.thread').length === 1
  && doc.querySelector('.row.thread').textContent.includes('接着串'))
check('单任务时任务行默认收起（低打扰）',
  !doc.querySelector('.row.task[data-turn-id="turn_1"]')?.classList.contains('visible'))
check('已完成任务不残留步骤进度',
  doc.querySelector('.row.task[data-turn-id="turn_1"] .task-progress')?.textContent === '')
check('每个活跃任务有精确停止按钮',
  doc.querySelector('.row.task[data-turn-id="turn_1"] [data-stop-turn]')?.dataset.stopTurn === 'turn_1')
const live = (entry) => sse.onmessage({ data: JSON.stringify({ type: 'entry', botId: 'bot_1', entry }) })
live({ seq: 7, kind: 'task', turnId: 'turn_l1', taskLabel: '任务 7', parallel: 2 })
live({ seq: 8, kind: 'task', turnId: 'turn_l2', taskLabel: '任务 8', parallel: 2 })
check('状态栏显示并行件数', doc.getElementById('status').textContent === '并行 2 件')
check('并行时整批任务行一起显现', doc.querySelectorAll('.row.task.visible').length >= 2)
live({ seq: 9, kind: 'task/done', turnId: 'turn_l1', taskLabel: '任务 7', status: 'completed' })
check('完成行继承开始行的可见性，时间线闭合',
  [...doc.querySelectorAll('.row.task')].some((n) => n.textContent.includes('任务 7 完成') && n.classList.contains('visible')))
check('其中一件完成后仍显示工作中', doc.getElementById('status').textContent === '工作中')
live({ seq: 10, kind: 'task/done', turnId: 'turn_l2', taskLabel: '任务 8', status: 'completed' })
check('全部完成后回到空闲', doc.getElementById('status').textContent === '空闲')
live({ seq: 14, kind: 'task', turnId: 'turn_stop1', taskLabel: '任务 9', parallel: 1 })
live({ seq: 18, kind: 'progress', turnId: 'turn_stop1', step: 2, total: 4, summary: '检索', elapsedMs: 120 })
check('活跃任务的步骤进度就地写入任务条',
  doc.querySelector('.row.task[data-turn-id="turn_stop1"] .task-progress')?.textContent.includes('第 2/4 步'))
const stopBtn = doc.querySelector('.row.task[data-turn-id="turn_stop1"] [data-stop-turn]')
stopBtn?.click()
await wait(150)
check('点任务上的停止按钮精确中断该 turn（已完成任务的按钮已禁用）',
  calls.some(([u, m]) => u === '/api/turns/turn_stop1/interrupt' && m === 'POST'))
live({ seq: 15, kind: 'resume', turnId: 'turn_l1', summary: '接着上次停下的一步继续', fromStep: 2, total: 4 })
check('恢复事件落在同一条时间线上',
  [...doc.querySelectorAll('.row.task')].some((n) => n.textContent.includes('接着上次')))
live({ seq: 16, kind: 'watchdog', turnId: 'turn_l1', level: 'heartbeat', summary: '还在做第 2/4 步，已用 12s' })
check('watchdog 心跳是低打扰淡行', doc.querySelectorAll('.row.watchdog').length === 1)
live({ seq: 17, kind: 'card', cardId: 'crd_wd', cardType: 'watchdog', turnId: 'turn_l1',
  title: '这一步好像卡住了', summary: '要停掉还是继续等？',
  actions: [{ id: 'stop', label: '停掉' }, { id: 'wait', label: '继续等' }] })
check('watchdog 卡片把决定权交回给人',
  [...doc.querySelectorAll('.row.card')].some((n) => n.dataset.cardId === 'crd_wd'
    && [...n.querySelectorAll('[data-card-action]')].map((b) => b.dataset.cardAction).join(',') === 'stop,wait'))
cardEl?.querySelector('[data-card-action="save-skill"]').click()
await wait(150)
check('点「存成技能」发起卡片动作', calls.some(([u, m]) => u === '/api/cards/crd_1/act' && m === 'POST'))
check('resolved 后按钮被禁用', cardEl?.querySelectorAll('button:disabled').length === 3)
check('resolved 后显示已保存', cardEl?.textContent.includes('已保存'))

doc.getElementById('workspaceBtn').click()
await wait(120)
let drawer = doc.getElementById('drawer')
check('点「工作台」抽屉打开', drawer.hidden === false && drawer.textContent.includes('从最近一轮成功任务生成'))
check('工作台共五个页签', drawer.querySelectorAll('[data-tab]').length === 5)
drawer.querySelector('[data-tab="routines"]').click()
await wait(120)
drawer = doc.getElementById('drawer')
check('切到「自动化」页签', drawer.textContent.includes('新建自动化'))
drawer.querySelector('[data-tab="rooms"]').click()
await wait(120)
drawer = doc.getElementById('drawer')
check('切到「群聊」页签', drawer.textContent.includes('新建群聊'))
check('成员复选框列出 Bot', drawer.querySelectorAll('#rmMembers input[type="checkbox"]').length === 2)

drawer.querySelector('[data-tab="channels"]').click()
await wait(120)
drawer = doc.getElementById('drawer')
check('切到「渠道」页签', drawer.textContent.includes('新建渠道') && drawer.textContent.includes('谁能指挥我的 Bot'))
check('渠道可绑定 Bot', drawer.querySelectorAll('#chBot option').length === 2)

drawer.querySelector('[data-tab="teams"]').click()
await wait(120)
drawer = doc.getElementById('drawer')
check('切到「团队」页签', drawer.textContent.includes('新建团队') && drawer.textContent.includes('把 Bot 加入团队'))
check('团队页显示用量区', drawer.textContent.includes('团队用量'))

drawer.querySelector('[data-close]').click()
check('关闭抽屉', doc.getElementById('drawer').hidden === true)

live({ seq: 19, kind: 'interrupt', turnId: 'turn_stop1', summary: '已停止' })
check('中断后「停止全部」按钮归位', doc.getElementById('interruptBtn').disabled === true
  && doc.getElementById('interruptBtn').textContent === '停止')
live({ seq: 20, kind: 'task/done', turnId: 'turn_stop1', taskLabel: '任务 9', status: 'interrupted' })
check('任务终态显示为中文而不是状态码',
  [...doc.querySelectorAll('.row.task')].some((n) => n.textContent.includes('任务 9 已停止')))

const failed = checks.filter(([, ok]) => !ok).map(([n]) => n)
console.log(`\nSUMMARY: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) { console.log('FAILED:', failed.join(', ')); process.exitCode = 1 }
dom.window.close()

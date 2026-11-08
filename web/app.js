import { artifactNotes } from './artifact-notes.js'
import { errorCopy } from './error-copy.js'
import { errorGroupKey, errorRepeat, repeatedLine, rememberErrorGroup } from './error-repeat.js'
import { applyConnection } from './connection.js'
const $ = (id) => document.getElementById(id)
const state = { bots: [], botId: null, botKind: null, cursor: 0, seen: new Set(), details: false, activeTurn: null, activeTasks: new Set(), taskNodes: new Map(), queuedTurns: new Set(), errorGroups: new Map() }

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = data.error || {}
    throw Object.assign(new Error(e.detail || '请求失败'), { title: e.title || '出错了', family: e.family, code: e.code })
  }
  return data
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function el(tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html !== undefined) n.innerHTML = html
  return n
}

function showError(err) {
  const c = errorCopy(err)
  const n = el('div', `row error${c.quiet ? ' quiet' : ''}`, `<strong>${esc(c.title)}</strong><div class="muted">${esc(c.detail)}</div>`)
  $('transcript').appendChild(n)
  $('transcript').scrollTop = $('transcript').scrollHeight
}

function updateStatus(kind) {
  const n = state.activeTasks.size
  if (n > 1) {
    const q = state.queuedTurns.size
    $('status').textContent = q ? `并行 ${n} 件 · 排队 ${q} 件` : `并行 ${n} 件`
    document.querySelectorAll('#transcript .row.task').forEach((row) => row.classList.add('visible'))
  }
  else if (kind === 'error' || kind === 'interrupt') $('status').textContent = '已停止'
  else if (kind === 'activity' || kind === 'card' || kind === 'task') $('status').textContent = '工作中'
  else $('status').textContent = n ? '工作中' : '空闲'
  const targets = new Set([...state.activeTasks, ...state.queuedTurns])
  $('interruptBtn').disabled = targets.size === 0
  $('interruptBtn').textContent = targets.size > 1 ? `停止全部 ${targets.size} 件` : '停止'
}

function renderEntry(e) {
  if (state.seen.has(e.seq)) return
  state.seen.add(e.seq)
  if (e.kind === 'task') { state.activeTasks.add(e.turnId); state.queuedTurns.delete(e.turnId) }
  if (e.kind === 'task/done') { state.activeTasks.delete(e.turnId); state.queuedTurns.delete(e.turnId) }
  if (e.kind === 'interrupt') { state.activeTasks.delete(e.turnId); state.queuedTurns.delete(e.turnId) }
  state.cursor = Math.max(state.cursor, e.seq)
  if (e.turnId) state.activeTurn = e.turnId

  if (e.kind === 'card/resolved') {
    const cardEl = document.querySelector(`[data-card-id="${e.cardId}"]`)
    if (cardEl) {
      cardEl.querySelectorAll('button').forEach((b) => { b.disabled = true })
      const label = e.status === 'saved' ? '已保存' : e.status === 'dismissed' ? '已忽略' : e.status
      if (!cardEl.querySelector('.card-result')) cardEl.appendChild(el('div', 'card-result', esc(label)))
    }
  }
  const hidden = ['tool/call', 'result', 'approval', 'system', 'card/resolved'].includes(e.kind)
  if (hidden && !state.details) { updateStatus(e.kind); return }

  const box = $('transcript')
  let node
  switch (e.kind) {
    case 'user/message':
      node = el('div', 'row user', `<div class="bubble">${esc(e.text)}${e.secretProvided ? ' <span class="tag">凭据已提供</span>' : ''}${e.interjection ? ' <span class="tag interject">插话</span>' : ''}</div>`)
      break
    case 'assistant/message': {
      const tag = e.interjection ? ' <span class="tag interject">插话</span>' : ''
      const nudge = e.nudge ? ' <span class="tag nudge">主动</span>' : ''
      node = el('div', 'row bot', `<div class="bubble">${e.taskLabel ? `<span class="task-label">${esc(e.taskLabel)}</span> ` : ''}${esc(e.text)}${tag}${nudge}</div>`)
      break
    }
    case 'activity':
      node = el('div', 'row activity', `<div class="dot"></div><span>${esc(e.summary)}${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ''}</span>`)
      break
    case 'card': {
      node = el('div', 'row card')
      node.dataset.cardId = e.cardId || e.approvalId || ''
      if (e.cardType === 'approval') {
        node.innerHTML = `<div class="card-title">${esc(e.title)}</div><div>${esc(e.summary)}</div><code>${esc(e.detail)}</code>
          <div class="card-actions"><button data-approve="${esc(e.approvalId)}">允许</button><button class="ghost" data-deny="${esc(e.approvalId)}">不做</button></div>`
        node.querySelectorAll('button').forEach((b) => {
          b.onclick = () => decide(e.approvalId, b.hasAttribute('data-approve'))
        })
      } else {
        const actions = Array.isArray(e.actions) ? e.actions : []
        node.innerHTML = `<div class="card-title">${esc(e.title)}</div><div>${esc(e.summary)}</div>
          <div class="card-actions">${actions.map((a) => `<button data-card-action="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>`
        node.querySelectorAll('[data-card-action]').forEach((b) => {
          b.onclick = () => actCard(e.cardId, b.dataset.cardAction)
        })
      }
      break
    }
    case 'artifact': {
      node = el('div', 'row artifact-card')
      const lines = Array.isArray(e.preview) ? e.preview : []
      const meta = [e.bytes ? `${e.bytes} 字` : '', e.integrity === false ? '写入校验失败' : '']
        .filter(Boolean).join(' · ')
      const notes = artifactNotes(e)
      node.innerHTML = `<div class="artifact-head">📎 <a href="${esc(e.url)}" download="${esc(e.filename)}">${esc(e.filename)}</a>${meta ? `<span class="artifact-meta">${esc(meta)}</span>` : ''}</div>`
        + (notes.length ? `<div class="artifact-notes">${notes.map((n) => `<div class="artifact-note${n.warn ? ' warn' : ''}">${esc(n.text)}</div>`).join('')}</div>` : '')
        + (lines.length ? `<div class="artifact-preview">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : '')
        + (e.previewTruncated ? '<div class="artifact-more">…点文件名下载完整内容</div>' : '')
      break
    }
    case 'error': {
      // Talk like a colleague, not like an error object. Classification stays
      // structured on the record; errorCopy turns it into a plain reason and
      // one next step, and never leaks an internal code or variable name.
      // A run of identical self-retryable hiccups is said ONCE loudly, then
      // whispered: every journal event STILL gets its own row, so DOM/API
      // visible entries stay neither lost nor duplicated. Only weight changes.
      const c = errorCopy(e)
      const key = errorGroupKey(state.botId, e.turnId, c)
      const previous = key ? state.errorGroups.get(key) : null
      const rep = errorRepeat({ key, previous, alive: !!previous?.node?.isConnected })
      if (rep.repeat) {
        node = el('div', 'row error quiet repeat', `<span>${esc(repeatedLine(rep.count))}</span>`)
        rememberErrorGroup(state.errorGroups, key, { node: previous.node, count: rep.count })
      } else {
        node = el('div', `row error${c.quiet ? ' quiet' : ''}`, `<strong>${esc(c.title)}</strong><div class="muted">${esc(c.detail)}</div>`)
        if (key) rememberErrorGroup(state.errorGroups, key, { node, count: 1 })
      }
      break
    }
    case 'observation':
      node = el('div', 'row observation', `<div class="dot"></div><span>${esc(e.summary)}${e.detail ? ` · ${esc(e.detail)}` : ''}</span>`)
      break
    case 'task':
      node = el('div', 'row task', `<span>${esc(e.taskLabel || '任务')} ${e.resumed ? '接着做' : '开始'}${e.parallel > 1 ? ` · 同时 ${e.parallel} 件` : ''}</span><span class="task-progress"></span><button class="stop" data-stop-turn="${esc(e.turnId || '')}">停止</button>`)
      if (e.turnId) {
        node.dataset.turnId = e.turnId
        state.taskNodes.set(e.turnId, node)
        node.querySelector('[data-stop-turn]')?.addEventListener('click', () => stopTurn(e.turnId))
      }
      break
    case 'task/done': {
      const taskNode = e.turnId ? state.taskNodes.get(e.turnId) : null
      if (taskNode) {
        taskNode.classList.add('done')
        const slot = taskNode.querySelector('.task-progress')
        if (slot) slot.textContent = ''
        taskNode.querySelector('[data-stop-turn]')?.setAttribute('disabled', '')
        state.taskNodes.delete(e.turnId)
      }
      const doneLabel = { completed: '完成', interrupted: '已停止', denied: '已拒绝', failed: '失败' }[e.status] || e.status
      node = el('div', 'row task', `<span>${esc(e.taskLabel || '任务')} ${esc(doneLabel)}</span>`)
      if (taskNode?.classList.contains('visible')) node.classList.add('visible')
      break
    }
    case 'interrupt':
      node = el('div', 'row activity', `<span>${esc(e.summary || '已停止')}</span>`)
      break
    case 'interject':
      node = el('div', 'row interject-note', `<span class="dot"></span><span>↪ 插话 · 手上的${e.against?.length ? `「${esc(e.against.join('、'))}」` : '进行中任务'}继续跑${e.queued ? '（这条排队等空位）' : ''}</span>`)
      break
    case 'split':
      node = el('div', 'row split-note', `<span class="dot"></span><span>↪ 拆成 ${esc(String(e.count || 0))} 件并行做${e.summaries?.length ? `：${esc(e.summaries.join('；'))}` : ''}</span>`)
      break
    case 'tool/call':
      node = el('div', 'row detail', `<code>${esc(e.name)} ${esc(e.detail || '')}</code>`)
      break
    case 'result':
      node = el('div', 'row detail', `<span class="muted">${esc(e.summary)}</span>`)
      break
    case 'approval':
      node = el('div', 'row detail', `<span class="muted">审批：${esc(e.decision)}</span>`)
      break
    case 'system':
      node = el('div', 'row detail', `<span class="muted">${esc(e.text)}</span>`)
      break
    case 'thread/event':
      node = el('div', 'row thread', `<div class="dot"></div><span>${e.coalesced ? '接着串' : '新线索'} · ${esc(e.source || '')} 第 ${e.count || 1} 条：${esc(e.text || '')}</span>`)
      break
    case 'progress': {
      const taskNode = e.turnId ? state.taskNodes.get(e.turnId) : null
      const slot = taskNode?.querySelector('.task-progress')
      if (slot) slot.textContent = ` · 第 ${e.step}/${e.total} 步：${e.summary || ''}`
      updateStatus(e.kind)
      return
    }
    case 'resume':
      node = el('div', 'row task resume', `<span>${esc(e.summary || '接着做')} · 第 ${e.fromStep || 1}/${e.total || '?'} 步</span>`)
      break
    case 'watchdog':
      node = el('div', 'row watchdog', `<div class="dot"></div><span>${esc(e.summary || '')}</span>`)
      break
    default:
      node = el('div', 'row detail', `<span class="muted">${esc(e.kind)}</span>`)
  }
  node.dataset.seq = e.seq
  box.appendChild(node)
  box.scrollTop = box.scrollHeight
  updateStatus(e.kind)
}

async function refresh() {
  if (!state.botId) return
  const d = await api(`/api/bots/${state.botId}/transcript?cursor=${state.cursor}`)
  d.items.forEach(renderEntry)
}

function renderBotList() {
  const list = $('botList')
  list.innerHTML = ''
  for (const b of state.bots) {
    const badge = b.kind === 'room' ? '<span class="room-badge">群</span> ' : ''
    const sub = b.kind === 'room' ? '群聊' : (b.job || '')
    const n = el('button', `bot-item${b.id === state.botId ? ' active' : ''}`, `${badge}${esc(b.name)}<small>${esc(sub)}</small>`)
    n.onclick = () => selectBot(b.id)
    list.appendChild(n)
  }
}

async function loadBots() {
  const [d, r] = await Promise.all([
    api('/api/bots'),
    api('/api/rooms').catch(() => ({ items: [] })),
  ])
  const knownRooms = state.bots.filter((b) => b.kind === 'room')
  const merged = new Map([...r.items, ...knownRooms].map((b) => [b.id, b]))
  state.bots = [...d.items, ...merged.values()]
  renderBotList()
  if (!state.botId && state.bots.length) {
    let saved = null
    try { saved = localStorage.getItem('p0a.botId') } catch { /* storage unavailable */ }
    const target = saved && state.bots.some((b) => b.id === saved) ? saved : state.bots[0].id
    await selectBot(target)
  }
}

async function selectBot(id) {
  state.botId = id
  state.botKind = state.bots.find((x) => x.id === id)?.kind || null
  state.cursor = 0
  state.seen.clear()
  state.activeTurn = null
  state.activeTasks.clear()
  state.taskNodes.clear()
  state.queuedTurns.clear()
  $('transcript').innerHTML = ''
  const b = state.bots.find((x) => x.id === id)
  $('botName').textContent = b?.name || '—'
  $('botJob').textContent = b?.kind === 'room' ? `群聊 · ${(b.members || []).length} 个成员` : (b?.job || '')
  $('text').disabled = false
  $('sendBtn').disabled = false
  try { localStorage.setItem('p0a.botId', id) } catch { /* storage unavailable */ }
  renderBotList()
  window.dispatchEvent(new CustomEvent('p0a:botchange'))
  await refresh()
}

async function decide(id, allow) {
  try {
    await api(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ approve: allow }) })
    document.querySelectorAll(`button[data-approve="${id}"],button[data-deny="${id}"]`).forEach((b) => { b.disabled = true })
    await refresh()
  } catch (err) { showError(err) }
}

$('newBot').onsubmit = async (ev) => {
  ev.preventDefault()
  const name = $('newBotName').value.trim()
  if (!name) return
  try {
    const b = await api('/api/bots', { method: 'POST', body: JSON.stringify({ name, job: $('newBotJob').value }) })
    $('newBotName').value = ''
    $('newBotJob').value = ''
    await loadBots()
    await selectBot(b.id)
  } catch (err) { showError(err) }
}

$('composer').onsubmit = async (ev) => {
  ev.preventDefault()
  const text = $('text').value.trim()
  if (!text || !state.botId) return
  $('text').value = ''
  const nonce = crypto.randomUUID()
  const optimistic = el('div', 'row user optimistic', `<div class="bubble">${esc(text)}</div><span class="muted">已发送</span>`)
  optimistic.dataset.nonce = nonce
  $('transcript').appendChild(optimistic)
  $('transcript').scrollTop = $('transcript').scrollHeight
  try {
    const mentionEl = document.getElementById('roomMention')
    const mention = state.botKind === 'room' && mentionEl?.value ? mentionEl.value : null
    const body = { text, clientNonce: nonce, ...(mention ? { mentions: [mention] } : {}) }
    const path = state.botKind === 'room'
      ? `/api/rooms/${state.botId}/messages`
      : `/api/bots/${state.botId}/messages`
    const r = await api(path, { method: 'POST', body: JSON.stringify(body) })
    state.activeTurn = r.turnId || r.turnIds?.[0] || null
    if (r.queued && r.turnId && !r.duplicate) { state.queuedTurns.add(r.turnId); updateStatus() }
    if (r.duplicate) optimistic.remove()
    else setTimeout(() => optimistic.remove(), 1500)
    await refresh()
  } catch (err) {
    optimistic.remove()
    showError(err)
    $('text').value = text
  }
}

$('interruptBtn').onclick = async () => {
  const targets = [...new Set([...state.activeTasks, ...state.queuedTurns])]
  if (!targets.length && state.activeTurn) targets.push(state.activeTurn)
  if (!targets.length) return
  try {
    await Promise.all(targets.map((id) => api(`/api/turns/${id}/interrupt`, { method: 'POST', body: '{}' })))
    await refresh()
  } catch (err) { showError(err) }
}

$('detailsToggle').onchange = (ev) => {
  state.details = ev.target.checked
  $('transcript').classList.toggle('show-all-tasks', state.details)
  state.seen.clear()
  state.cursor = 0
  $('transcript').innerHTML = ''
  refresh().catch((err) => showError(err))
}

const events = new EventSource('/api/events')
events.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'entry' && msg.botId === state.botId) renderEntry(msg.entry)
  } catch { /* ignore malformed frame */ }
}
events.onerror = () => { applyConnection($('connStatus'), false) }
events.onopen = () => {
  applyConnection($('connStatus'), true)
  refresh().catch(() => {})
}

api('/api/capabilities').then((c) => { $('caps').textContent = `模型 ${c.model} · 执行 ${c.executor}` }).catch(() => {})
loadBots().catch((err) => showError(err))

async function stopTurn(turnId) {
  if (!turnId) return
  try {
    await api(`/api/turns/${turnId}/interrupt`, { method: 'POST', body: '{}' })
    await refresh()
  } catch (err) { showError(err) }
}

export { state, api, refresh, selectBot, showError, loadBots, renderBotList, esc, el }

async function actCard(cardId, actionId) {
  try {
    await api(`/api/cards/${cardId}/act`, { method: 'POST', body: JSON.stringify({ action: actionId }) })
    await refresh()
  } catch (err) { showError(err) }
}

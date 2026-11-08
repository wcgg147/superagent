import { state, api, refresh, selectBot, showError, esc, el } from './app.js'

const drawer = document.getElementById('drawer')
const mentionWrap = document.getElementById('roomMentionWrap')
const mentionSelect = document.getElementById('roomMention')
const TAB_NAMES = { skills: '技能', routines: '自动化', rooms: '群聊', channels: '渠道', teams: '团队' }
let currentTab = 'skills'

document.getElementById('workspaceBtn').onclick = () => openDrawer(currentTab)

function openDrawer(tab) {
  currentTab = tab
  drawer.hidden = false
  render()
}

function closeDrawer() {
  drawer.hidden = true
  drawer.innerHTML = ''
}

function notice(text) {
  const body = drawer.querySelector('#drawerBody')
  if (!body) return
  const n = el('div', 'drawer-notice', esc(text))
  body.prepend(n)
  setTimeout(() => n.remove(), 2600)
}

async function render() {
  drawer.innerHTML = `
    <div class="drawer-head"><strong>工作台</strong><button type="button" class="ghost" data-close>关闭</button></div>
    <div class="drawer-tabs">
      ${Object.keys(TAB_NAMES).map((t) => `<button data-tab="${t}" class="${t === currentTab ? 'on' : ''}">${TAB_NAMES[t]}</button>`).join('')}
    </div>
    <div id="drawerBody" class="drawer-body"></div>`
  drawer.querySelector('[data-close]').onclick = closeDrawer
  drawer.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { currentTab = b.dataset.tab; render() }
  })
  const body = drawer.querySelector('#drawerBody')
  body.innerHTML = '<div class="drawer-empty">加载中…</div>'
  try {
    if (currentTab === 'skills') await renderSkills(body)
    else if (currentTab === 'routines') await renderRoutines(body)
    else if (currentTab === 'rooms') await renderRooms(body)
    else if (currentTab === 'channels') await renderChannels(body)
    else await renderTeams(body)
  } catch (err) {
    body.innerHTML = `<div class="drawer-error">${esc(err.title || '出错了')}：${esc(err.message)}</div>`
  }
}

async function renderSkills(body) {
  const { items } = await api('/api/skills')
  body.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-label">从最近一轮成功任务生成</div>
      <div class="drawer-row"><input id="skName" placeholder="技能名称"><button id="skFromTurn">生成</button></div>
    </div>
    <div class="drawer-section"><div class="drawer-label">已有技能</div><div id="skList"></div></div>
    <div class="drawer-section">
      <div class="drawer-label">直接新建</div>
      <input id="skNewName" placeholder="名称">
      <input id="skNewInstr" placeholder="指令（要它怎么做）">
      <button id="skNew">保存</button>
    </div>`
  const list = body.querySelector('#skList')
  if (!items.length) list.innerHTML = '<div class="drawer-empty">还没有技能。跑一次任务后点上面「生成」。</div>'
  for (const s of items) {
    const row = el('div', 'drawer-item')
    row.innerHTML = `
      <div><strong>${esc(s.name)}</strong><small>${esc(s.description || '')} · 用过 ${s.uses || 0} 次</small></div>
      <div class="drawer-row"><input class="sk-input" placeholder="本次输入（可选）"><button data-run>运行</button></div>`
    row.querySelector('[data-run]').onclick = async () => {
      try {
        const input = row.querySelector('.sk-input').value.trim()
        await api(`/api/skills/${s.id}/run`, { method: 'POST', body: JSON.stringify({ botId: state.botId, input }) })
        await refresh()
        notice('技能已发起')
      } catch (err) { showError(err) }
    }
    list.appendChild(row)
  }
  body.querySelector('#skFromTurn').onclick = async () => {
    try {
      if (!state.botId) throw new Error('先选一个 Bot')
      const tr = await api(`/api/bots/${state.botId}/transcript?cursor=0`)
      const last = [...tr.items].reverse().find((e) => e.kind === 'result')
      if (!last) throw new Error('当前会话还没有完成的任务')
      const name = body.querySelector('#skName').value.trim() || '新技能'
      await api('/api/skills/from-turn', { method: 'POST', body: JSON.stringify({ turnId: last.turnId, name }) })
      await render()
      notice('技能已生成')
    } catch (err) { showError(err) }
  }
  body.querySelector('#skNew').onclick = async () => {
    try {
      await api('/api/skills', { method: 'POST', body: JSON.stringify({
        name: body.querySelector('#skNewName').value.trim(),
        instruction: body.querySelector('#skNewInstr').value.trim(),
      }) })
      await render()
      notice('技能已保存')
    } catch (err) { showError(err) }
  }
}

async function renderRoutines(body) {
  const { items } = await api('/api/routines')
  body.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-label">新建自动化</div>
      <input id="rtName" placeholder="名称">
      <textarea id="rtInstr" placeholder="要做的事（一句话）"></textarea>
      <select id="rtType"><option value="event">事件触发（窄匹配）</option><option value="interval">定时</option></select>
      <div class="drawer-row"><input id="rtSource" placeholder="来源，如 github"><input id="rtPhrase" placeholder="必须包含的关键词"></div>
      <div class="drawer-row"><input id="rtEvery" type="number" value="60" min="15"><span class="muted">秒（仅定时用，最小 15）</span></div>
      <button id="rtCreate">创建</button>
    </div>
    <div class="drawer-section"><div class="drawer-label">已有自动化</div><div id="rtList"></div></div>
    <div class="drawer-section">
      <div class="drawer-label">投一个事件试试</div>
      <div class="drawer-row"><input id="evSource" placeholder="来源"><input id="evText" placeholder="内容"><button id="evSend">投递</button></div>
      <div id="evResult" class="drawer-empty"></div>
    </div>`
  const list = body.querySelector('#rtList')
  if (!items.length) list.innerHTML = '<div class="drawer-empty">还没有自动化。</div>'
  for (const r of items) {
    const row = el('div', 'drawer-item')
    const t = r.trigger || {}
    const trigger = t.type === 'interval'
      ? `每 ${Math.round((t.everyMs || 60000) / 1000)} 秒`
      : `事件 ${esc(t.source || '任意')} / ${esc(t.phrase || '任意')}`
    row.innerHTML = `
      <div><strong>${esc(r.name)}</strong><small>${trigger} · ${r.enabled ? '启用' : '停用'} · 跑过 ${r.runCount || 0} 次</small></div>
      <div class="drawer-row">
        <button data-toggle>${r.enabled ? '停用' : '启用'}</button>
        <button data-test>测试</button>
        <button data-del class="ghost">删除</button>
      </div>`
    row.querySelector('[data-toggle]').onclick = async () => {
      try {
        await api(`/api/routines/${r.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: !r.enabled }) })
        await render()
      } catch (err) { showError(err) }
    }
    row.querySelector('[data-test]').onclick = async () => {
      try {
        await api(`/api/routines/${r.id}/test`, { method: 'POST', body: '{}' })
        await refresh()
        notice('已手动触发')
      } catch (err) { showError(err) }
    }
    row.querySelector('[data-del]').onclick = async () => {
      try { await api(`/api/routines/${r.id}`, { method: 'DELETE' }); await render() } catch (err) { showError(err) }
    }
    list.appendChild(row)
  }
  body.querySelector('#rtCreate').onclick = async () => {
    try {
      if (!state.botId) throw new Error('先选一个 Bot')
      const type = body.querySelector('#rtType').value
      const trigger = type === 'interval'
        ? { type: 'interval', everyMs: Number(body.querySelector('#rtEvery').value || 60) * 1000 }
        : {
          type: 'event',
          source: body.querySelector('#rtSource').value.trim(),
          phrase: body.querySelector('#rtPhrase').value.trim(),
        }
      await api('/api/routines', { method: 'POST', body: JSON.stringify({
        botId: state.botId,
        name: body.querySelector('#rtName').value.trim(),
        instruction: body.querySelector('#rtInstr').value.trim(),
        trigger,
      }) })
      await render()
      notice('自动化已创建')
    } catch (err) { showError(err) }
  }
  body.querySelector('#evSend').onclick = async () => {
    try {
      const res = await api('/api/events/ingest', { method: 'POST', body: JSON.stringify({
        source: body.querySelector('#evSource').value.trim(),
        text: body.querySelector('#evText').value.trim(),
      }) })
      body.querySelector('#evResult').textContent = `命中 ${res.fired?.length || 0} 条自动化`
    } catch (err) { showError(err) }
  }
}

async function renderChannels(body) {
  const [{ items: channels }, { items: bots }] = await Promise.all([api('/api/channels'), api('/api/bots')])
  body.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-label">新建渠道（token 只显示一次）</div>
      <input id="chName" placeholder="名称">
      <select id="chKind"><option value="webhook">Webhook</option><option value="slack">Slack</option><option value="email">邮件</option></select>
      <select id="chBot">${bots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
      <input id="chPhrase" placeholder="必须包含的关键词（窄匹配，可空）">
      <button id="chCreate">创建</button>
      <div id="chToken" class="drawer-empty"></div>
    </div>
    <div class="drawer-section"><div class="drawer-label">已有渠道 · 谁能指挥我的 Bot</div><div id="chList"></div></div>`
  const list = body.querySelector('#chList')
  if (!channels.length) list.innerHTML = '<div class="drawer-empty">还没有渠道。</div>'
  for (const c of channels) {
    const row = el('div', 'drawer-item')
    row.innerHTML = `<div><strong>${esc(c.name)}</strong><small>${esc(c.kind)} · ${c.enabled ? '启用' : '停用'} · 调用 ${c.calls || 0} 次</small></div>
      <div class="drawer-row"><button data-toggle>${c.enabled ? '停用' : '启用'}</button><button data-revoke class="ghost">撤销</button></div>`
    row.querySelector('[data-toggle]').onclick = async () => {
      try {
        await api(`/api/channels/${c.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: !c.enabled }) })
        await render()
      } catch (err) { showError(err) }
    }
    row.querySelector('[data-revoke]').onclick = async () => {
      try { await api(`/api/channels/${c.id}`, { method: 'DELETE' }); await render() } catch (err) { showError(err) }
    }
    list.appendChild(row)
  }
  body.querySelector('#chCreate').onclick = async () => {
    try {
      const created = await api('/api/channels', { method: 'POST', body: JSON.stringify({
        name: body.querySelector('#chName').value.trim(),
        kind: body.querySelector('#chKind').value,
        botId: body.querySelector('#chBot').value,
        phrase: body.querySelector('#chPhrase').value.trim(),
      }) })
      body.querySelector('#chToken').textContent = `token（只显示一次，请保存）：${created.token}`
      notice('渠道已创建')
    } catch (err) { showError(err) }
  }
}

async function renderTeams(body) {
  const [{ items: teams }, quota, { items: bots }] = await Promise.all([
    api('/api/teams'), api('/api/quota'), api('/api/bots'),
  ])
  body.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-label">新建团队（每日 turn 额度，0 = 不限）</div>
      <input id="tmName" placeholder="团队名称">
      <input id="tmQuota" type="number" value="20" min="0">
      <button id="tmCreate">创建</button>
    </div>
    <div class="drawer-section"><div class="drawer-label">团队用量（${esc(quota.day || '')}）</div><div id="tmList"></div></div>
    <div class="drawer-section">
      <div class="drawer-label">把 Bot 加入团队</div>
      <select id="tmBot">${bots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
      <select id="tmTeam">${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
      <button id="tmAssign">加入</button>
    </div>`
  const list = body.querySelector('#tmList')
  const rows = quota.teams || []
  if (!rows.length) list.innerHTML = '<div class="drawer-empty">还没有团队；未加入团队的 Bot 不计量。</div>'
  for (const t of rows) {
    const row = el('div', 'drawer-item')
    row.innerHTML = `<div><strong>${esc(t.name)}</strong><small>今日 ${t.usedToday || 0} / ${t.quotaPerDay || '不限'}</small></div>`
    list.appendChild(row)
  }
  body.querySelector('#tmCreate').onclick = async () => {
    try {
      await api('/api/teams', { method: 'POST', body: JSON.stringify({
        name: body.querySelector('#tmName').value.trim(),
        quotaPerDay: Number(body.querySelector('#tmQuota').value || 0),
      }) })
      await render()
      notice('团队已创建')
    } catch (err) { showError(err) }
  }
  body.querySelector('#tmAssign').onclick = async () => {
    try {
      await api(`/api/teams/${body.querySelector('#tmTeam').value}/assign`, {
        method: 'POST', body: JSON.stringify({ botId: body.querySelector('#tmBot').value }),
      })
      await render()
      notice('Bot 已加入团队')
    } catch (err) { showError(err) }
  }
}

async function renderRooms(body) {
  const [{ items: rooms }, { items: bots }] = await Promise.all([api('/api/rooms'), api('/api/bots')])
  body.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-label">新建群聊</div>
      <input id="rmName" placeholder="群聊名称">
      <div class="drawer-label">成员</div>
      <div id="rmMembers"></div>
      <button id="rmCreate">创建</button>
    </div>
    <div class="drawer-section"><div class="drawer-label">已有群聊</div><div id="rmList"></div></div>`
  const members = body.querySelector('#rmMembers')
  if (!bots.length) members.innerHTML = '<div class="drawer-empty">先建两个 Bot。</div>'
  for (const b of bots) {
    const label = el('label', 'check-row')
    label.innerHTML = `<input type="checkbox" value="${esc(b.id)}"> ${esc(b.name)}`
    members.appendChild(label)
  }
  const list = body.querySelector('#rmList')
  if (!rooms.length) list.innerHTML = '<div class="drawer-empty">还没有群聊。</div>'
  for (const room of rooms) {
    const row = el('div', 'drawer-item')
    row.innerHTML = `
      <div><strong>${esc(room.name)}</strong><small>${(room.members || []).length} 个成员</small></div>
      <div class="drawer-row"><button data-enter>进入</button></div>`
    row.querySelector('[data-enter]').onclick = async () => {
      if (!state.bots.some((b) => b.id === room.id)) state.bots.push(room)
      await selectBot(room.id)
      closeDrawer()
    }
    list.appendChild(row)
  }
  body.querySelector('#rmCreate').onclick = async () => {
    try {
      const created = await api('/api/rooms', { method: 'POST', body: JSON.stringify({
        name: body.querySelector('#rmName').value.trim(),
        memberIds: [...members.querySelectorAll('input:checked')].map((i) => i.value),
      }) })
      if (!state.bots.some((b) => b.id === created.id)) state.bots.push(created)
      await render()
      notice('群聊已创建')
    } catch (err) { showError(err) }
  }
}

function syncRoomMention() {
  const room = state.bots.find((b) => b.id === state.botId && b.kind === 'room')
  if (!room) { mentionWrap.hidden = true; mentionSelect.innerHTML = ''; return }
  mentionWrap.hidden = false
  mentionSelect.innerHTML = '<option value="">全部成员</option>' + (room.members || []).map((id) => {
    const b = state.bots.find((x) => x.id === id)
    return `<option value="${esc(id)}">${esc(b?.name || id)}</option>`
  }).join('')
}

window.addEventListener('p0a:botchange', syncRoomMention)
syncRoomMention()

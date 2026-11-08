// Connection state is a quiet, UI-only hint: it never writes to the timeline,
// 不碰游标与去重集合，也不改 SSE 的 botId 过滤。
// 没有它时，长任务跑着断线，状态栏仍写「工作中」却不再更新，用户分不清
// 「它还在干活」还是「连接掉了」，也容易错过重启后那张「接着做」卡。
// 重连沿用既有 onopen → refresh() 补拉增量，这里只负责让人看得见。
export const CONNECTION_LOST_TEXT = '连接断了，正在重连…'

/**
 * @param {{hidden: boolean, textContent: string} | null | undefined} el
 * @param {boolean} connected
 */
export function applyConnection(el, connected) {
  if (!el) return
  el.hidden = Boolean(connected)
  el.textContent = connected ? '' : CONNECTION_LOST_TEXT
}

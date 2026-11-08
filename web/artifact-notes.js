// Honest, low-attention notes for a deliverable card.
//
// The engine already writes composeBatches / composeDegraded / contentSource /
// preview into the append-only timeline, but the card used to show only a
// filename, a byte count and a preview. A system downgrade, a batched compose
// or a bounded material set was therefore INVISIBLE to the human -- exactly
// the "say the downgrade on the timeline, never silently" rule in AGENTS.md
// section 2. These notes only appear when there is something to disclose:
// a normal single-batch compose adds NO DOM at all.
//
// Pure module: no DOM, no network, no state. Safe to unit-test with Node.
export function artifactNotes(e) {
  const notes = []
  if (!e || typeof e !== 'object') return notes

  if (e.composeDegraded === true) {
    notes.push({ text: '模型没写成，已用本机材料原文兜底', warn: true })
  }
  if (Array.isArray(e.preview) && e.preview.some((l) => /材料有界/.test(String(l)))) {
    notes.push({ text: '还有后续材料未纳入，请分批续读后再补', warn: true })
  }
  if (Number(e.composeBatches) > 1) {
    notes.push({ text: `按 ${Number(e.composeBatches)} 页材料分段整理`, warn: false })
  }
  if (e.contentSource === 'material' && e.composeDegraded !== true) {
    notes.push({ text: '内容来自本机检索材料，未经模型改写', warn: false })
  }
  if (e.contentSource === 'empty') {
    notes.push({ text: '没有读到可用材料，也没能生成内容', warn: true })
  }
  // integrity === false already shows "写入校验失败" in the card header;
  // do not repeat it here. previewTruncated already has its own footer line.
  return notes
}

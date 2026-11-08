// Kind words for a failed step on the timeline.
//
// The provider already classifies failures (transport / entitlement / agent)
// and keeps that structure as fields on the append-only record. Rendering it
// verbatim leaked internal variable names at people: a proxy blip answers
// 401/403 upstream, becomes the credential class, and the row told the user to
// go edit an environment variable -- when the right move was simply to send
// the message again. Talk like a colleague: a plain reason, one next step, no
// internal code. The structured fields stay on the record for debugging; only
// the visible wording changes here.
//
// Pure module: no UI elements, no requests, no state. Safe to test with Node.

// Internal identifiers and raw error-object fragments must never reach a
// person. If a kept message contains one, fall back to plain wording.
const INTERNAL = /DEEPSEEK_|DSH_|NO_CREDENTIAL|USAGE_LIMIT|AGENT_FAILED|COMMAND_NOT_ALLOWED|NOT_IMPLEMENTED|ARTIFACT_INTEGRITY|DSH_VERSION_MISMATCH|BAD_REQUEST|NOT_FOUND|ENTITLEMENT|TRANSPORT|LocalExecutor|__status|response_format|reasoning_effort|AppError|ECONN|fetch failed|timeout|timed out|\bError:|TypeError|ReferenceError|SyntaxError|Cannot read|Unexpected token|ENOENT|ENOTFOUND|EACCES|\bundefined\b|\bnull\b/i

// A hiccup reaching the model, whether or not a structured code came along.
const TRANSIENT = /不可达|没连上|临时不可用|网络|超时|fetch failed|timeout|timed out|ECONN|network|429|限流|502|503|504|模型服务返回 5/i

const GENERIC = { title: '这一步没做成', detail: '现场已保留，可以再发一次。', quiet: false }

function kept(s, fallback) {
  const t = String(s ?? '').trim()
  if (!t || INTERNAL.test(t)) return fallback
  return t.length > 200 ? `${t.slice(0, 200)}…` : t
}

/**
 * Turn a structured failure into what a colleague would actually say.
 * @param {{code?:string, family?:string, title?:string, detail?:string, message?:string}} e
 * @returns {{title:string, detail:string, quiet:boolean}} plain text, ready to escape
 */
export function errorCopy(e) {
  if (!e || typeof e !== 'object') return { ...GENERIC }

  const code = String(e.code || '')
  const family = String(e.family || '')
  const rawDetail = e.detail ?? e.message ?? ''
  const rawTitle = e.title
  const both = `${String(rawTitle || '')} ${String(rawDetail || '')}`

  // Paused mid-task: the run is safe on disk and a resume card is already up.
  if (/停在第 \d/.test(String(rawDetail))) {
    return { title: '刚才没连上模型，这一步先停住了', detail: '现场已保留，点「接着做」从这一步继续就行。', quiet: true }
  }

  // Bad upstream auth / a proxy blip. Never name an environment variable,
  // and never send a person off to edit configuration for a transient blip.
  if (code === 'NO_CREDENTIAL' || /DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|模型密钥未被接受|还没有配置模型密钥/.test(both)) {
    return { title: '模型服务这次没接上', detail: '刚才没能连到模型，直接再发一次就行，不用改本机配置。', quiet: true }
  }

  // Quota or throttling is a distinct, real condition -- say so plainly.
  if (code === 'USAGE_LIMIT' || /额度|用量|配额|quota/i.test(both)) {
    return { title: '这会儿模型额度或服务限流了', detail: '稍等一下再发一次；如果一直这样，可能是本周用量到上限了。', quiet: false }
  }

  // Transient transport / model-server failures, including code-less ones.
  if (TRANSIENT.test(both) && (code === 'AGENT_FAILED' || code === '' || family === 'transport')) {
    return { title: '刚才没连上模型', detail: '网络或模型服务临时不可用，直接再发一次就行。', quiet: true }
  }

  // Deliberate, program-side refusals keep their honest Chinese wording
  // (command not allowed, version mismatch, integrity check, bad request...).
  // A bare, unclassified failure is local and retryable, so stay low-key.
  return {
    title: kept(rawTitle, GENERIC.title),
    detail: kept(rawDetail, GENERIC.detail),
    quiet: !(code || family),
  }
}

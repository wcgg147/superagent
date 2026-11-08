/**
 * RFC 5987 Content-Disposition. Node rejects non-Latin-1 characters in header
 * values, so a model-provided Chinese filename needs a percent-encoded form.
 */
export function contentDisposition(filename) {
  const name = String(filename || 'download')
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\r\n\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

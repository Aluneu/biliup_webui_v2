// ============================================================================
// Mock 层：响应与占位图工具
// ============================================================================

export function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

export function text(body: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

/** 204 无内容（后端不少 DELETE 用这个） */
export function noContent(): Response {
  return new Response(null, { status: 204 })
}

export function notFound(message = 'not found'): Response {
  return json({ message }, 404)
}

export function badRequest(message: string): Response {
  return json({ message }, 400)
}

/** 演示站里所有写操作都成功；返回统一结构，个别接口需要 201/202 自行传 status */
export function ok(data: any = { success: true }, status = 200): Response {
  return json(data, status)
}

/** 解析路径里的数字 id */
export function idOf(ctx: { path: string }, pattern: RegExp, group = 1): number {
  const m = ctx.path.match(pattern)
  return m ? Number(m[group]) : NaN
}

/** 确定性伪随机：同一个 seed 每次结果一样，避免服务端/客户端渲染不一致 */
export function seeded(seed: number): () => number {
  let s = (seed || 1) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 在一个区间里挑一个稳定值 */
export function seededInt(seed: number, min: number, max: number): number {
  const r = seeded(seed)()
  return Math.floor(min + r * (max - min))
}

/** 转义 XML 文本，避免主播名里的 & < > 破坏 SVG */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

const COVER_PALETTES = [
  ['#1f1147', '#3a2f8f', '#ff5f7e'],
  ['#0b2545', '#134074', '#5ec8ff'],
  ['#2b1b3d', '#5b2a86', '#ffb86b'],
  ['#10261f', '#1f6f54', '#8ff7c8'],
  ['#33101a', '#7a2033', '#ff9f68'],
  ['#161b2e', '#2b3a67', '#9db4ff'],
]

/**
 * 直播间封面占位图（SVG）。真实演示站拉不到外链图片，这里按房间名生成一张
 * 有渐变、有 LIVE 角标、有主播名的封面，卡片看起来才像在跑。
 */
export function coverSvg(title: string, seed: number, live: boolean): Response {
  const p = COVER_PALETTES[Math.abs(seed) % COVER_PALETTES.length]
  const id = Math.abs(seed) % 100000
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs>
<linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${p[0]}"/><stop offset="55%" stop-color="${p[1]}"/><stop offset="100%" stop-color="${p[2]}" stop-opacity="0.85"/>
</linearGradient>
<radialGradient id="r${id}" cx="78%" cy="18%" r="60%">
<stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="640" height="360" fill="url(#g${id})"/>
<rect width="640" height="360" fill="url(#r${id})"/>
<g opacity="0.18" fill="none" stroke="#ffffff" stroke-width="1.4">
<circle cx="560" cy="300" r="150"/><circle cx="560" cy="300" r="110"/><circle cx="560" cy="300" r="70"/>
</g>
${live ? `<g><rect x="24" y="24" rx="4" width="66" height="26" fill="#f5222d"/><text x="57" y="42" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">LIVE</text></g>` : ''}
<text x="32" y="292" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="30" font-weight="700" fill="#ffffff" opacity="0.96">${esc(title)}</text>
<text x="32" y="322" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="15" fill="#ffffff" opacity="0.7">biliup 演示站 · 录制中</text>
</svg>`
  return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' } })
}

/** 主播头像占位图（SVG，首字 + 渐变圆） */
export function avatarSvg(name: string, seed: number): Response {
  const p = COVER_PALETTES[Math.abs(seed) % COVER_PALETTES.length]
  const id = Math.abs(seed) % 100000
  const initial = esc(Array.from(name.trim())[0] ?? '播')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<defs><linearGradient id="a${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${p[1]}"/><stop offset="100%" stop-color="${p[2]}"/>
</linearGradient></defs>
<circle cx="48" cy="48" r="48" fill="url(#a${id})"/>
<text x="48" y="60" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="38" font-weight="600" fill="#ffffff" text-anchor="middle">${initial}</text>
</svg>`
  return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' } })
}

/** 1×1 透明 PNG，供 /bili/proxy 兜底 */
export function placeholderPng(): Response {
  const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const bytes = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0))
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } })
}

/** base64 JPEG → Response（画面遮挡编辑器只接受 image/jpeg） */
export function jpeg(base64: string, cache = 'no-store'): Response {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': cache },
  })
}

/** 上传图片资产（POST /v1/sessions/{id}/render-assets）→ 回显一张占位 SVG */
export function uploadedAssetSvg(width = 320, height = 180): Response {
  return coverSvg('图片素材', 7, false)
}

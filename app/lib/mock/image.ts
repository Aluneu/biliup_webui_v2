// ============================================================================
// Mock：图片占位（data URI）
// ----------------------------------------------------------------------------
// 演示站的封面 / 头像 / 缩略图本来就是服务端生成的，浏览器用 `<img src>` 加载，
// **不会被 fetch 拦截器接管**——直接指向 /v1/... 只会得到 404 的破图。
// 所以这里把图片 URL 生成函数在 mock 模式下改成内联 SVG（data URI），
// 首屏就能显示，不依赖任何网络。
// ============================================================================

const PALETTES = [
  ['#1f1147', '#3a2f8f', '#ff5f7e'],
  ['#0b2545', '#134074', '#5ec8ff'],
  ['#2b1b3d', '#5b2a86', '#ffb86b'],
  ['#10261f', '#1f6f54', '#8ff7c8'],
  ['#33101a', '#7a2033', '#ff9f68'],
  ['#161b2e', '#2b3a67', '#9db4ff'],
]

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function dataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 直播间封面：渐变 + LIVE 角标 + 主播名 */
export function coverDataUri(title: string, seed: number, live: boolean): string {
  const p = PALETTES[Math.abs(seed) % PALETTES.length]
  const id = Math.abs(seed) % 100000
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${p[0]}"/><stop offset="55%" stop-color="${p[1]}"/><stop offset="100%" stop-color="${p[2]}" stop-opacity="0.9"/>
</linearGradient></defs>
<rect width="640" height="360" fill="url(#g${id})"/>
<g opacity="0.16" fill="none" stroke="#ffffff" stroke-width="1.5">
<circle cx="556" cy="300" r="150"/><circle cx="556" cy="300" r="108"/><circle cx="556" cy="300" r="66"/>
</g>
${live ? '<rect x="24" y="24" rx="4" width="64" height="26" fill="#f5222d"/><text x="32" y="42" font-family="system-ui,-apple-system,\'Segoe UI\',sans-serif" font-size="14" font-weight="700" fill="#fff">LIVE</text>' : ''}
<text x="32" y="296" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="30" font-weight="700" fill="#ffffff" opacity="0.96">${esc(title)}</text>
<text x="32" y="326" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="14" fill="#ffffff" opacity="0.7">biliup 演示站</text>
</svg>`)
}

/** 主播头像：渐变圆 + 首字 */
export function avatarDataUri(name: string, seed: number): string {
  const p = PALETTES[Math.abs(seed) % PALETTES.length]
  const id = Math.abs(seed) % 100000
  const initial = esc(Array.from(name.trim())[0] ?? '播')
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<defs><linearGradient id="a${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${p[1]}"/><stop offset="100%" stop-color="${p[2]}"/>
</linearGradient></defs>
<circle cx="48" cy="48" r="48" fill="url(#a${id})"/>
<text x="48" y="60" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="38" font-weight="600" fill="#fff" text-anchor="middle">${initial}</text>
</svg>`)
}

/** 通用占位图：标题 + 副标题（缩略图 / 封面 / 素材用） */
export function placeholderDataUri(title: string, subtitle: string, seed: number, ratio: '16:9' | 'square' = '16:9'): string {
  const p = PALETTES[Math.abs(seed) % PALETTES.length]
  const id = Math.abs(seed) % 100000
  const w = ratio === 'square' ? 480 : 640
  const h = ratio === 'square' ? 480 : 360
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="p${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${p[0]}"/><stop offset="100%" stop-color="${p[1]}"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#p${id})"/>
<circle cx="${w * 0.5}" cy="${h * 0.42}" r="${h * 0.11}" fill="#ffffff" fill-opacity="0.16"/>
<path d="M${w * 0.5 - 14} ${h * 0.42 - 18} L${w * 0.5 - 14} ${h * 0.42 + 18} L${w * 0.5 + 18} ${h * 0.42} Z" fill="#ffffff" fill-opacity="0.5"/>
<text x="${w / 2}" y="${h * 0.68}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="${Math.round(h * 0.06)}" font-weight="600" fill="#ffffff" opacity="0.94" text-anchor="middle">${esc(title)}</text>
<text x="${w / 2}" y="${h * 0.79}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="${Math.round(h * 0.042)}" fill="#ffffff" opacity="0.65" text-anchor="middle">${esc(subtitle)}</text>
</svg>`)
}

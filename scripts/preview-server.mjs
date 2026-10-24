// 极简静态服务器：用来预览 `next build` 导出的 out/（模拟 GitHub Pages 的目录式路由）
// 用法：node scripts/preview-server.mjs [port]
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'

const root = new URL('../out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const port = Number(process.argv[2] || 8899)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    let file = join(root, p)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) {
      // 目录式路由（/streamers → /streamers/index.html）；导出的 404 页兜底
      const alt = join(root, p, 'index.html')
      file = existsSync(alt) ? alt : join(root, '404.html')
    }
    if (!existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    createReadStream(file).pipe(res)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(e))
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port}/  (root: ${root})`)
})

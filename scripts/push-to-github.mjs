// 通过 GitHub Git Data API 把当前目录内容作为一个提交推到 Aluneu/biliup_webui_v2
// 用法：设置 GH_TOKEN 后 node scripts/push-to-github.mjs [--dry]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

const OWNER = 'Aluneu'
const REPO = 'biliup_webui_v2'
const BRANCH = 'main'
const TOKEN = process.env.GH_TOKEN
if (!TOKEN) throw new Error('GH_TOKEN not set')
const DRY = process.argv.includes('--dry')

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'shots', '.git', 'target', '.dsh_tmp'])
const SKIP_FILES = new Set(['tsconfig.tsbuildinfo', '.DS_Store', '.git-token'])

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-biliup-demo',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return body
}

/** 本地文件列表：posix 相对路径 → 绝对路径 */
function localFiles() {
  const out = new Map()
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relative(root, full).split('\\').join('/')
      if (SKIP_FILES.has(name)) continue
      const st = statSync(full)
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(full)
      } else if (st.isFile()) {
        out.set(rel, full)
      }
    }
  }
  walk(root)
  return out
}

const main = async () => {
  const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
  const headSha = ref.object.sha
  const headCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${headSha}`)
  const baseTreeSha = headCommit.tree.sha
  const baseTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`)

  const remote = new Map()
  for (const e of baseTree.tree) {
    if (e.type === 'blob') remote.set(e.path, e.sha)
    else if (e.type === 'commit') remote.set(e.path, { gitlink: true, sha: e.sha })
  }
  const local = localFiles()

  // 远端有、本地没有 → 删除（gitlink/子模块与 CNAME 保留）
  const deletes = []
  for (const path of remote.keys()) {
    if (local.has(path)) continue
    if (path === 'CNAME') { console.log('保留 CNAME（自定义域名）'); continue }
    const r = remote.get(path)
    if (r && typeof r === 'object' && r.gitlink) { console.log('保留子模块', path); continue }
    deletes.push(path)
  }

  console.log(`远端 ${remote.size} 个条目，本地 ${local.size} 个文件；新增/更新 ${local.size}，删除 ${deletes.length}`)
  if (deletes.length) console.log('删除示例:', deletes.slice(0, 10).join(', '), deletes.length > 10 ? '…' : '')
  if (DRY) return

  // 1) 并发上传 blob
  const entries = []
  let done = 0
  const queue = [...local.entries()]
  const worker = async () => {
    while (queue.length) {
      const [path, full] = queue.shift()
      const content = readFileSync(full).toString('base64')
      const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'base64' }),
      })
      const mode = path.endsWith('.sh') || path.endsWith('.ps1') ? '100755' : '100644'
      entries.push({ path, mode, type: 'blob', sha: blob.sha })
      if (++done % 40 === 0) console.log(`  已上传 ${done}/${local.size}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  for (const path of deletes) entries.push({ path, mode: '100644', type: 'blob', sha: null })

  // 2) 建树（base_tree 保留子模块等未涉及条目）
  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
  })

  // 3) 建提交并移动分支
  const message = `feat(demo): 对齐 biliup v1.3.4 前端并重写 mock 层

- 前端整体同步上游 master(v1.3.4)：剪辑台/回放/压制任务/上传队列/B站稿件/用户管理/多机节点(HA)/直播预览
- mock 层拆分为 12 个模块，覆盖 80 余条接口路径；含 WebSocket(日志/写盘速率) 与 SSE(弹幕)
- 直播间扩充到 30 个（8 路录制中，覆盖 8 个平台），节点侧房间同步到 16 个
- 静态导出适配：整页跳转导航 + basePath、假登录、演示角标、图片走内联 SVG
- 构建与截图自检脚本：scripts/preview-server.mjs、scripts/shots.ps1`
  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
  })
  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
  console.log('已推送提交', commit.sha, commit.html_url)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })

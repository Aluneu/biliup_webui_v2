// ============================================================================
// biliup 演示站 · Mock 数据层
// ----------------------------------------------------------------------------
// 本模块在浏览器端 patch `window.fetch`，拦截所有同源的 `/v1`、`/bili`、`/static`
// 请求并返回模拟数据，使前端在完全没有后端的情况下也能完整渲染与交互。
//
// 另外还接管了 `WebSocket`（实时日志、写盘速率）与 `EventSource`（直播弹幕），
// 见 `./sockets.ts`。
//
// 外部链接（GitHub 更新日志、B 站图片等）会被放行，走真实网络。
// ============================================================================

import type { MockCtx, MockHandler } from './types'
import { json, text } from './util'
import { coreHandlers, fallbackHandler } from './core'
import { streamerHandlers } from './streamers'
import { liveHandlers } from './live'
import { sessionHandlers } from './sessions'
import { renderHandlers } from './renders'
import { uploadHandlers } from './uploads'
import { fleetHandlers } from './fleet'
import { configHandlers } from './config'
import { statsHandlers } from './stats'
import { installMockSockets } from './sockets'
import { BASE_PATH } from '../nav'

// 演示站永远启用 mock 假数据。
// 注意：不要依赖 process.env.NEXT_PUBLIC_MOCK 判断——本项目实测 Next 的
// loadEnvConfig / webpack DefinePlugin 对该变量的注入不稳定（无论来自 .env
// 还是 next.config 的 env 字段，都会被算成假值），导致整段 mock 被 tree-shake、
// 页面静默无数据且 Console 无报错。这里直接写死 true。
export const MOCK_ENABLED = true

/**
 * 路由链：顺序敏感——具体模块在前，`core` 的通用接口在后，兜底 404 最后。
 */
const HANDLERS: MockHandler[] = [
  ...streamerHandlers,
  ...liveHandlers,
  ...sessionHandlers,
  ...renderHandlers,
  ...uploadHandlers,
  ...fleetHandlers,
  ...configHandlers,
  ...statsHandlers,
  ...coreHandlers,
  fallbackHandler,
]

function parseBody(init?: RequestInit): any {
  const body = init?.body
  if (body == null) return null
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  return body
}

async function route(ctx: MockCtx): Promise<Response> {
  for (const handler of HANDLERS) {
    try {
      const res = handler(ctx)
      if (res) return res
    } catch (e) {
      // 单个处理器出错不能拖垮整页：记录后继续问下一个
      console.warn('[mock] handler error', ctx.method, ctx.path, e)
    }
  }
  return json({ message: 'mock: no handler' }, 404)
}

/** 静态文件：日志返回示例文本；录像 / 封面等返回 404（播放器会优雅报错，页面不崩） */
function staticResponse(pathname: string): Response {
  const name = decodeURIComponent(pathname.slice('/static/'.length))
  if (name.endsWith('.log')) {
    return text(
      [
        `[${new Date().toISOString()}] [INFO] biliup 演示站已启动（mock 模式，无真实后端）`,
        `[${new Date().toISOString()}] [INFO] 正在监控 8 个直播间，其中 4 个正在录制`,
        `[${new Date().toISOString()}] [DOWNLOAD] 开始录制 https://live.bilibili.com/77330（老番茄）`,
        `[${new Date().toISOString()}] [UPLOAD] 分段 part_1.flv 上传完成，用时 1420 ms`,
        `[${new Date().toISOString()}] [INFO] 场次 5001 生成标记 3 个，剪辑台可回看`,
        `[${new Date().toISOString()}] [RENDER] 压制任务 #9003 开始合成（弹幕 + 画面遮挡）`,
        `[${new Date().toISOString()}] [WARN] 这是演示日志，实时日志由 /v1/ws/logs 推送`,
      ].join('\n')
    )
  }
  return new Response('Not Found (demo)', { status: 404 })
}

export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const url = new URL(raw, window.location.origin)
  // 部署在子路径时（BASE_PATH=/repo），把它从路径里剥掉，路由表里只写 /v1/...
  let pathname = url.pathname
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) pathname = pathname.slice(BASE_PATH.length) || '/'

  if (pathname.startsWith('/static/')) return staticResponse(pathname)

  const ctx: MockCtx = {
    method,
    path: pathname,
    query: url.searchParams,
    body: parseBody(init),
    headers: new Headers(init?.headers),
    url,
  }
  return route(ctx)
}

// ---------------------------------------------------------------------------
// 安装：patch window.fetch / WebSocket / EventSource（仅浏览器、仅一次）
// ---------------------------------------------------------------------------

export function installMockFetch() {
  if (typeof window === 'undefined') return
  const w = window as any
  if (w.__biliupMockInstalled) return
  w.__biliupMockInstalled = true

  installMockSockets()

  const originalFetch = window.fetch.bind(window)

  const isMockable = (url: string): boolean => {
    if (url.startsWith('/')) return true
    try {
      return new URL(url, window.location.origin).origin === window.location.origin
    } catch {
      return false
    }
  }

  // 只 mock API 路径；其它同源请求（如 Next 客户端导航的 RSC fetch：
  // fetch('/streamers/', { headers: { RSC: '1' } })）必须放行走真实网络，
  // 否则导航拿到 404/空响应，App Router 会静默放弃导航。
  const isApiPath = (pathname: string): boolean => {
    let p = pathname
    if (BASE_PATH && p.startsWith(BASE_PATH)) p = p.slice(BASE_PATH.length) || '/'
    return (
      p === '/v1' || p.startsWith('/v1/') || p.startsWith('/bili/') || p.startsWith('/static/')
    )
  }

  w.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (isMockable(raw)) {
      try {
        const parsed = new URL(raw, window.location.origin)
        if (isApiPath(parsed.pathname)) return await mockFetch(input, init)
      } catch {
        // 任何 mock 异常都回退到真实请求，保证页面不崩
        return originalFetch(input, init)
      }
    }
    return originalFetch(input, init)
  }
}

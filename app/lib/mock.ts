// ============================================================================
// biliup 演示站 · Mock 数据层
// ----------------------------------------------------------------------------
// 当 NEXT_PUBLIC_MOCK=true 时，本模块会在浏览器端 patch window.fetch，
// 拦截所有同源的 /v1、/bili、/static 请求并返回模拟数据，
// 使前端在完全没有后端的情况下也能完整渲染与交互。
//
// 外部链接（GitHub 更新日志、B 站图片等）会被放行，走真实网络。
// ============================================================================

// 演示站永远启用 mock 假数据。
// 注意：不要依赖 process.env.NEXT_PUBLIC_MOCK 判断——本项目实测 Next 的
// loadEnvConfig / webpack DefinePlugin 对该变量的注入不稳定（无论来自 .env
// 还是 next.config 的 env 字段，都会被算成假值），导致整段 mock 被 tree-shake、
// 页面静默无数据且 Console 无报错。这里直接写死 true。
export const MOCK_ENABLED = true

// ---------------------------------------------------------------------------
// 内存数据（可变，支持增删改实时反映到后续查询，让演示站"像真的在跑"）
// ---------------------------------------------------------------------------

const nowSec = Math.floor(Date.now() / 1000)

let streamers: any[] = [
  {
    id: 1,
    url: 'https://live.bilibili.com/77330',
    remark: '老番茄',
    filename: '{streamer}%Y-%m-%dT%H_%M_%S',
    split_time: 0,
    split_size: 0,
    upload_id: 1001,
    status: 'Working',
    upload_status: 'Pending',
    format: 'flv',
    time_range: ['20:00:00', '23:00:00'],
    excluded_keywords: ['回放', '测试'],
  },
  {
    id: 2,
    url: 'https://live.bilibili.com/21548251',
    remark: '影视飓风',
    filename: '{streamer}_{title}',
    status: 'Idle',
    upload_status: '',
    time_range: '',
  },
  {
    id: 3,
    url: 'https://live.bilibili.com/123456',
    remark: '周末电台',
    filename: '{streamer}%Y-%m-%dT%H_%M_%S',
    status: 'Pause',
    upload_status: 'Working',
    time_range: '',
  },
  {
    id: 4,
    url: 'https://www.douyu.com/12345',
    remark: '水友赛直播间',
    filename: '{streamer}_{title}',
    status: 'Working',
    upload_status: '',
    time_range: '',
  },
  {
    id: 5,
    url: 'https://live.bilibili.com/99999',
    remark: '小众音乐人',
    filename: '{streamer}_{title}',
    status: 'OutOfSchedule',
    upload_status: '',
    time_range: ['20:00:00', '22:00:00'],
  },
]

let streamerInfo: any[] = [
  {
    id: 101,
    name: '老番茄',
    url: 'https://live.bilibili.com/77330',
    title: '【实况】今晚通宵打星际，来就完了',
    date: nowSec - 3600,
    live_cover_path: 'https://i0.hdslb.com/bfs/live/new_room_cover/cover_demo_77330.jpg',
  },
  {
    id: 102,
    name: '影视飓风',
    url: 'https://live.bilibili.com/21548251',
    title: '聊聊我们是怎么拍 4K 视频的（含设备清单）',
    date: nowSec - 7200,
    live_cover_path: 'https://i0.hdslb.com/bfs/live/new_room_cover/cover_demo_21548251.jpg',
  },
  {
    id: 103,
    name: '水友赛直播间',
    url: 'https://www.douyu.com/12345',
    title: '深夜水友赛 第 88 期',
    date: nowSec - 1800,
    live_cover_path: '',
  },
]

let users: any[] = [
  {
    id: 1,
    name: 'biliup-cookies',
    value: 'SESSDATA=demo_xxxx;bili_jct=demo_xxxx;DedeUserID=12345;',
    platform: 'bilibili-cookies',
  },
]

let uploadStreamers: any[] = [
  {
    id: 1,
    template_name: '老番茄-自动投稿',
    user_cookie: 'biliup-cookies',
    copyright: 2,
    copyright_source: '转自 https://live.bilibili.com/77330',
    tid: 172,
    cover_path: '/cover/laofanqie.jpg',
    title: '{streamer} {title} 直播回放',
    description: '本场直播录播，由 biliup 自动投稿。',
    dynamic: '直播回放来啦 {streamer}',
    tags: ['直播回放', '老番茄', '实况'],
    dtime: null,
    mission_id: null,
    dolby: 1,
    hires: 0,
    no_reprint: 1,
    is_only_self: 0,
    up_selection_reply: 0,
    up_close_reply: 0,
    up_close_danmu: 0,
    charging_pay: 1,
    credits: [{ username: '观众A', uid: 998877 }],
    uploader: 'biliup-rs',
    extra_fields: '{"subtitle": "open"}',
  },
  {
    id: 2,
    template_name: '影视飓风-横屏搬运',
    user_cookie: 'biliup-cookies',
    copyright: 1,
    copyright_source: '',
    tid: 211,
    cover_path: '',
    title: '{streamer} {title}',
    description: '自制内容，自动投稿。',
    dynamic: '',
    tags: ['影视飓风', '4K'],
    dtime: null,
    mission_id: null,
    dolby: 0,
    hires: 0,
    no_reprint: 1,
    is_only_self: 1,
    up_selection_reply: 0,
    up_close_reply: 0,
    up_close_danmu: 0,
    charging_pay: 0,
    credits: [],
    uploader: 'bili_web',
    extra_fields: '',
  },
]

let configuration: any = {
  downloader: 'stream-gears',
  sync_save_dir: null,
  file_size: 4294967296,
  segment_time: '01:00:00',
  filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
  segment_processor_parallel: false,
  filtering_threshold: 10,
  delay: 0,
  event_loop_interval: 10,
  pool1_size: 5,
  submit_api: 'web',
  uploader: 'biliup-rs',
  lines: 'AUTO',
  threads: 3,
  max_upload_limit: 3,
  pool2_size: 3,
  use_live_cover: true,
  bili_qn: '10000',
  bilibili_danmaku: false,
  bilibili_danmaku_detail: false,
  bilibili_danmaku_raw: false,
  user: {
    bili_cookie: 'SESSDATA=demo_xxxx;bili_jct=demo_xxxx;DedeUserID=12345;',
    bili_cookie_file: 'biliup-cookies',
  },
  bili_protocol: 'stream',
  bili_liveapi: 'https://api.live.bilibili.com',
  bili_fallback_api: '',
  bili_cdn: ['cn-gotcha204'],
  bili_cdn_fallback: false,
  bili_anonymous_origin: false,
  bili_hls_transcode_timeout: 60,
  LOGGING: {
    root: { level: 'INFO', handlers: ['console'] },
    loggers: { biliup: { handlers: ['file'], level: 'INFO' } },
  },
  loggers_level: 'INFO',
}

const statusData = {
  version: 'v1.2.2',
  downloader_status: { '77330': 'recording', '21548251': 'idle', '12345': 'recording' },
  uploader_status: { '1': 'pending', '3': 'uploading' },
  config: { downloader: 'stream-gears', threads: 3, lines: 'AUTO' },
}

const archivePre = {
  code: 0,
  message: 'ok',
  data: {
    typelist: [
      {
        id: 17,
        name: '单机游戏',
        desc: '电子竞技',
        children: [
          { id: 172, name: '单机游戏', desc: '实况、攻略等' },
          { id: 173, name: '电子竞技', desc: '赛事、解说等' },
        ],
      },
      {
        id: 21,
        name: '生活',
        desc: '日常',
        children: [{ id: 211, name: '日常', desc: 'vlog、记录' }],
      },
      {
        id: 19,
        name: '动画',
        desc: '二次元',
        children: [{ id: 191, name: 'MAD·AMV', desc: '剪辑' }],
      },
    ],
  },
}

const videos: any[] = [
  {
    key: 1,
    name: '老番茄_2024-06-03T21_00_00.flv',
    updateTime: Date.now() - 3600 * 1000,
    size: 5368709120,
  },
  {
    key: 2,
    name: '影视飓风_聊聊4K_2024-06-03T18_00_00.mp4',
    updateTime: Date.now() - 7200 * 1000,
    size: 2147483648,
  },
]

const qrcodeData = {
  code: 0,
  message: 'ok',
  data: {
    url: 'https://passport.bilibili.com/qrcode/h5/redirect?w_web=1&token=demo_token_123456',
    oauthKey: 'demo_token_123456',
  },
}

// ---------------------------------------------------------------------------
// 工具：构造响应
// ---------------------------------------------------------------------------

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function textResponse(text: string, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': contentType } })
}

function nextId(arr: any[]): number {
  return arr.reduce((m, x) => Math.max(m, x.id ?? 0), 0) + 1
}

// ---------------------------------------------------------------------------
// 路由：根据 path + method 返回模拟响应
// ---------------------------------------------------------------------------

async function route(pathname: string, method: string, body: any, query: URLSearchParams): Promise<Response> {
  // 应用侧 sendRequest/put 传进来的 body 是 JSON 字符串，这里统一解析成对象
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      /* 解析失败则保持原样（一般不会发生） */
    }
  }
  // ---- 写操作（POST / PUT / DELETE）----
  // 直播源
  let m = pathname.match(/^\/v1\/streamers\/(\d+)\/pause$/)
  if (m && method === 'PUT') {
    const id = Number(m[1])
    const s = streamers.find((x) => x.id === id)
    if (s) s.status = s.status === 'Pause' ? 'Idle' : 'Pause'
    return jsonResponse({ success: true, status: s?.status })
  }
  m = pathname.match(/^\/v1\/streamers\/(\d+)$/)
  if (m && method === 'DELETE') {
    const id = Number(m[1])
    streamers = streamers.filter((x) => x.id !== id)
    return jsonResponse({ success: true })
  }
  if (pathname === '/v1/streamers' && method === 'POST') {
    const item = { ...body, id: nextId(streamers) }
    streamers.push(item)
    return jsonResponse(item)
  }
  if (pathname === '/v1/streamers' && method === 'PUT') {
    const item = body
    const idx = streamers.findIndex((x) => x.id === item.id)
    if (idx >= 0) streamers[idx] = { ...streamers[idx], ...item }
    return jsonResponse({ success: true })
  }

  // 用户
  m = pathname.match(/^\/v1\/users\/(\d+)$/)
  if (m && method === 'DELETE') {
    const id = Number(m[1])
    users = users.filter((x) => x.id !== id)
    return jsonResponse({ success: true })
  }
  if (pathname === '/v1/users' && method === 'POST') {
    const item = { ...body, id: nextId(users) }
    users.push(item)
    return jsonResponse(item)
  }

  // 投稿模板
  m = pathname.match(/^\/v1\/upload\/streamers\/(\d+)$/)
  if (m && method === 'DELETE') {
    const id = Number(m[1])
    uploadStreamers = uploadStreamers.filter((x) => x.id !== id)
    return jsonResponse({ success: true })
  }
  if (m && method === 'PUT') {
    const id = Number(m[1])
    const idx = uploadStreamers.findIndex((x) => x.id === id)
    if (idx >= 0) uploadStreamers[idx] = { ...uploadStreamers[idx], ...body }
    return jsonResponse({ success: true })
  }
  if (pathname === '/v1/upload/streamers' && method === 'POST') {
    const item = { ...body, id: nextId(uploadStreamers) }
    uploadStreamers.push(item)
    return jsonResponse(item)
  }

  // 投稿（上传文件）
  if (pathname === '/v1/uploads' && method === 'POST') {
    return jsonResponse({ success: true, task_id: 9001 })
  }

  // 二维码登录
  if (pathname === '/v1/login_by_qrcode' && method === 'POST') {
    return jsonResponse({ code: 0, message: 'ok', data: { filename: 'demo_login_cookie' } })
  }
  if (pathname === '/v1/users/register' && method === 'POST') {
    return jsonResponse({ code: 0, message: 'ok', data: { id: nextId(users) } })
  }
  if (pathname === '/v1/users/login' && method === 'POST') {
    return jsonResponse({ code: 0, message: 'ok', data: { token: 'demo_token' } })
  }

  // 配置
  if (pathname === '/v1/configuration' && method === 'PUT') {
    configuration = { ...configuration, ...body }
    return jsonResponse(configuration)
  }

  // ---- 读操作（GET）----
  if (pathname === '/v1/streamers') return jsonResponse(streamers)
  if (pathname === '/v1/streamer-info') return jsonResponse(streamerInfo)
  if (pathname === '/v1/status') return jsonResponse(statusData)
  if (pathname === '/v1/configuration') return jsonResponse(configuration)
  if (pathname === '/v1/users') return jsonResponse(users)
  if (pathname === '/v1/users/biliup') return jsonResponse({ id: 1, username: 'biliup', name: 'biliup' })
  if (pathname === '/v1/get_qrcode') return jsonResponse(qrcodeData)
  if (pathname === '/v1/upload/streamers') return jsonResponse(uploadStreamers)
  if (pathname === '/v1/videos') return jsonResponse(videos)

  m = pathname.match(/^\/v1\/upload\/streamers\/(\d+)$/)
  if (m) {
    const id = Number(m[1])
    const t = uploadStreamers.find((x) => x.id === id)
    return jsonResponse(t ?? null)
  }
  m = pathname.match(/^\/v1\/streamer-info\/files\/(\d+)$/)
  if (m) {
    const id = Number(m[1])
    return jsonResponse([
      { id: 1, file: `录制_${id}_part1.flv` },
      { id: 2, file: `录制_${id}_part2.flv` },
    ])
  }

  // B 站空间信息（包装结构）
  if (pathname === '/bili/space/myinfo') {
    const user = query.get('user') || ''
    return jsonResponse({
      code: 0,
      message: 'ok',
      data: {
        name: user.includes('老番茄') ? '老番茄' : '演示账号',
        face: 'https://i0.hdslb.com/bfs/face/member/noface.jpg',
      },
    })
  }
  // 分区预取（包装结构）
  if (pathname === '/bili/archive/pre') return jsonResponse(archivePre)

  // 图片代理：离线/部署环境无法拉取外链图片，直接返回一张占位图，
  // 保证用户列表、头像、投稿模板等依赖该接口的流程在 demo 下始终可用。
  if (pathname === '/bili/proxy') {
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const bytes = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  // 静态资源：日志返回示例文本；视频返回 404（播放器会优雅报错，页面不崩）
  if (pathname.startsWith('/static/')) {
    const name = decodeURIComponent(pathname.slice('/static/'.length))
    if (name.endsWith('.log')) {
      return textResponse(
        [
          `[${new Date().toISOString()}] [INFO] biliup 演示站已启动（mock 模式）`,
          `[${new Date().toISOString()}] [INFO] 正在监控 5 个直播间`,
          `[${new Date().toISOString()}] [DOWNLOAD] 开始录制 https://live.bilibili.com/77330`,
          `[${new Date().toISOString()}] [UPLOAD] 投稿任务 #9001 已提交`,
          `[${new Date().toISOString()}] [WARN] 这是演示日志，实时日志需在真实后端中查看`,
        ].join('\n')
      )
    }
    return new Response('Not Found (demo)', { status: 404 })
  }

  // 兜底：未匹配的同源请求返回空对象，避免页面崩溃
  return jsonResponse({}, 200)
}

// ---------------------------------------------------------------------------
// 核心：mock 版 fetch
// ---------------------------------------------------------------------------

export async function mockFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  const method = (init?.method ?? 'GET').toUpperCase()
  const parsed = new URL(url, window.location.origin)
  const query = parsed.searchParams
  return route(parsed.pathname, method, init?.body, query)
}

// ---------------------------------------------------------------------------
// 安装：patch window.fetch（仅在浏览器、且仅安装一次）
// 外部链接（如 raw.githubusercontent.com、i0.hdslb.com）放行走真实网络。
// ---------------------------------------------------------------------------

export function installMockFetch() {
  if (typeof window === 'undefined') return
  const w = window as any
  if (w.__biliupMockInstalled) return
  w.__biliupMockInstalled = true

  const originalFetch = window.fetch.bind(window)

  const isMockable = (url: string): boolean => {
    // 相对路径 → 同源 → 可 mock
    if (url.startsWith('/')) return true
    try {
      const u = new URL(url, window.location.origin)
      return u.origin === window.location.origin
    } catch {
      return false
    }
  }

  // 只 mock API 路径;其他同源请求(如 Next 客户端导航的 RSC fetch:
  // fetch('/streamers', { headers: { RSC: '1' } }))必须放行走真实网络,
  // 否则导航拿到 404/空响应,App Router 会静默放弃导航(点击无反应)。
  const isApiPath = (pathname: string): boolean =>
    pathname === '/v1' ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/bili/') ||
    pathname.startsWith('/static/')

  w.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (isMockable(url)) {
      try {
        const parsed = new URL(url, window.location.origin)
        if (isApiPath(parsed.pathname)) {
          return await mockFetch(url, init)
        }
      } catch (e) {
        // 任何 mock 异常都回退到真实请求，保证页面不崩
        return originalFetch(input, init)
      }
    }
    return originalFetch(input, init)
  }
}

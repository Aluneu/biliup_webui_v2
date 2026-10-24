// ============================================================================
// Mock：概览 / 直播管理
// ----------------------------------------------------------------------------
// 本模块覆盖这些接口（全部直接读写 `db.streamers` / `db.infos` / `db.videos`，
// 所以在这里新建、暂停、恢复、删除会同步反映到概览、直播管理、任务平台）：
//
//   GET    /v1/streamers                        直播列表（裸数组，概览与编辑器都读它）
//   GET    /v1/streamers/page                   分页 + 搜索 + 平台筛选 → {items, infos, total, page, page_size, platforms}
//   POST   /v1/streamers                        新建直播间（补默认字段后返回完整对象）
//   PUT    /v1/streamers                        整行更新（前端把 id 放在 body 里，见 editor / OverrideModal）
//   PUT    /v1/streamers/{id}                   整行更新（按路径 id，兼容用；前端目前走上面那个）
//   DELETE /v1/streamers/{id}                   删除直播间
//   PUT    /v1/streamers/{id}/pause             暂停 / 恢复（toggle：Pause ↔ Idle）
//   GET    /v1/overview                         概览聚合 {total, recording, pending, uploading, streamers, infos, version}
//   GET    /v1/activity-events?limit=12         最近事件（ts 为**毫秒**）
//   GET    /v1/streamer-info                    开播信息（裸数组，时间戳为**秒**）
//   GET    /v1/streamer-info/files/{sessionId}  某一场已写出的分段文件
//
// 封面 / 头像 / 预览流 / CDN 直链 / 抓帧 / 写盘速率在 `./live.ts`；
// 场次、标记、切片、渲染、上传、Fleet、配置分别归其它模块，这里一律不接。
// ============================================================================

import type { MockHandler } from './types'
import { badRequest, json, noContent, notFound } from './util'
import { db, nextId, NOW_SEC, platformOf, STATUS } from './state'
import type { InfoRow, StreamerRow } from './state'

/** 演示站版本号，与 `core.ts` 的 `/v1/status`、`/v1/version` 保持一致 */
const VERSION = 'v1.3.4'

/**
 * 平台筛选按钮的排序偏好：先按这个顺序排，`db` 里出现的其它平台（快手 / AfreecaTV …）
 * 追加在后面。
 * 注意前端 `streamers/page.tsx` 自己会在最前面补一个「全部」再渲染，
 * 这里返回带「全部」会让筛选条出现两个「全部」，所以这里不带。
 */
const PLATFORM_ORDER = ['bilibili', 'douyu', 'huya', 'douyin', 'twitch', 'youtube', 'kuaishou']

/** 新建直播间没填 filename 时的默认模板（与 state.ts 里的示例一致） */
const DEFAULT_FILENAME = '{streamer}%Y-%m-%dT%H_%M_%S'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 请求体归一成对象：非 JSON / 数组 / null 都当空对象处理，避免解构时抛错 */
function asObject(value: any): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

/** 整数查询参数：非法值回落默认值，再夹到 [min, max] */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 列表接口返回浅拷贝：页面上的编辑 / 排序不会顺手改到共享数据 */
function clone(row: StreamerRow): StreamerRow {
  return { ...row }
}

/** 只取当前页这些直播间对应的开播信息（前端按 url 匹配标题与最近开播时间） */
function infosFor(rows: StreamerRow[]): InfoRow[] {
  const urls = new Set(rows.map((r) => r.url))
  return db.infos
    .filter((info) => urls.has(info.url))
    .sort((a, b) => b.date - a.date)
    .map((info) => ({ ...info }))
}

/** 录制态字段由「服务端」维护：前端整行回传时不能把它们覆盖掉 */
function mergeRow(existing: StreamerRow, body: Record<string, any>): StreamerRow {
  const merged: StreamerRow = { ...existing, ...body, id: existing.id }
  merged.status = existing.status
  merged.upload_status = existing.upload_status
  merged.live_bytes_per_sec = existing.live_bytes_per_sec
  merged.live_streamer_name = existing.live_streamer_name
  merged.live_cover_url = existing.live_cover_url
  merged.live_avatar_url = existing.live_avatar_url
  merged.preview = existing.preview
  merged.session_id = existing.session_id
  merged.marker_count = existing.marker_count
  return merged
}

// ---------------------------------------------------------------------------
// 默认事件流：概览右侧「最近事件」时间轴
// ---------------------------------------------------------------------------

interface EventSeed {
  /** 距「现在」多少分钟（数字越小越新） */
  minutesAgo: number
  /** 前端按 kind 上色：含 start 的标绿、含 file 的标文件操作 */
  kind: string
  text: string
  sub: string | null
  session_id: number | null
  /** 关联的直播间 id（临时事件为 null） */
  entity_id: number | null
}

const EVENT_SEEDS: EventSeed[] = [
  { minutesAgo: 2, kind: 'file_written', text: '老番茄 分段 part_2.flv 已写完', sub: '2.0 GB · 用时 18 分钟', session_id: 5001, entity_id: 1 },
  { minutesAgo: 5, kind: 'marker_added', text: '场次 5001 生成 3 个标记', sub: '自动切片候选已就绪', session_id: 5001, entity_id: 1 },
  { minutesAgo: 8, kind: 'render_done', text: '压制任务 #9003 完成', sub: '弹幕 + 画面遮挡 · 用时 4 分 12 秒', session_id: 5002, entity_id: 2 },
  { minutesAgo: 12, kind: 'upload_submit', text: '投稿任务 #9001 已提交', sub: '老番茄 今晚通宵打星际 直播回放', session_id: 5001, entity_id: 1 },
  { minutesAgo: 16, kind: 'clip_ready', text: '切片「全员掉线名场面」已导出', sub: '场次 5001 · 00:45', session_id: 5001, entity_id: 1 },
  { minutesAgo: 19, kind: 'upload_failed', text: '午夜琴房 投稿失败', sub: '-104 账号未登录，已进入重试队列', session_id: 5003, entity_id: 6 },
  { minutesAgo: 24, kind: 'danmaku_written', text: '弹幕已写入 老番茄 的 XML', sub: '12 846 条 · 实时录制中', session_id: 5001, entity_id: 1 },
  { minutesAgo: 27, kind: 'record_start', text: '午夜琴房 开始录制', sub: '深夜钢琴即兴 · 点歌请打在弹幕里', session_id: 5003, entity_id: 6 },
  { minutesAgo: 31, kind: 'marker_added', text: '场次 5004 生成 2 个标记', sub: '手动标记 · 猫猫台', session_id: 5004, entity_id: 8 },
  { minutesAgo: 38, kind: 'upload_start', text: '影视飓风 开始上传 3 个分段', sub: '边录边传 · 12.4 MB/s', session_id: 5002, entity_id: 2 },
  { minutesAgo: 44, kind: 'record_start', text: '猫猫台 开始录制', sub: 'rank 冲分 · Twitch', session_id: 5004, entity_id: 8 },
  { minutesAgo: 52, kind: 'record_start', text: '老番茄 开始录制', sub: '【实况】今晚通宵打星际，来就完了', session_id: 5001, entity_id: 1 },
  { minutesAgo: 101, kind: 'record_start', text: '影视飓风 开始录制', sub: '聊聊我们是怎么拍 4K 视频的（含设备清单）', session_id: 5002, entity_id: 2 },
]

/** `ts` 用毫秒（`use-dashboard.ts` 的 DashboardEvent 约定），按时间倒序 */
function activityEvents(limit: number) {
  const nowMs = NOW_SEC * 1000
  const all = [...EVENT_SEEDS]
    .sort((a, b) => a.minutesAgo - b.minutesAgo)
    .map((seed, index) => ({
      id: `ev_${index + 1}`,
      ts: nowMs - seed.minutesAgo * 60_000,
      kind: seed.kind,
      text: seed.text,
      sub: seed.sub,
      session_id: seed.session_id,
      entity_id: seed.entity_id,
    }))
  return all.slice(0, limit)
}

// ---------------------------------------------------------------------------
// 处理链
// ---------------------------------------------------------------------------

export const streamerHandlers: MockHandler[] = [
  // 直播列表：原样返回裸数组（概览、编辑页、Fleet 配对面板都读它）
  (ctx) => (ctx.method === 'GET' && ctx.path === '/v1/streamers' ? json(db.streamers.map(clone)) : undefined),

  // 直播管理页：分页 + 搜索（remark / url）+ 平台筛选
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/streamers/page') return undefined
    const pageSize = intParam(ctx.query.get('page_size'), 24, 1, 200)
    const requestedPage = intParam(ctx.query.get('page'), 1, 1, 100_000)
    const search = (ctx.query.get('search') ?? '').trim().toLowerCase()
    const platform = (ctx.query.get('platform') ?? '').trim()

    let rows = db.streamers
    if (search) {
      rows = rows.filter(
        (s) =>
          (s.remark ?? '').toLowerCase().includes(search) || (s.url ?? '').toLowerCase().includes(search)
      )
    }
    if (platform && platform !== '全部') {
      rows = rows.filter((s) => platformOf(s.url) === platform)
    }

    const total = rows.length
    // 删掉最后一页的最后几行时向后端要的页码会越界，这里按实际页数收敛（前端拿到 page 后会自己纠正）
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(requestedPage, lastPage)
    const start = (page - 1) * pageSize
    const items = rows.slice(start, start + pageSize).map(clone)
    // 平台筛选按钮：按偏好顺序列出真实存在的平台，偏好表里没有的（快手、AfreecaTV…）追加在后
    const present = Array.from(new Set(db.streamers.map((s) => platformOf(s.url))))
    const platforms = [
      ...PLATFORM_ORDER.filter((p) => present.includes(p)),
      ...present.filter((p) => !PLATFORM_ORDER.includes(p)).sort(),
    ]

    return json({ items, infos: infosFor(items), total, page, page_size: pageSize, platforms })
  },

  // 概览：一次给全，页面拿它渲染概览条、进行中卡片与最近开播信息
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/overview') return undefined
    const rows = db.streamers
    return json({
      total: rows.length,
      recording: rows.filter((s) => s.status === STATUS.working).length,
      pending: rows.filter((s) => s.upload_status === 'Pending').length,
      uploading: rows.filter((s) => s.upload_status === 'Working').length,
      streamers: rows.map(clone),
      infos: db.infos.map((info) => ({ ...info })).sort((a, b) => b.date - a.date),
      version: VERSION,
    })
  },

  // 最近事件时间轴；limit 默认 12，最多 50 条
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/activity-events') return undefined
    const limit = intParam(ctx.query.get('limit'), 12, 1, 50)
    return json({ events: activityEvents(limit) })
  },

  // 开播信息：裸数组，date 为 Unix 秒
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/streamer-info') return undefined
    return json(db.infos.map((info) => ({ ...info })).sort((a, b) => b.date - a.date))
  },

  // 某一场的分段文件（任务平台 › 场次回看用），按时间轴顺序
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamer-info\/files\/(\d+)$/)
    if (ctx.method !== 'GET' || !match) return undefined
    const sessionId = Number(match[1])
    const files = db.videos
      .filter((v) => v.session_id === sessionId)
      .sort((a, b) => (a.segment_start_ms ?? 0) - (b.segment_start_ms ?? 0))
      .map((v) => ({ id: v.key, file: v.name, size: v.size, updateTime: v.updateTime }))
    return json(files)
  },

  // 新建直播间：补默认字段（Idle / 空上传态 / 无预览 / 无场次），返回完整对象
  (ctx) => {
    if (ctx.method !== 'POST' || ctx.path !== '/v1/streamers') return undefined
    const body = asObject(ctx.body)
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) return badRequest('缺少直播地址 url')
    const row: StreamerRow = {
      format: 'flv',
      time_range: '',
      split_time: 0,
      split_size: 0,
      upload_streamers_id: null,
      ...body,
      id: nextId(db.streamers),
      url,
      remark: typeof body.remark === 'string' ? body.remark : '',
      filename: typeof body.filename === 'string' && body.filename ? body.filename : DEFAULT_FILENAME,
      // 新建的房间一定从「未开播」开始，录制态字段不接受前端传入
      status: STATUS.idle,
      upload_status: '',
      live_bytes_per_sec: null,
      live_streamer_name: null,
      live_cover_url: null,
      live_avatar_url: null,
      preview: null,
      session_id: null,
      marker_count: null,
    }
    db.streamers.push(row)
    return json(row, 201)
  },

  // 整行更新：前端（直播管理卡片 / 编辑页 / 画面遮挡面板）把 id 放在 body 里
  (ctx) => {
    if (ctx.method !== 'PUT' || ctx.path !== '/v1/streamers') return undefined
    const body = asObject(ctx.body)
    const id = Number(body.id)
    if (!Number.isFinite(id)) return badRequest('缺少直播间 id')
    const existing = db.streamers.find((s) => s.id === id)
    if (!existing) return notFound('直播间不存在或已被删除')
    Object.assign(existing, mergeRow(existing, body))
    return json({ ...existing })
  },

  // 整行更新（按路径 id）：前端目前不用，留给直接调接口的场景
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)$/)
    if (ctx.method !== 'PUT' || !match) return undefined
    const id = Number(match[1])
    const existing = db.streamers.find((s) => s.id === id)
    if (!existing) return notFound('直播间不存在或已被删除')
    Object.assign(existing, mergeRow(existing, asObject(ctx.body)))
    return json({ ...existing })
  },

  // 暂停 / 恢复：后端的 PUT /pause 是 toggle——Pause 恢复成 Idle，其余一律转 Pause
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)\/pause$/)
    if (ctx.method !== 'PUT' || !match) return undefined
    const room = db.streamers.find((s) => s.id === Number(match[1]))
    if (!room) return notFound('直播间不存在或已被删除')
    room.status = room.status === STATUS.pause ? STATUS.idle : STATUS.pause
    // 暂停后不再有实时数据；「恢复监控」从 Idle 重新检测开播，由真实后端接管，演示站不补假速率
    if (room.status === STATUS.pause) {
      room.live_bytes_per_sec = null
      room.live_streamer_name = null
      room.preview = null
    }
    return json({ ...room })
  },

  // 删除直播间：直接从共享数据里摘掉，概览 / 直播管理 / 任务平台立刻少一行
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)$/)
    if (ctx.method !== 'DELETE' || !match) return undefined
    const id = Number(match[1])
    const index = db.streamers.findIndex((s) => s.id === id)
    if (index < 0) return notFound('直播间不存在或已被删除')
    db.streamers.splice(index, 1)
    return noContent()
  },
]

// ============================================================================
// Mock：直播预览（封面 / 头像 / 抓帧 / 预览流 / CDN 直链 / 写盘速率 / 释放连接）
// ----------------------------------------------------------------------------
// 覆盖的接口：
//
//   GET    /v1/streamers/{id}/cover         直播间封面（SVG 占位图，同源）
//   GET    /v1/streamers/{id}/avatar        主播头像（SVG 占位图，同源）
//   GET    /v1/streamers/{id}/mosaic-frame  画面遮挡面板的截帧（预生成的 JPEG）
//   GET    /v1/streamers/{id}/live-url      浏览器直连模式要的 CDN 直链
//   GET    /v1/streamers/{id}/live          中转预览流（chunked FLV / TS / fMP4）
//   DELETE /v1/streamers/{id}/live?conn=…   播放器销毁时释放这一条中转预览
//   POST   /v1/streamers/{id}/live?conn=…   关标签页时 sendBeacon 释放（同上的兜底）
//   GET    /v1/live-rates?session=…         写盘速率轮询（WebSocket 不可用时的回退）
//
// 直播弹幕的 SSE `/v1/danmaku` 由 `./sockets.ts` 用假 EventSource 接管，这里不实现。
//
// 关于「预览流返回 503」：演示站没有任何真实视频流（没有后端在拉流、写盘、转封装），
// 所以 `GET …/live` 统一返回 503 + 一段中文说明，播放器 mpegts.js 拿不到媒体数据，
// 会显示「录制尚未开始拉流或正在重连」的错误态并自动重连 3 次后回到 ended，页面不崩。
// 想看真实画面需要连真实 biliup 后端。
//
// 关于「抓帧」：真实的 mosaic-frame 返回 JPEG，`MosaicEditor` 也只接受 image/jpeg，
// 所以这里返回 scripts/gen-mosaic-frame.py 预生成的一张 960×540 JPEG 静态帧
// （base64 内联在 ./mosaic-frame-data.ts，约 20 KB），遮挡区域编辑器可以直接拖拽。

// ============================================================================

import type { MockHandler } from './types'
import { avatarSvg, coverSvg, jpeg, json, noContent, notFound, text } from './util'
import { MOSAIC_FRAME_JPEG_BASE64 } from './mosaic-frame-data'
import { db, findStreamer, NOW_SEC, platformOf, STATUS } from './state'
import type { StreamerRow } from './state'

/** 预览连接的路径：`/v1/streamers/{id}/live`（可带 session / conn / snapshot_ms / reconnect 查询） */
const LIVE_PATH = /^\/v1\/streamers\/(\d+)\/live$/

/** 房间展示名：平台给的主播名优先，其次录播备注，最后退回 URL */
function displayName(room: StreamerRow): string {
  return (room.live_streamer_name || room.remark || room.url || '直播间').trim()
}

function isLive(room: StreamerRow): boolean {
  return room.status === STATUS.working
}

/** 转义 XML 文本，避免主播名或标题里的 & < > 破坏内联 SVG */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** Unix 秒 → `2026-10-24 14:05:09`（本地时区，只在浏览器里跑） */
function stamp(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}


/** 直链里的容器：fMP4 分片按 HLS 播放，其余都当 FLV */
function directFormat(room: StreamerRow): 'flv' | 'hls' | null {
  const format = room.preview?.format ?? null
  if (format === 'fmp4') return 'hls'
  if (format === 'flv') return 'flv'
  if (format === 'mpegts') return 'flv'
  return null
}

/** 写盘速率：与 `sockets.ts` 的 WebSocket 帧同一套抖动，曲线看起来是活的又不会跳变 */
function jitterRate(base: number, id: number, sec: number): number {
  const wave = Math.sin((sec + id * 7) / 5) * 0.06 + Math.cos((sec + id * 3) / 11) * 0.03
  return Math.max(0, Math.round(base * (1 + wave)))
}

export const liveHandlers: MockHandler[] = [
  // 直播间封面（录制中带 LIVE 角标）；未识别到房间时 404，卡片会隐藏封面而不是显示裂图
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)\/cover$/)
    if (ctx.method !== 'GET' || !match) return undefined
    const room = findStreamer(Number(match[1]))
    if (!room) return notFound('找不到这个直播间')
    return coverSvg(displayName(room), room.id, isLive(room))
  },

  // 主播头像（首字 + 渐变圆）
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)\/avatar$/)
    if (ctx.method !== 'GET' || !match) return undefined
    const room = findStreamer(Number(match[1]))
    if (!room) return notFound('找不到这个主播')
    return avatarSvg(displayName(room), room.id)
  },

  // 画面遮挡面板的截帧：返回真实的 JPEG（编辑器只接受 image/jpeg）。
  // 演示站没有真实流，用 scripts/gen-mosaic-frame.py 预生成的一张 960×540 静态帧代替。
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)\/mosaic-frame$/)
    if (ctx.method !== 'GET' || !match) return undefined
    const room = findStreamer(Number(match[1]))
    if (!room) return notFound('找不到这个直播间')
    return jpeg(MOSAIC_FRAME_JPEG_BASE64)
  },

  // 浏览器直连模式：给一条「直链」。演示站没有 CDN，房间不能直连时如实返回原因，
  // 前端会据此回落到中转并在角标上写原因，而不是静默失败
  (ctx) => {
    const match = ctx.path.match(/^\/v1\/streamers\/(\d+)\/live-url$/)
    if (ctx.method !== 'GET' || !match) return undefined
    const room = findStreamer(Number(match[1]))
    if (!room) return notFound('找不到这个直播间')

    const format = directFormat(room)
    const direct = room.preview?.direct ?? null
    const capable = isLive(room) && !!format && !!direct?.capable
    const reason = !isLive(room)
      ? '当前直播间未在录制，没有可用的 CDN 直链'
      : direct && !direct.capable && direct.reason
        ? direct.reason
        : !format
          ? '容器尚未确定，暂时没有可用的 CDN 直链'
          : direct
            ? null
            : '当前下载器没有提供直连能力'
    // 直链域名用 .invalid（保留域名，永远解析不到）：演示站不向真实 CDN 发请求
    const url = capable ? `https://cdn.demo.invalid/biliup/${platformOf(room.url)}/room-${room.id}.${format === 'hls' ? 'm3u8' : 'flv'}` : ''

    return json({
      url,
      format,
      platform: platformOf(room.url),
      // 过期时间是 Unix 秒；演示站给一小时后
      expires_at: capable ? NOW_SEC + 3600 : null,
      direct: { capable, reason: capable ? null : reason },
      cached: false,
    })
  },

  // 中转预览流：演示站没有真实视频流，返回 503 文本（播放器显示错误态，页面不崩）
  (ctx) => {
    const match = ctx.path.match(LIVE_PATH)
    if (!match) return undefined
    const id = Number(match[1])

    // 释放连接：播放器销毁时 DELETE，关标签页时 sendBeacon 发 POST；已经结束的也回 204
    if (ctx.method === 'DELETE' || ctx.method === 'POST') return noContent()
    if (ctx.method !== 'GET') return undefined

    const room = findStreamer(id)
    if (!room) return notFound('找不到这个直播间')
    if (!isLive(room)) return text('当前直播间没有在录制，预览流不可用（演示站也没有真实视频流）。', 503)
    if (!room.preview?.available) {
      return text(`当前下载器不能旁路预览：${room.preview?.reason ?? '不支持预览'}。演示站也没有真实视频流。`, 503)
    }
    return text('演示站没有真实视频流：这里只有界面与交互，预览流请连接真实 biliup 后端。', 503)
  },

  // 写盘速率轮询兜底：与 /v1/ws/live-rates 推送的帧结构完全一致（ts 为 Unix 秒）
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/live-rates') return undefined
    const sec = Math.floor(Date.now() / 1000)
    const frames = db.streamers
      .filter((s) => s.status === STATUS.working)
      .map((s) => ({
        id: s.id,
        bytes_per_sec: jitterRate(typeof s.live_bytes_per_sec === 'number' ? s.live_bytes_per_sec : 3_000_000, s.id, sec),
        ts: sec,
      }))
    return json(frames)
  },
]

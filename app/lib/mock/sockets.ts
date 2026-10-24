// ============================================================================
// Mock：WebSocket / SSE 假连接
// ----------------------------------------------------------------------------
// 演示站没有后端，实时日志（/v1/ws/logs）、写盘速率（/v1/ws/live-rates）、
// 直播弹幕（SSE /v1/danmaku）都要自己造。这里替换全局 WebSocket / EventSource，
// 按 URL 定时推送假数据，让「实时日志」「直播预览」「速率曲线」都动起来。
// ============================================================================

import { db } from './state'
import { NOW_SEC } from './state'

const LOG_TEMPLATES = [
  '[{ts}] [INFO] 直播流检测完成，共 {n} 个房间在监控中',
  '[{ts}] [DOWNLOAD] 开始录制 {url}（{name}）',
  '[{ts}] [DOWNLOAD] {name} 已写入 {size}，当前码率 {rate}',
  '[{ts}] [UPLOAD] 分段 {seg} 上传完成，用时 {ms} ms',
  '[{ts}] [UPLOAD] 投稿任务 #{job} 已提交，标题：{title}',
  '[{ts}] [INFO] 场次 {session} 生成标记 {count} 个，剪辑台可回看',
  '[{ts}] [RENDER] 压制任务 #{job} 开始合成（弹幕 + 画面遮挡）',
  '[{ts}] [WARN] {name} 的直链将在 5 分钟后过期，正在刷新',
  '[{ts}] [INFO] 弹幕已写入 {name} 的 XML（{count} 条）',
  '[{ts}] [INFO] 斗鱼 Cookie 续期成功，下次检查 3 天后',
]

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function logLine(index: number): string {
  const working = db.streamers.filter((s) => s.status === 'Working')
  const pick = working[index % Math.max(1, working.length)]
  const tpl = LOG_TEMPLATES[index % LOG_TEMPLATES.length]
  return tpl
    .replace('{ts}', ts())
    .replace('{n}', String(db.streamers.length))
    .replace('{url}', pick?.url ?? 'https://live.bilibili.com/77330')
    .replace('{name}', pick?.remark ?? '老番茄')
    .replace('{size}', `${(index * 137 + 512) % 4096} MB`)
    .replace('{rate}', `${(3 + (index % 5))}.${index % 10} MB/s`)
    .replace('{seg}', `part_${(index % 12) + 1}.flv`)
    .replace('{ms}', String(1200 + ((index * 37) % 900)))
    .replace('{job}', String(9000 + (index % 60)))
    .replace('{title}', '老番茄 今晚通宵打星际 直播回放')
    .replace('{session}', String(5001 + (index % 4)))
    .replace('{count}', String(8 + (index % 40)))
}

const DANMAKU_TEXTS = [
  '来了来了',
  '这个操作可以的',
  '主播今天状态不错',
  '哈哈哈这也行',
  'BGM 是什么名字',
  '666',
  '刚下班，蹲一个',
  '前面的让让，我要看第一视角',
  '这波啊，这波是节目效果',
  '高清画质真香',
]

const GIFT_TEXTS = ['送出了 辣条 ×10', '送出了 小心心 ×5', '送出了 小花花 ×1', '送出了 摩天轮 ×1']
const NAMES = ['观众A', '路过的猫', '夜猫子', '阿七', '小满', '咸鱼一条', '夜航船']

function pickName(seed: number): string {
  return NAMES[seed % NAMES.length]
}

/** 假的 WebSocket：按 URL 定时推送，语义与真连接一致（onopen / onmessage / close） */
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((ev?: any) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev?: any) => void) | null = null
  onclose: ((ev?: any) => void) | null = null

  private url: string
  private timer: ReturnType<typeof setInterval> | null = null
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private count = 0

  constructor(url: string) {
    this.url = url
    this.openTimer = setTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.({})
      this.start()
    }, 30)
  }

  private start() {
    const path = safePath(this.url)

    if (path.startsWith('/v1/ws/logs')) {
      // 首屏先灌 12 行历史，再逐行追加
      for (let i = 0; i < 12; i++) this.message(logLine(i))
      this.count = 12
      this.timer = setInterval(() => this.message(logLine(this.count++)), 900)
      return
    }

    if (path.startsWith('/v1/ws/live-rates')) {
      this.timer = setInterval(() => {
        const frames = db.streamers
          .filter((s) => s.status === 'Working')
          .map((s) => ({
            id: s.id,
            bytes_per_sec: jitter(s.live_bytes_per_sec ?? 3_000_000, this.count),
            ts: Math.floor(Date.now() / 1000),
          }))
        this.message(JSON.stringify(frames))
        this.count++
      }, 1000)
      return
    }

    // 其它通道：保持打开，不推送内容
  }

  private message(data: string) {
    this.onmessage?.({ data })
  }

  send() {
    /* 演示站忽略上行消息（如预览租约） */
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    if (this.openTimer) clearTimeout(this.openTimer)
    this.timer = null
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({})
  }

  addEventListener() {
    /* 前端只用 on* 回调，这里留空以兼容 */
  }

  removeEventListener() {
    /* 同上 */
  }
}

/** 假的 EventSource：直播弹幕（/v1/danmaku?ids=1,2） */
class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

  readyState = MockEventSource.CONNECTING
  onopen: ((ev?: any) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev?: any) => void) | null = null

  private url: string
  private listeners = new Map<string, Set<(ev: { data: string }) => void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private count = 0

  constructor(url: string) {
    this.url = url
    this.openTimer = setTimeout(() => {
      this.readyState = MockEventSource.OPEN
      this.onopen?.({})
      this.start()
    }, 30)
  }

  private start() {
    const ids = this.ids()
    if (ids.length === 0) return
    this.timer = setInterval(() => {
      const id = ids[this.count % ids.length]
      const n = this.count++
      const roll = n % 11
      if (roll === 5) {
        this.emit('gift', { id, kind: 'gift', text: GIFT_TEXTS[n % GIFT_TEXTS.length], name: pickName(n + 3), color: 16766720, ts: Date.now() })
      } else if (roll === 9) {
        this.emit('super_chat', { id, kind: 'super_chat', text: '这个直播间氛围真好，支持一下！', name: pickName(n + 5), color: 16777215, ts: Date.now() })
      } else {
        this.emit('danmaku', {
          id,
          kind: 'danmaku',
          text: DANMAKU_TEXTS[n % DANMAKU_TEXTS.length],
          name: pickName(n),
          color: n % 7 === 0 ? 16744192 : 16777215,
          ts: Date.now(),
        })
      }
    }, 1400)
  }

  private ids(): number[] {
    const m = this.url.match(/ids=([^&]+)/)
    if (!m) return db.streamers.filter((s) => s.status === 'Working').map((s) => s.id)
    return decodeURIComponent(m[1])
      .split(',')
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
  }

  private emit(kind: string, frame: any) {
    const payload = { data: JSON.stringify(frame) }
    if (kind === 'message') this.onmessage?.(payload)
    this.listeners.get(kind)?.forEach((fn) => fn(payload))
  }

  addEventListener(kind: string, fn: (ev: { data: string }) => void) {
    let set = this.listeners.get(kind)
    if (!set) {
      set = new Set()
      this.listeners.set(kind, set)
    }
    set.add(fn)
  }

  removeEventListener(kind: string, fn: (ev: { data: string }) => void) {
    this.listeners.get(kind)?.delete(fn)
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    if (this.openTimer) clearTimeout(this.openTimer)
    this.timer = null
    this.readyState = MockEventSource.CLOSED
    this.onerror?.({})
  }
}

function safePath(raw: string): string {
  try {
    return new URL(raw, window.location.origin).pathname
  } catch {
    return raw
  }
}

/** 在基准值上抖动 ±8%，让速率曲线看起来是活的 */
function jitter(base: number, n: number): number {
  const wave = Math.sin(n / 3) * 0.05 + Math.cos(n / 7) * 0.03
  return Math.max(0, Math.round(base * (1 + wave)))
}

let installed = false

export function installMockSockets() {
  if (typeof window === 'undefined' || installed) return
  installed = true
  const w = window as any
  w.WebSocket = MockWebSocket as any
  w.EventSource = MockEventSource as any
}

export { NOW_SEC }

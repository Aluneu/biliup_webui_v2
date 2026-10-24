// ============================================================================
// Mock：系统状态（CPU / 内存 / 磁盘 / 网络）
// ----------------------------------------------------------------------------
// 覆盖 `GET /v1/system-stats[?since=]`。概览页的「系统状态」面板与节点卡片都用它，
// 每 2 秒轮询一次；这里按同样节奏补齐采样点，曲线看起来是活的。
// ============================================================================

import type { MockHandler } from './types'
import { json } from './util'

/** 与后端 SAMPLE_INTERVAL 一致 */
const INTERVAL_MS = 2000
/** 保留 2 分钟历史，够画一条像样的曲线 */
const HISTORY_MS = 120_000
const MAX_POINTS = Math.floor(HISTORY_MS / INTERVAL_MS)

interface Sample {
  ts: number
  cpu: number
  rx: number
  tx: number
  disk_read_bytes_per_sec: number | null
  disk_write_bytes_per_sec: number | null
}

/** 波形：三个不同周期的正弦叠加，像真实负载而不是随机噪声 */
function wave(t: number, base: number, amplitude: number, phase = 0): number {
  const s = Math.sin(t / 23 + phase) * 0.6 + Math.sin(t / 7 + phase * 2) * 0.3 + Math.sin(t / 3.1) * 0.1
  return Math.max(0, base + s * amplitude)
}

function sampleAt(ts: number): Sample {
  const t = ts / INTERVAL_MS
  return {
    ts,
    cpu: Math.round(wave(t, 34, 26) * 10) / 10,
    rx: Math.round(wave(t + 5, 9.2 * 1024 * 1024, 5.4 * 1024 * 1024)),
    tx: Math.round(wave(t + 11, 1.6 * 1024 * 1024, 0.9 * 1024 * 1024)),
    disk_read_bytes_per_sec: Math.round(wave(t + 17, 0.4 * 1024 * 1024, 0.3 * 1024 * 1024)),
    disk_write_bytes_per_sec: Math.round(wave(t + 29, 12.4 * 1024 * 1024, 6.1 * 1024 * 1024)),
  }
}

/** 模块级历史：第一次请求时补满 2 分钟，之后每次只补到「现在」 */
const samples: Sample[] = []
let lastTs = 0

function advance(): void {
  const now = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
  if (lastTs === 0) {
    for (let i = MAX_POINTS - 1; i >= 0; i--) samples.push(sampleAt(now - i * INTERVAL_MS))
    lastTs = now
    return
  }
  for (let ts = lastTs + INTERVAL_MS; ts <= now; ts += INTERVAL_MS) {
    samples.push(sampleAt(ts))
  }
  lastTs = now
  while (samples.length > MAX_POINTS) samples.shift()
}

export const statsHandlers: MockHandler[] = [
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/system-stats') return undefined
    advance()
    const since = Number(ctx.query.get('since'))
    const points = Number.isFinite(since) && since > 0 ? samples.filter((s) => s.ts > since) : samples.slice()
    const totalMem = 16 * 1024 * 1024 * 1024
    const totalDisk = 512 * 1024 * 1024 * 1024
    const usedDisk = Math.round(totalDisk * 0.412)
    return json({
      ts: lastTs,
      interval_ms: INTERVAL_MS,
      history_ms: HISTORY_MS,
      cpu: { logical: 8, physical: 4 },
      memory: { used: Math.round(totalMem * 0.58), total: totalMem, limited: false },
      disk: {
        path: '/opt/biliup/data',
        total: totalDisk,
        used: usedDisk,
        available: totalDisk - usedDisk,
      },
      interfaces: ['eth0'],
      samples: points,
    })
  },
]

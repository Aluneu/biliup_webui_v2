// ============================================================================
// Mock：剪辑台 / 回放 / 切片 / 标记 / 合并场次 / 自动切片 / 回看素材
// ----------------------------------------------------------------------------
// 本模块覆盖的接口（全部在浏览器里由 mock 层拦截，读写内存数据）：
//
//   场次
//     GET    /v1/sessions                                   分页列表（page / page_size / include_sources / streamer_id）
//     GET    /v1/sessions/{id}                              详情（segments / gaps / members 都在这里）
//     DELETE /v1/sessions/{id}                              删除场次历史
//   切片
//     GET    /v1/sessions/{id}/clips                        本场切片
//     POST   /v1/sessions/{id}/clips                        建切片（回看选段 / 直播「剪下刚才」）
//     PATCH  /v1/sessions/{id}/clips/{cid}                  改入出点 / 标题 / 模板 / 发布覆盖
//     DELETE /v1/sessions/{id}/clips/{cid}
//     GET    /v1/clips/{id}                                 单个切片（导出中轮询）
//     POST   /v1/clips/{id}/export                          开始导出
//     HEAD   /v1/clips/{id}/download                        下载探测（演示站 404）
//     GET    /v1/clips/{id}/download                        下载（演示站 404）
//     PUT    /v1/clips/{id}/cover                           封面：{t} 取帧 / {live:true} 直播封面 / 上传图片
//     DELETE /v1/clips/{id}/cover
//     GET    /v1/clips/{id}/cover                           取封面图
//   标记
//     GET    /v1/sessions/{id}/markers
//     POST   /v1/sessions/{id}/markers                      直播打点 / 回看定位
//     PATCH  /v1/sessions/{id}/markers/{mid}
//     DELETE /v1/sessions/{id}/markers/{mid}
//   合并场次 / 停录续接
//     GET    /v1/session-merge-candidates
//     POST   /v1/session-groups
//     POST   /v1/session-merge-candidates/{id}/confirm
//     POST   /v1/session-merge-candidates/{id}/dismiss
//   自动切片
//     GET    /v1/auto-clip/status
//     GET    /v1/auto-clip/jobs?session_ids=
//     GET    /v1/sessions/{id}/auto-clip
//     POST   /v1/sessions/{id}/auto-clip                    只给 reuse_transcript = 预估；confirm:true = 入队
//     DELETE /v1/sessions/{id}/auto-clip
//     GET    /v1/sessions/{id}/suggestions
//     POST   /v1/sessions/{id}/suggestions/{sid}/accept
//     POST   /v1/sessions/{id}/suggestions/{sid}/dismiss
//     POST   /v1/auto-clip/test
//   回看素材
//     GET    /v1/sessions/{id}/keyframes                    关键帧（落刀点）
//     GET    /v1/sessions/{id}/thumb                        缩图（SVG 占位）
//     GET    /v1/sessions/{id}/media                        DVR 回看流（演示站 415，播放器显示错误态）
//     GET    /v1/sessions/{id}/render-recipe                压制配方
//     PUT    /v1/sessions/{id}/render-recipe
//     GET    /v1/sessions/{id}/render-settings              压制配方（旧路径别名）
//     PUT    /v1/sessions/{id}/render-settings
//     GET    /v1/sessions/{id}/render-assets
//     POST   /v1/sessions/{id}/render-assets
//     GET    /v1/render-assets/{id}
//     DELETE /v1/render-assets/{id}
//     GET    /v1/tools                                      ffmpeg 可用性
//
// 约定：所有时间戳都是**毫秒**；正在录制的场次以 `NOW_SEC`（state.ts）锚定起点，
// 时长随真实时间往前走，所以列表里的「录制中」场次会一直变长。
// ============================================================================

import type { MockHandler } from './types'
import {
  json,
  noContent,
  notFound,
  badRequest,
  text,
  coverSvg,
  uploadedAssetSvg,
  seededInt,
  idOf,
} from './util'
import { db, NOW_SEC, nextId, findStreamer } from './state'
import type {
  SessionSummary,
  SessionDetail,
  SegmentView,
  Gap,
  SessionMember,
  SessionMergeCandidate,
  Keyframe,
} from '../sessions'
import type { Clip, ClipMode, ClipState } from '../clips'
import type { Marker } from '../markers'
import type { AutoClipEstimate, AutoClipJob, AutoClipStatus, Suggestion } from '../auto-clip'
import type { RenderAsset, RenderRecipe } from '../renders'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** 与 state.ts 的 `NOW_SEC` 对齐（毫秒） */
const NOW_MS = NOW_SEC * 1000
/** 录制中的场次按真实时间增长；页面打开很久也不会停在过去 */
const liveNow = () => (Date.now() > NOW_MS ? Date.now() : NOW_MS)

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 文件名里的时间戳：`2026-10-24T05_12_00` */
function stamp(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}_${pad2(d.getMinutes())}_${pad2(d.getSeconds())}`
}

/** `01:23:45` */
function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`
}

function genName(streamer: string, atMs: number, ext: string): string {
  return `${streamer}_${stamp(atMs)}.${ext}`
}

/** db.videos 里已有的分段文件名（5001~5004 都有），按顺序取 */
function videoNameOf(sessionId: number, index: number): string {
  const rows = db.videos.filter((v) => v.session_id === sessionId)
  return rows[index]?.name ?? ''
}

function esc(s: string): string {
  const table: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return s.replace(/[&<>"']/g, (c) => table[c])
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// 场次数据
// ---------------------------------------------------------------------------

/**
 * 内存里的场次：`segment_count` / `bytes` 不在数据里存，序列化时按 `segments` 现算，
 * 免得增删分段之后两个数字对不上。所以这里用 `Omit` 把这两项摘掉。
 */
type SessionRow = Omit<SessionSummary, 'segment_count' | 'bytes'> & {
  segments: SegmentView[]
  gaps: Gap[]
  members?: SessionMember[]
}

interface SegmentInput {
  start: number
  /** null = 还在写 */
  end: number | null
  state?: SegmentView['state']
  bytes?: number | null
  container?: SegmentView['container']
  fileName?: string
  hasDanmaku?: boolean
  gapBefore?: number
}

let segmentSeq = 9001
let clipSeq = 7801
let markerSeq = 3401
let assetSeq = 8801

function makeSegments(
  sourceSessionId: number,
  streamerName: string,
  startedAt: number,
  inputs: SegmentInput[],
): SegmentView[] {
  return inputs.map((input) => {
    const container: SegmentView['container'] = input.container ?? 'flv'
    const ext = container === 'ts' ? 'ts' : container === 'mp4' ? 'mp4' : 'flv'
    return {
      id: segmentSeq++,
      source_session_id: sourceSessionId,
      container,
      state: input.state ?? (input.end === null ? 'recording' : 'finished'),
      start_ms: input.start,
      end_ms: input.end,
      bytes: input.bytes ?? null,
      gap_before_ms: input.gapBefore ?? 0,
      file_name:
        input.fileName && input.fileName.length > 0
          ? input.fileName
          : genName(streamerName, startedAt + input.start, ext),
      has_danmaku: input.hasDanmaku !== false,
    }
  })
}

const LIVE_5001 = NOW_MS - 190 * MIN
const LIVE_5002 = NOW_MS - 115 * MIN
const LIVE_5003 = NOW_MS - 17 * MIN
const LIVE_5004 = NOW_MS - 135 * MIN

const sessions: SessionRow[] = []

/** 写完了（含等待清理，文件还在盘上）的分段字节数，列表里的「录像大小」 */
function writtenBytes(row: SessionRow): number {
  return row.segments.reduce(
    (sum, s) => sum + (s.state === 'finished' || s.state === 'pending_delete' ? (s.bytes ?? 0) : 0),
    0,
  )
}

/** 录制中的场次用「当前时间 − 开始时间」，并至少覆盖已写完分段的末尾 */
function durationOf(row: SessionRow): number {
  if (!row.recording) return row.duration_ms
  const segmentEnd = row.segments.reduce((max, s) => Math.max(max, s.end_ms ?? s.start_ms), 0)
  return Math.max(liveNow() - row.started_at, segmentEnd)
}

// —— 正在录制的四个场次：id 与 db.streamers[].session_id 一致 ——

sessions.push({
  id: 5001,
  kind: 'source',
  group_session_id: null,
  streamer_id: 1,
  streamer_name: '老番茄',
  title: '【实况】今晚通宵打星际，来就完了',
  started_at: LIVE_5001,
  ended_at: null,
  retain_until: NOW_MS + 7 * DAY,
  recording: true,
  duration_ms: 0,
  gaps: [],
  segments: makeSegments(5001, '老番茄', LIVE_5001, [
    { start: 0, end: 5_400_000, bytes: 5_368_709_120, fileName: videoNameOf(5001, 0) },
    { start: 5_400_000, end: 10_200_000, bytes: 2_147_483_648, fileName: videoNameOf(5001, 1) },
    { start: 10_200_000, end: null, state: 'recording' },
  ]),
})

sessions.push({
  id: 5002,
  kind: 'source',
  group_session_id: null,
  streamer_id: 2,
  streamer_name: '影视飓风',
  title: '聊聊我们是怎么拍 4K 视频的（含设备清单）',
  started_at: LIVE_5002,
  ended_at: null,
  retain_until: NOW_MS + 7 * DAY,
  recording: true,
  duration_ms: 0,
  gaps: [],
  // b 站 hls_fmp4：分段是分片 MP4，DVR 回看接口会返回 415
  segments: makeSegments(5002, '影视飓风', LIVE_5002, [
    {
      start: 0,
      end: 3_600_000,
      bytes: 3_221_225_472,
      container: 'mp4',
      fileName: videoNameOf(5002, 0),
      hasDanmaku: true,
    },
    { start: 3_600_000, end: null, state: 'recording', container: 'mp4', hasDanmaku: true },
  ]),
})

sessions.push({
  id: 5003,
  kind: 'source',
  group_session_id: null,
  streamer_id: 6,
  streamer_name: '午夜琴房',
  title: '深夜钢琴即兴 · 点歌请打在弹幕里',
  started_at: LIVE_5003,
  ended_at: null,
  retain_until: NOW_MS + 7 * DAY,
  recording: true,
  duration_ms: 0,
  gaps: [],
  segments: makeSegments(5003, '午夜琴房', LIVE_5003, [
    {
      start: 0,
      end: 900_000,
      bytes: 1_073_741_824,
      fileName: videoNameOf(5003, 0),
      hasDanmaku: false,
    },
    { start: 900_000, end: null, state: 'recording', hasDanmaku: false },
  ]),
})

sessions.push({
  id: 5004,
  kind: 'source',
  group_session_id: null,
  streamer_id: 8,
  streamer_name: '猫猫台',
  title: '【Twitch】猫猫台 rank 冲分，输了就喵三声',
  started_at: LIVE_5004,
  ended_at: null,
  retain_until: NOW_MS + 7 * DAY,
  recording: true,
  duration_ms: 0,
  gaps: [],
  segments: makeSegments(5004, '猫猫台', LIVE_5004, [
    {
      start: 0,
      end: 7_200_000,
      bytes: 4_724_464_025,
      fileName: videoNameOf(5004, 0),
      hasDanmaku: false,
    },
    { start: 7_200_000, end: null, state: 'recording', hasDanmaku: false },
  ]),
})

// —— 已结束的场次 4901 ~ 4908（4901/4902 会合并成 5100） ——

const START_4901 = NOW_MS - 30 * HOUR
const START_4902 = NOW_MS - 1650 * MIN
const START_4903 = NOW_MS - 300 * MIN
const START_4904 = NOW_MS - 74 * HOUR
const START_4905 = NOW_MS - 71 * HOUR
const START_4906 = NOW_MS - 98 * HOUR
const START_4907 = NOW_MS - 122 * HOUR
const START_4908 = NOW_MS - 146 * HOUR

sessions.push({
  id: 4901,
  kind: 'source',
  group_session_id: null,
  streamer_id: 1,
  streamer_name: '老番茄',
  title: '【星际】四人混战，谁先翻车谁请奶茶',
  started_at: START_4901,
  ended_at: START_4901 + 120 * MIN,
  retain_until: START_4901 + 120 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 120 * MIN,
  gaps: [],
  segments: makeSegments(4901, '老番茄', START_4901, [
    { start: 0, end: 3_600_000, bytes: 15_032_385_536 },
    {
      start: 3_600_000,
      end: 7_200_000,
      bytes: 12_884_901_888,
      state: 'pending_delete',
      container: 'ts',
      hasDanmaku: false,
    },
  ]),
})

sessions.push({
  id: 4902,
  kind: 'source',
  group_session_id: null,
  streamer_id: 1,
  streamer_name: '老番茄',
  title: '【星际】停录续接：第二晚继续冲分',
  started_at: START_4902,
  ended_at: START_4902 + 80 * MIN,
  retain_until: START_4902 + 80 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 80 * MIN,
  gaps: [],
  segments: makeSegments(4902, '老番茄', START_4902, [
    { start: 0, end: 2_400_000, bytes: 9_663_676_416 },
    { start: 2_400_000, end: 4_800_000, bytes: 7_516_192_768 },
  ]),
})

sessions.push({
  id: 4903,
  kind: 'source',
  group_session_id: null,
  streamer_id: 2,
  streamer_name: '影视飓风',
  title: 'RED 摄影机拆解直播',
  started_at: START_4903,
  ended_at: START_4903 + 155 * MIN,
  retain_until: START_4903 + 155 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 155 * MIN,
  gaps: [],
  segments: makeSegments(4903, '影视飓风', START_4903, [
    { start: 0, end: 3_600_000, bytes: 14_495_514_624, container: 'mp4' },
    { start: 3_600_000, end: 7_200_000, bytes: 13_421_772_800, container: 'mp4', hasDanmaku: false },
    { start: 7_200_000, end: 9_300_000, bytes: 5_368_709_120, container: 'mp4', hasDanmaku: false },
  ]),
})

sessions.push({
  id: 4904,
  kind: 'source',
  group_session_id: null,
  streamer_id: 3,
  streamer_name: '水友赛直播间',
  title: '【水友赛】今晚八点，一起来玩致命公司！',
  started_at: START_4904,
  ended_at: START_4904 + 130 * MIN,
  retain_until: START_4904 + 130 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 130 * MIN,
  gaps: [{ from_ms: 3_592_000, to_ms: 3_600_000 }],
  segments: makeSegments(4904, '水友赛直播间', START_4904, [
    { start: 0, end: 3_600_000, bytes: 10_737_418_240 },
    { start: 3_600_000, end: 7_800_000, bytes: 9_126_805_504, gapBefore: 8_000 },
  ]),
})

sessions.push({
  id: 4905,
  kind: 'source',
  group_session_id: null,
  streamer_id: 3,
  streamer_name: '水友赛直播间',
  title: '【水友赛】加场：再来一局致命公司',
  started_at: START_4905,
  ended_at: START_4905 + 100 * MIN,
  retain_until: START_4905 + 100 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 100 * MIN,
  gaps: [],
  segments: makeSegments(4905, '水友赛直播间', START_4905, [
    { start: 0, end: 3_000_000, bytes: 8_589_934_592 },
    { start: 3_000_000, end: 6_000_000, bytes: 8_053_063_168 },
  ]),
})

sessions.push({
  id: 4906,
  kind: 'source',
  group_session_id: null,
  streamer_id: 4,
  streamer_name: '周末电台',
  title: '周末电台 第 88 期 · 深夜点歌与废话',
  started_at: START_4906,
  ended_at: START_4906 + 120 * MIN,
  retain_until: START_4906 + 120 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 120 * MIN,
  gaps: [],
  segments: makeSegments(4906, '周末电台', START_4906, [
    { start: 0, end: 7_200_000, bytes: 6_442_450_944 },
  ]),
})

sessions.push({
  id: 4907,
  kind: 'source',
  group_session_id: null,
  streamer_id: 5,
  streamer_name: '小众音乐人',
  title: '卧室录音室：用 200 块的麦克风做一张专辑',
  started_at: START_4907,
  ended_at: START_4907 + 95 * MIN,
  retain_until: START_4907 + 95 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 95 * MIN,
  gaps: [],
  segments: makeSegments(4907, '小众音乐人', START_4907, [
    { start: 0, end: 2_850_000, bytes: 3_221_225_472 },
    { start: 2_850_000, end: 5_700_000, bytes: 3_006_414_848, hasDanmaku: false },
  ]),
})

sessions.push({
  id: 4908,
  kind: 'source',
  group_session_id: null,
  streamer_id: 7,
  streamer_name: '海外观察',
  title: 'YouTube 直播观察：海外主播怎么剪回放',
  started_at: START_4908,
  ended_at: START_4908 + 210 * MIN,
  retain_until: START_4908 + 210 * MIN + 30 * DAY,
  recording: false,
  duration_ms: 210 * MIN,
  gaps: [],
  segments: makeSegments(4908, '海外观察', START_4908, [
    { start: 0, end: 4_200_000, bytes: 6_871_947_674, container: 'mp4', hasDanmaku: false },
    // 中间这一段的文件丢了：回看到这里会提示不可用
    { start: 4_200_000, end: 8_400_000, bytes: null, state: 'missing', container: 'mp4', hasDanmaku: false },
    { start: 8_400_000, end: 12_600_000, bytes: 6_442_450_944, container: 'mp4', hasDanmaku: false },
  ]),
})

// —— 合并场次 5100：4901 + 4902（同一主播停录后续接） ——

/** 把若干来源场次按时间顺序合并成一场（分段、成员、缺口都按时间轴平移） */
function buildGroup(id: number, sources: SessionRow[], title: string): SessionRow {
  const ordered = sources.slice().sort((a, b) => a.started_at - b.started_at || a.id - b.id)
  const segments: SegmentView[] = []
  const gaps: Gap[] = []
  const members: SessionMember[] = []
  let offset = 0

  ordered.forEach((source, index) => {
    const previous = ordered[index - 1]
    const gap = previous ? Math.max(0, source.started_at - (previous.ended_at ?? source.started_at)) : 0
    if (gap > 0) gaps.push({ from_ms: offset, to_ms: offset + gap })
    offset += gap
    const duration = durationOf(source)
    members.push({
      source_session_id: source.id,
      offset_ms: offset,
      started_at: source.started_at,
      ended_at: source.ended_at,
      title: source.title,
      duration_ms: duration,
      gap_before_ms: gap,
    })
    for (const segment of source.segments) {
      segments.push({
        ...segment,
        id: segmentSeq++,
        source_session_id: source.id,
        start_ms: segment.start_ms + offset,
        end_ms: segment.end_ms === null ? null : segment.end_ms + offset,
      })
    }
    offset += duration
  })

  const last = ordered[ordered.length - 1]
  return {
    id,
    kind: 'group',
    source_session_ids: ordered.map((s) => s.id),
    group_session_id: id,
    streamer_id: ordered[0].streamer_id,
    streamer_name: ordered[0].streamer_name,
    title,
    started_at: ordered[0].started_at,
    ended_at: last.recording ? null : last.ended_at,
    retain_until: null,
    recording: ordered.some((s) => s.recording),
    duration_ms: offset,
    segments,
    gaps,
    members,
  }
}

const GROUP_5100 = buildGroup(
  5100,
  [sessions.find((s) => s.id === 4901)!, sessions.find((s) => s.id === 4902)!],
  '【星际】两晚连播（含停录续接）',
)
GROUP_5100.source_session_ids?.forEach((sourceId) => {
  const source = sessions.find((s) => s.id === sourceId)
  if (source) source.group_session_id = 5100
})
sessions.push(GROUP_5100)

// ---------------------------------------------------------------------------
// 标记 / 切片 / 续接建议 / 自动切片任务
// ---------------------------------------------------------------------------

const MARKER_COLORS = ['#f5222d', '#fa8c16', '#1677ff', '#52c41a', '#722ed1']

const markers: Marker[] = [
  { id: 3301, session_id: 5001, view_session_id: 5001, source_session_id: 5001, at_ms: 735_000, label: '名场面：全员掉线', color: '#f5222d', created_by: 1, created_at: NOW_MS - 3 * HOUR, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3302, session_id: 5001, view_session_id: 5001, source_session_id: 5001, at_ms: 3_780_000, label: '开局翻车，弹幕笑疯', color: '#fa8c16', created_by: 1, created_at: NOW_MS - 2 * HOUR, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3303, session_id: 5001, view_session_id: 5001, source_session_id: 5001, at_ms: 9_600_000, label: '观众点歌：星际主题曲', color: '#1677ff', created_by: 1, created_at: NOW_MS - 25 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3304, session_id: 5002, view_session_id: 5002, source_session_id: 5002, at_ms: 2_100_000, label: 'RED 传感器特写', color: '#722ed1', created_by: 1, created_at: NOW_MS - 80 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3305, session_id: 5004, view_session_id: 5004, source_session_id: 5004, at_ms: 1_260_000, label: '猫猫上桌名场面', color: '#fa8c16', created_by: 1, created_at: NOW_MS - 120 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3306, session_id: 5004, view_session_id: 5004, source_session_id: 5004, at_ms: 5_400_000, label: '反向冲分，观众笑死', color: '#52c41a', created_by: 1, created_at: NOW_MS - 40 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3307, session_id: 4904, view_session_id: 4904, source_session_id: 4904, at_ms: 1_800_000, label: '水友四人同归于尽', color: '#f5222d', created_by: 1, created_at: START_4904 + 40 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3308, session_id: 4904, view_session_id: 4904, source_session_id: 4904, at_ms: 5_400_000, label: '名场面：假装掉线', color: '#1677ff', created_by: 1, created_at: START_4904 + 100 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
  { id: 3309, session_id: 4902, view_session_id: 4902, source_session_id: 4902, at_ms: 600_000, label: '续接后第一波团战', color: '#52c41a', created_by: 1, created_at: START_4902 + 10 * MIN, lookback_ms: 30_000, lookahead_ms: 15_000 },
]

function newClip(fields: Partial<Clip>): Clip {
  const now = Date.now()
  return {
    id: clipSeq++,
    session_id: 0,
    view_session_id: null,
    source_session_id: null,
    marker_id: null,
    in_ms: 0,
    out_ms: 0,
    cut_in_ms: null,
    cut_out_ms: null,
    mode: null,
    title: '',
    state: 'draft',
    file_name: null,
    output_bytes: null,
    duration_ms: null,
    error: null,
    template_id: null,
    studio_override: {},
    archive_bvid: null,
    published_at: null,
    submit_state: null,
    created_by: 1,
    created_at: now,
    updated_at: now,
    progress: null,
    ...fields,
  }
}

const clips: Clip[] = [
  newClip({
    id: 7701,
    session_id: 5001,
    view_session_id: 5001,
    source_session_id: 5001,
    marker_id: 3301,
    in_ms: 720_000,
    out_ms: 780_000,
    cut_in_ms: 720_000,
    cut_out_ms: 780_000,
    mode: 'quick',
    title: '名场面：全员掉线',
    state: 'ready',
    file_name: 'clip_7701.mp4',
    output_bytes: 52_428_800,
    duration_ms: 60_000,
    studio_override: {
      title: '全员掉线名场面',
      tags: ['老番茄', '星际'],
      dtime: 0,
      cover: { source: 'frame', t_ms: 735_000 },
    },
    created_at: NOW_MS - 2 * HOUR,
    updated_at: NOW_MS - 2 * HOUR,
  }),
  newClip({
    id: 7702,
    session_id: 5001,
    view_session_id: 5001,
    source_session_id: 5001,
    marker_id: 3302,
    in_ms: 3_720_000,
    out_ms: 3_960_000,
    mode: 'precise',
    title: '开局翻车 4 分钟',
    state: 'exporting',
    progress: { phase: '压制中', ratio: 0.42 },
    created_at: NOW_MS - 40_000,
    updated_at: NOW_MS - 12_000,
  }),
  newClip({
    id: 7703,
    session_id: 5001,
    view_session_id: 5001,
    source_session_id: 5001,
    marker_id: 3303,
    in_ms: 9_540_000,
    out_ms: 9_720_000,
    mode: 'quick',
    title: '点歌环节（导出失败）',
    state: 'failed',
    error: 'ffmpeg 退出码 1：找不到可用关键帧，源分段可能已被清理',
    created_at: NOW_MS - 5 * HOUR,
    updated_at: NOW_MS - 5 * HOUR + 20_000,
  }),
  newClip({
    id: 7704,
    session_id: 5001,
    view_session_id: 5001,
    source_session_id: 5001,
    in_ms: 10_380_000,
    out_ms: 10_560_000,
    title: '备选：深夜碎碎念',
    state: 'draft',
    created_at: NOW_MS - 20 * MIN,
    updated_at: NOW_MS - 20 * MIN,
  }),
  newClip({
    id: 7705,
    session_id: 5002,
    view_session_id: 5002,
    source_session_id: 5002,
    marker_id: 3304,
    in_ms: 2_040_000,
    out_ms: 2_220_000,
    cut_in_ms: 2_040_000,
    cut_out_ms: 2_220_000,
    mode: 'precise',
    title: 'RED 传感器特写',
    state: 'ready',
    file_name: 'clip_7705.mp4',
    output_bytes: 96_468_992,
    duration_ms: 180_000,
    studio_override: { title: 'RED 传感器长这样', tags: ['影视飓风', 'RED'], cover: { source: 'frame', t_ms: 2_100_000 } },
    created_at: NOW_MS - 70 * MIN,
    updated_at: NOW_MS - 65 * MIN,
  }),
  newClip({
    id: 7706,
    session_id: 4904,
    view_session_id: 4904,
    source_session_id: 4904,
    marker_id: 3307,
    in_ms: 1_740_000,
    out_ms: 1_920_000,
    cut_in_ms: 1_740_000,
    cut_out_ms: 1_920_000,
    mode: 'quick',
    title: '水友赛：四人同归于尽',
    state: 'ready',
    file_name: 'clip_7706.mp4',
    output_bytes: 71_303_168,
    duration_ms: 180_000,
    created_at: START_4904 + 45 * MIN,
    updated_at: START_4904 + 50 * MIN,
  }),
  newClip({
    id: 7707,
    session_id: 5004,
    view_session_id: 5004,
    source_session_id: 5004,
    marker_id: 3305,
    in_ms: 1_200_000,
    out_ms: 1_320_000,
    cut_in_ms: 1_200_000,
    cut_out_ms: 1_320_000,
    mode: 'quick',
    title: '猫猫上桌名场面',
    state: 'ready',
    file_name: 'clip_7707.mp4',
    output_bytes: 39_845_888,
    duration_ms: 120_000,
    created_at: NOW_MS - 110 * MIN,
    updated_at: NOW_MS - 105 * MIN,
  }),
]

/** 导出开始时刻；预置的「导出中」切片不在这里，一直停在导出中展示状态 */
const exportStartedAt = new Map<number, number>()

/** 每次读切片都推进一下导出进度，列表按 1 秒轮询就能看到变化 */
function tickClip(clip: Clip): Clip {
  if (clip.state !== 'exporting') return clip
  const started = exportStartedAt.get(clip.id)
  if (started === undefined) return clip
  const elapsed = Date.now() - started
  if (elapsed >= 18_000) {
    const duration = Math.max(0, clip.out_ms - clip.in_ms)
    clip.state = 'ready'
    clip.file_name = `clip_${clip.id}.mp4`
    clip.output_bytes = Math.round((duration / 1000) * 2_400_000)
    clip.duration_ms = duration
    clip.cut_in_ms = clip.in_ms
    clip.cut_out_ms = clip.out_ms
    clip.progress = null
    clip.updated_at = Date.now()
    exportStartedAt.delete(clip.id)
  } else {
    clip.progress = { phase: '压制中', ratio: Math.min(0.98, Number((elapsed / 18_000).toFixed(2))) }
    clip.updated_at = Date.now()
  }
  return clip
}

const autoClipJobRows: AutoClipJob[] = [
  {
    id: 6101,
    session_id: 5001,
    trigger: 'manual',
    state: 'running',
    stage: 'asr',
    progress_done: 14,
    progress_total: 60,
    not_before: 0,
    error: null,
    asr_planned_seconds: 5_400,
    asr_seconds: 1_260,
    tokens_in: 0,
    tokens_out: 0,
    images: 0,
    warnings: [],
    reuse_transcript: false,
    created_at: NOW_MS - 6 * MIN,
    started_at: NOW_MS - 5 * MIN,
    finished_at: null,
  },
  {
    id: 6102,
    session_id: 4904,
    trigger: 'auto',
    state: 'done',
    stage: null,
    progress_done: 42,
    progress_total: 42,
    not_before: 0,
    error: null,
    asr_planned_seconds: 4_200,
    asr_seconds: 3_900,
    tokens_in: 182_340,
    tokens_out: 3_120,
    images: 6,
    warnings: ['没有弹幕记录，候选边界按语音和画面判断'],
    reuse_transcript: false,
    created_at: START_4904 + 140 * MIN,
    started_at: START_4904 + 141 * MIN,
    finished_at: START_4904 + 160 * MIN,
  },
  {
    id: 6103,
    session_id: 4908,
    trigger: 'auto',
    state: 'failed',
    stage: null,
    progress_done: 0,
    progress_total: 0,
    not_before: 0,
    error: '语音转写超过每场上限 180 分钟，没有调用模型',
    asr_planned_seconds: null,
    asr_seconds: 0,
    tokens_in: 0,
    tokens_out: 0,
    images: 0,
    warnings: [],
    reuse_transcript: false,
    created_at: START_4908 + 220 * MIN,
    started_at: START_4908 + 220 * MIN,
    finished_at: START_4908 + 221 * MIN,
  },
]

const suggestions: Suggestion[] = [
  {
    id: 6601,
    session_id: 5001,
    view_session_id: 5001,
    source_session_id: 5001,
    job_id: 6101,
    in_ms: 3_000_000,
    out_ms: 3_060_000,
    title: '水友集体翻车',
    reason: '弹幕密度突增 + 连续爆笑台词',
    confidence: 0.82,
    tags: ['名场面', '星际'],
    evidence: { asr_lines: 9, danmaku: 412, images: [3_000_000, 3_030_000] },
    state: 'pending',
    clip_id: null,
    created_at: NOW_MS - 5 * MIN,
    updated_at: NOW_MS - 5 * MIN,
    expires_at: NOW_MS + 71 * HOUR,
  },
  {
    id: 6602,
    session_id: 5001,
    view_session_id: 5001,
    source_session_id: 5001,
    job_id: 6101,
    in_ms: 6_600_000,
    out_ms: 6_720_000,
    title: '反向操作集锦 · 连送三波',
    reason: '连续三次对局翻盘 + 观众刷屏「退游」',
    confidence: 0.64,
    tags: ['高能', '翻车'],
    evidence: { asr_lines: 12, danmaku: 286, images: [] },
    state: 'pending',
    clip_id: null,
    created_at: NOW_MS - 4 * MIN,
    updated_at: NOW_MS - 4 * MIN,
    expires_at: NOW_MS + 71 * HOUR,
  },
  {
    id: 6603,
    session_id: 4904,
    view_session_id: 4904,
    source_session_id: 4904,
    job_id: 6102,
    in_ms: 1_740_000,
    out_ms: 1_920_000,
    title: '四人同归于尽',
    reason: '弹幕高峰 + 全员同时倒下',
    confidence: 0.88,
    tags: ['名场面', '水友赛'],
    evidence: { asr_lines: 7, danmaku: 508, images: [1_800_000] },
    state: 'accepted',
    clip_id: 7706,
    created_at: START_4904 + 150 * MIN,
    updated_at: START_4904 + 152 * MIN,
    expires_at: null,
  },
  {
    id: 6604,
    session_id: 4907,
    view_session_id: 4907,
    source_session_id: 4907,
    job_id: null,
    in_ms: 2_400_000,
    out_ms: 2_520_000,
    title: '麦克风翻车现场',
    reason: '爆音 + 主播自己也笑场',
    confidence: 0.55,
    tags: ['花絮'],
    evidence: { asr_lines: 4, danmaku: 96, images: [] },
    state: 'dismissed',
    clip_id: null,
    created_at: START_4907 + 60 * MIN,
    updated_at: START_4907 + 62 * MIN,
    expires_at: null,
  },
]

const mergeCandidates: SessionMergeCandidate[] = [
  {
    id: 7101,
    streamer_id: 3,
    streamer_name: '水友赛直播间',
    previous_session_id: 4904,
    source_session_id: 4905,
    group_session_id: null,
    gap_ms: 50 * MIN,
    previous_title: '【水友赛】今晚八点，一起来玩致命公司！',
    source_title: '【水友赛】加场：再来一局致命公司',
    previous_started_at: START_4904,
    source_started_at: START_4905,
    recipe_diff: false,
  },
  {
    id: 7102,
    streamer_id: 2,
    streamer_name: '影视飓风',
    previous_session_id: 4903,
    source_session_id: 5002,
    group_session_id: null,
    gap_ms: 30 * MIN,
    previous_title: 'RED 摄影机拆解直播',
    source_title: '聊聊我们是怎么拍 4K 视频的（含设备清单）',
    previous_started_at: START_4903,
    source_started_at: LIVE_5002,
    recipe_diff: true,
  },
]

// ---------------------------------------------------------------------------
// 场次查询 / 序列化
// ---------------------------------------------------------------------------

function findSession(id: number): SessionRow | undefined {
  return sessions.find((s) => s.id === id)
}

function findClip(id: number): Clip | undefined {
  return clips.find((c) => c.id === id)
}

function summaryOf(row: SessionRow): SessionSummary {
  const summary: SessionSummary = {
    id: row.id,
    streamer_id: row.streamer_id,
    streamer_name: row.streamer_name,
    title: row.title,
    started_at: row.started_at,
    ended_at: row.ended_at,
    retain_until: row.retain_until,
    recording: row.recording,
    duration_ms: durationOf(row),
    segment_count: row.segments.length,
    bytes: writtenBytes(row),
  }
  if (row.kind === 'group') {
    summary.kind = 'group'
    summary.source_session_ids = row.source_session_ids ?? []
  } else {
    summary.kind = 'source'
  }
  summary.group_session_id = row.group_session_id
  return summary
}

/** 正在写的分段：字节数按录制码率现算，和时间轴一起往前长 */
function segmentView(row: SessionRow, segment: SegmentView): SegmentView {
  if (segment.state !== 'recording') return { ...segment }
  const elapsed = Math.max(0, durationOf(row) - segment.start_ms)
  const rate = findStreamer(row.streamer_id ?? -1)?.live_bytes_per_sec ?? 4_000_000
  return { ...segment, bytes: Math.round((elapsed / 1000) * rate) }
}

function detailOf(row: SessionRow): SessionDetail {
  const detail: SessionDetail = {
    ...summaryOf(row),
    segments: row.segments.map((segment) => segmentView(row, segment)),
    gaps: row.gaps.map((gap) => ({ ...gap })),
  }
  if (row.members) detail.members = row.members.map((member) => ({ ...member }))
  return detail
}

/** 视图时间落在哪个来源场次上（合并工作台里需要换算） */
function ownerAt(row: SessionRow, atMs: number): { view: number; source: number } {
  if (row.kind !== 'group' || !row.members || row.members.length === 0) {
    return { view: row.id, source: row.id }
  }
  const member =
    row.members.find((m) => atMs >= m.offset_ms && atMs <= m.offset_ms + m.duration_ms) ??
    row.members[row.members.length - 1]
  return { view: row.id, source: member.source_session_id }
}

function clipsOf(sessionId: number): Clip[] {
  return clips
    .filter((clip) => clip.session_id === sessionId || clip.view_session_id === sessionId)
    .sort((a, b) => b.created_at - a.created_at)
    .map(tickClip)
}

function markersOf(sessionId: number): Marker[] {
  return markers
    .filter((marker) => marker.session_id === sessionId || marker.view_session_id === sessionId)
    .sort((a, b) => a.at_ms - b.at_ms || a.id - b.id)
}

function latestJob(sessionId: number): AutoClipJob | null {
  const rows = autoClipJobRows.filter((job) => job.session_id === sessionId)
  if (rows.length === 0) return null
  const active = rows.find((job) => job.state === 'queued' || job.state === 'running')
  if (active) return active
  return rows.reduce((latest, job) => (job.created_at > latest.created_at ? job : latest), rows[0])
}

const SEEDED_JOB_IDS = new Set([6101, 6102, 6103])

/** 新入队的任务按时间推进：排队 → 转写 → 完成；种子任务保持固定状态 */
function tickJob(job: AutoClipJob): AutoClipJob {
  if (SEEDED_JOB_IDS.has(job.id)) return job
  if (job.state !== 'queued' && job.state !== 'running') return job
  const elapsed = Date.now() - job.created_at
  if (elapsed < 3_000) {
    job.state = 'queued'
    job.stage = null
    return job
  }
  if (elapsed < 30_000) {
    job.state = 'running'
    job.stage = elapsed < 15_000 ? 'audio' : 'asr'
    job.progress_total = 60
    job.progress_done = Math.min(60, Math.floor(elapsed / 500))
    if (job.started_at === null) job.started_at = job.created_at + 3_000
    return job
  }
  const row = findSession(job.session_id)
  job.state = 'done'
  job.stage = null
  job.progress_total = job.progress_total > 0 ? job.progress_total : 42
  job.progress_done = job.progress_total
  job.finished_at = job.created_at + 30_000
  job.asr_seconds = row ? estimateOf(row, job.reuse_transcript).asr_seconds : 0
  job.tokens_in = 96_420
  job.tokens_out = 1_820
  job.images = 4
  job.warnings = ['弹幕记录不完整，候选边界按语音判断']
  return job
}

function estimateOf(row: SessionRow, reuseTranscript: boolean): AutoClipEstimate {
  const recorded = Math.max(0, Math.round(durationOf(row) / 1000))
  const asr = Math.round(recorded * 0.42)
  const windows = Math.max(1, Math.round(recorded / 1800))
  const tokens = Math.round(recorded * 26)
  const overLimit = asr > 180 * 60
  return {
    recorded_seconds: recorded,
    asr_seconds: reuseTranscript ? 0 : asr,
    transcribed_seconds: reuseTranscript ? asr : 0,
    basis: 'duration',
    max_asr_minutes: 180,
    over_limit: overLimit,
    message: overLimit ? '转写时长超过每场上限 180 分钟，超出部分不会分析' : null,
    chat: { tokens, images: windows * 2, windows, basis: 'duration' },
    max_chat_tokens: 200_000,
    chat_over_limit: tokens > 200_000,
    chat_message: tokens > 200_000 ? '预计 chat 用量超过每场上限 200000 token' : null,
  }
}

/** 合并若干来源场次；不合法时返回 400/404 响应 */
function mergeSources(ids: number[]): { group: SessionRow | null; error: Response | null } {
  if (!Array.isArray(ids) || ids.length < 2) return { group: null, error: badRequest('请选择至少两场直播') }
  if (ids.length > 100) return { group: null, error: badRequest('每次最多合并 100 个来源场次') }

  const rows: SessionRow[] = []
  for (const id of ids) {
    const row = findSession(id)
    if (!row) return { group: null, error: notFound(`来源场次 ${id} 不存在`) }
    rows.push(row)
  }
  if (rows.some((row) => row.kind === 'group' || row.group_session_id != null)) {
    return { group: null, error: badRequest('请选择尚未合并的原始场次') }
  }
  const streamerId = rows[0].streamer_id
  if (streamerId === null || rows.some((row) => row.streamer_id !== streamerId)) {
    return { group: null, error: badRequest('只能合并同一主播的场次') }
  }
  const ordered = rows.slice().sort((a, b) => a.started_at - b.started_at || a.id - b.id)
  if (ordered.some((row, index) => index < ordered.length - 1 && (row.recording || row.ended_at === null))) {
    return { group: null, error: badRequest('只有最后一个来源场次可以仍在录制') }
  }
  if (ordered.some((row, index) => index > 0 && row.started_at < (ordered[index - 1].ended_at ?? Infinity))) {
    return { group: null, error: badRequest('来源场次的录制时间重叠，不能合并') }
  }

  const title = `${ordered[0].title || ordered[0].streamer_name}（含停录续接）`
  const group = buildGroup(nextId(sessions), ordered, title)
  sessions.push(group)
  ordered.forEach((row) => {
    row.group_session_id = group.id
  })
  // 已经合并掉的场次，续接建议不再需要
  for (let i = mergeCandidates.length - 1; i >= 0; i -= 1) {
    const candidate = mergeCandidates[i]
    if (ids.includes(candidate.previous_session_id) || ids.includes(candidate.source_session_id)) {
      mergeCandidates.splice(i, 1)
    }
  }
  return { group, error: null }
}

// ---------------------------------------------------------------------------
// 渲染配方 / 素材
// ---------------------------------------------------------------------------

function defaultRecipe(): RenderRecipe {
  return {
    danmaku: {
      enabled: true,
      font: 'Noto Sans CJK SC',
      font_size: 38,
      opacity: 0.8,
      outline: 2,
      scroll_seconds: 12,
      display_area: 0.4,
      density: -1,
      offset_ms: 0,
      segment_offsets: {},
    },
    regions: [],
    encoding: { encoder: 'auto', device: null, quality: 'balanced' },
  }
}

const recipes = new Map<number, RenderRecipe>()
const renderAssets = new Map<number, RenderAsset[]>()
const assetRegistry = new Map<number, RenderAsset>()

function assetsFor(sessionId: number): RenderAsset[] {
  const existing = renderAssets.get(sessionId)
  if (existing) return existing
  const created: RenderAsset[] = []
  renderAssets.set(sessionId, created)
  return created
}

function fakeSha(seed: number): string {
  const rand = seededInt(seed, 0x1000_0000, 0x7fff_ffff).toString(16)
  return `${rand}${rand}${rand}${rand}${rand}${rand}${rand}${rand}`.slice(0, 64)
}

function seedAsset(sessionId: number, id: number, width: number, height: number): void {
  const asset: RenderAsset = { id, width, height, sha256: fakeSha(id), url: `/v1/render-assets/${id}` }
  assetRegistry.set(id, asset)
  assetsFor(sessionId).push(asset)
}

seedAsset(5001, 8001, 320, 180)
seedAsset(5001, 8002, 240, 240)
seedAsset(5002, 8003, 480, 270)

// ---------------------------------------------------------------------------
// 缩图
// ---------------------------------------------------------------------------

function thumbResponse(row: SessionRow, atMs: number): Response {
  const id = Math.abs(row.id) % 100000
  const label = esc(row.title || row.streamer_name || `场次 ${row.id}`)
  const time = hms(atMs)
  const live = row.recording
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
<defs>
<linearGradient id="t${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#161b2e"/><stop offset="60%" stop-color="#2b3a67"/><stop offset="100%" stop-color="#6d7fd6"/>
</linearGradient>
</defs>
<rect width="480" height="270" fill="url(#t${id})"/>
<g opacity="0.16" stroke="#ffffff" fill="none" stroke-width="1.2">
<circle cx="420" cy="220" r="120"/><circle cx="420" cy="220" r="86"/><circle cx="420" cy="220" r="52"/>
</g>
${live ? `<rect x="18" y="18" rx="4" width="60" height="24" fill="#f5222d"/><text x="48" y="35" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">LIVE</text>` : ''}
<text x="20" y="234" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="19" font-weight="700" fill="#ffffff" opacity="0.96">${label.length > 26 ? `${label.slice(0, 26)}…` : label}</text>
<text x="20" y="256" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="13" fill="#ffffff" opacity="0.72">${esc(time)} · 演示站缩图</text>
</svg>`
  return new Response(svg, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 场次列表：新的在前；被合并进 group 的来源场次默认不列出 */
const listSessions: MockHandler = (ctx) => {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/sessions') return undefined

  const rawPage = ctx.query.get('page')
  const rawSize = ctx.query.get('page_size')
  const page = rawPage ? Math.max(1, Number(rawPage) || 1) : 1
  const pageSize = rawSize ? clamp(Number(rawSize) || 20, 1, 100) : 20
  const includeSources = ['true', '1', 'yes'].includes((ctx.query.get('include_sources') ?? '').toLowerCase())
  const rawStreamer = ctx.query.get('streamer_id')
  const streamerId = rawStreamer ? Number(rawStreamer) : null

  const visible = sessions
    .filter((row) => {
      if (!includeSources && row.kind === 'source' && row.group_session_id != null) return false
      if (streamerId !== null && Number.isFinite(streamerId) && row.streamer_id !== streamerId) return false
      return true
    })
    .sort((a, b) => b.started_at - a.started_at || b.id - a.id)

  const offset = (page - 1) * pageSize
  return json({
    items: visible.slice(offset, offset + pageSize).map(summaryOf),
    total: visible.length,
    page,
    page_size: pageSize,
  })
}

/** 场次详情 / 删除场次历史 */
const sessionDetail: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)$/)
  if (!Number.isFinite(id)) return undefined

  if (ctx.method === 'GET') {
    const row = findSession(id)
    return row ? json(detailOf(row)) : notFound(`场次 ${id} 不存在`)
  }

  if (ctx.method === 'DELETE') {
    const index = sessions.findIndex((row) => row.id === id)
    if (index < 0) return notFound(`场次 ${id} 不存在`)
    const [removed] = sessions.splice(index, 1)

    // 时间轴、标记、切片记录、自动切片任务一起删；原始录像文件按后端约定保留
    for (let i = markers.length - 1; i >= 0; i -= 1) {
      if (markers[i].session_id === id || markers[i].view_session_id === id) markers.splice(i, 1)
    }
    for (let i = clips.length - 1; i >= 0; i -= 1) {
      if (clips[i].session_id === id || clips[i].view_session_id === id) {
        exportStartedAt.delete(clips[i].id)
        clips.splice(i, 1)
      }
    }
    for (let i = suggestions.length - 1; i >= 0; i -= 1) {
      if (suggestions[i].session_id === id || suggestions[i].view_session_id === id) suggestions.splice(i, 1)
    }
    for (let i = autoClipJobRows.length - 1; i >= 0; i -= 1) {
      if (autoClipJobRows[i].session_id === id) autoClipJobRows.splice(i, 1)
    }
    for (let i = mergeCandidates.length - 1; i >= 0; i -= 1) {
      if (mergeCandidates[i].previous_session_id === id || mergeCandidates[i].source_session_id === id) {
        mergeCandidates.splice(i, 1)
      }
    }
    renderAssets.delete(id)

    // 合并场次里少了来源：把来源列表同步一下
    if (removed.kind === 'group') {
      for (const sourceId of removed.source_session_ids ?? []) {
        const source = findSession(sourceId)
        if (source && source.group_session_id === id) source.group_session_id = null
      }
    } else {
      for (const group of sessions) {
        if (group.kind !== 'group' || !group.source_session_ids) continue
        if (group.source_session_ids.includes(id)) {
          group.source_session_ids = group.source_session_ids.filter((sourceId) => sourceId !== id)
          if (group.members) group.members = group.members.filter((member) => member.source_session_id !== id)
        }
      }
    }
    const streamer = db.streamers.find((s) => s.session_id === id)
    if (streamer) {
      streamer.session_id = null
      streamer.marker_count = 0
    }
    return noContent()
  }

  return undefined
}

/** 切片列表 / 新建切片 */
const sessionClips: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/clips$/)
  if (!Number.isFinite(id)) return undefined
  if (ctx.method !== 'GET' && ctx.method !== 'POST') return undefined
  const row = findSession(id)
  if (!row) return notFound(`场次 ${id} 不存在`)

  if (ctx.method === 'GET') return json({ clips: clipsOf(id) })

  const body = (ctx.body ?? {}) as Record<string, any>
  const duration = durationOf(row)
  let inMs = 0
  let outMs = 0

  if (body.last_ms !== undefined && body.last_ms !== null) {
    // 直播里「剪下刚才 N 秒」：出点是屏幕上正在放的那一帧
    const latency = Number(body.latency_ms ?? 0)
    outMs = clamp(duration - (Number.isFinite(latency) ? latency : 0), 0, duration)
    inMs = Math.max(0, outMs - Number(body.last_ms || 0))
  } else {
    inMs = clamp(Number(body.in_ms ?? 0), 0, duration)
    outMs = clamp(Number(body.out_ms ?? inMs), 0, duration)
  }
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) {
    return badRequest('入点必须早于出点，且都在场次时间轴内')
  }

  const markerId = body.marker_id === undefined || body.marker_id === null ? null : Number(body.marker_id)
  const marker = markerId === null ? undefined : markers.find((m) => m.id === markerId)
  const exportMode: ClipMode | null =
    body.export === 'quick' || body.export === 'precise' ? (body.export as ClipMode) : null
  const state: ClipState = exportMode ? 'exporting' : 'draft'
  const owner = ownerAt(row, inMs)
  const title = String(body.title ?? marker?.label ?? `切片 ${hms(inMs)} - ${hms(outMs)}`).slice(0, 80)

  const clip = newClip({
    session_id: owner.source,
    view_session_id: row.id,
    source_session_id: owner.source,
    marker_id: markerId !== null && Number.isFinite(markerId) ? markerId : null,
    in_ms: Math.round(inMs),
    out_ms: Math.round(outMs),
    title,
    mode: exportMode,
    state,
    progress: exportMode ? { phase: '排队', ratio: 0 } : null,
  })
  clips.push(clip)
  if (exportMode) exportStartedAt.set(clip.id, Date.now())
  return json(clip, 201)
}

/** 改切片 / 删切片（路径里的 id 是 view_session_id ?? session_id） */
const sessionClipItem: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/sessions\/(\d+)\/clips\/(\d+)$/)
  if (!match) return undefined
  const sessionId = Number(match[1])
  const clipId = Number(match[2])
  const clip = findClip(clipId)
  if (!clip) return notFound(`切片 ${clipId} 不存在`)
  if (clip.session_id !== sessionId && clip.view_session_id !== sessionId) {
    return notFound(`切片 ${clipId} 不属于场次 ${sessionId}`)
  }

  if (ctx.method === 'PATCH') {
    const body = (ctx.body ?? {}) as Record<string, any>
    const row = findSession(clip.view_session_id ?? clip.session_id)
    const duration = row ? durationOf(row) : Number.POSITIVE_INFINITY
    if (body.in_ms !== undefined) clip.in_ms = clamp(Number(body.in_ms), 0, duration)
    if (body.out_ms !== undefined) clip.out_ms = clamp(Number(body.out_ms), 0, duration)
    if (clip.out_ms <= clip.in_ms) return badRequest('入点必须早于出点')
    if (body.title !== undefined) clip.title = String(body.title ?? '').slice(0, 80)
    if (body.template_id !== undefined) {
      clip.template_id = body.template_id === null ? null : Number(body.template_id)
    }
    if (body.studio_override !== undefined) {
      clip.studio_override = (body.studio_override ?? {}) as Clip['studio_override']
    }
    clip.updated_at = Date.now()
    return json(tickClip(clip))
  }

  if (ctx.method === 'DELETE') {
    const index = clips.findIndex((c) => c.id === clipId)
    if (index >= 0) clips.splice(index, 1)
    exportStartedAt.delete(clipId)
    return noContent()
  }

  return undefined
}

/** 单个切片 */
const clipDetail: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/clips\/(\d+)$/)
  if (!match || ctx.method !== 'GET') return undefined
  const clip = findClip(Number(match[1]))
  if (!clip) return notFound('切片不存在')
  return json(tickClip(clip))
}

/** 开始导出（失败后重试也是它） */
const clipExport: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/clips\/(\d+)\/export$/)
  if (!match || ctx.method !== 'POST') return undefined
  const clip = findClip(Number(match[1]))
  if (!clip) return notFound('切片不存在')

  const body = (ctx.body ?? {}) as Record<string, any>
  const mode: ClipMode = body.mode === 'precise' ? 'precise' : 'quick'
  clip.mode = mode
  clip.state = 'exporting'
  clip.error = null
  clip.progress = { phase: '排队', ratio: 0 }
  clip.updated_at = Date.now()
  exportStartedAt.set(clip.id, Date.now())
  return json(clip)
}

/** 下载：演示站没有真实产物，HEAD / GET 都 404，前端走「失败原因」分支 */
const clipDownload: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/clips\/(\d+)\/download$/)
  if (!match) return undefined
  if (ctx.method === 'HEAD') {
    return new Response(null, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  if (ctx.method === 'GET') {
    return text('演示站没有真实切片文件：导出产物只在真实后端生成（这是 mock 环境）', 404)
  }
  return undefined
}

/** 切片封面：设置 / 删除 / 取图 */
const clipCover: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/clips\/(\d+)\/cover$/)
  if (!match) return undefined
  const clip = findClip(Number(match[1]))
  if (!clip) return notFound('切片不存在')

  if (ctx.method === 'PUT') {
    const contentType = (ctx.headers.get('content-type') ?? '').toLowerCase()
    const body = (ctx.body ?? {}) as Record<string, any>
    if (contentType.startsWith('image/')) {
      // 上传本机图片：演示站只记下「封面来自上传」，取图时给一张占位 SVG
      clip.studio_override.cover = { source: 'upload' }
    } else if (body.live === true) {
      clip.studio_override.cover = { source: 'live' }
    } else if (body.t !== undefined) {
      clip.studio_override.cover = { source: 'frame', t_ms: Math.max(0, Math.round(Number(body.t))) }
    } else {
      return badRequest('需要 {t: 毫秒} / {live: true} 或 image/jpeg|png|webp 图片')
    }
    clip.updated_at = Date.now()
    return json(clip.studio_override)
  }

  if (ctx.method === 'DELETE') {
    delete clip.studio_override.cover
    clip.updated_at = Date.now()
    return noContent()
  }

  if (ctx.method === 'GET') {
    const cover = clip.studio_override.cover
    const seed = cover && cover.source === 'frame' ? Math.round(cover.t_ms / 1000) : clip.id
    return coverSvg(clip.title || `切片 ${clip.id}`, seed, false)
  }

  return undefined
}

/** 标记列表 / 新建标记 */
const sessionMarkers: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/markers$/)
  if (!Number.isFinite(id)) return undefined
  if (ctx.method !== 'GET' && ctx.method !== 'POST') return undefined
  const row = findSession(id)
  if (!row) return notFound(`场次 ${id} 不存在`)

  if (ctx.method === 'GET') return json({ markers: markersOf(id) })

  const body = (ctx.body ?? {}) as Record<string, any>
  const duration = durationOf(row)
  let atMs: number
  if (body.at_ms !== undefined && body.at_ms !== null) {
    atMs = clamp(Number(body.at_ms), 0, duration)
  } else {
    // 直播打点：服务端只用 client_now − pressed_at 的差值，不要求本机时钟准
    const lag = clamp(Number(body.client_now ?? 0) - Number(body.pressed_at ?? 0), 0, 600_000)
    const latency = clamp(Number(body.latency_ms ?? 0), 0, 600_000)
    atMs = clamp(duration - lag - latency, 0, duration)
  }
  if (!Number.isFinite(atMs)) atMs = duration

  const owner = ownerAt(row, atMs)
  const label = String(body.label ?? `标记 ${hms(atMs)}`).slice(0, 40)
  const marker: Marker = {
    id: markerSeq++,
    session_id: owner.source,
    view_session_id: row.id,
    source_session_id: owner.source,
    at_ms: Math.round(atMs),
    label,
    color: MARKER_COLORS[markers.length % MARKER_COLORS.length],
    created_by: 1,
    created_at: Date.now(),
    lookback_ms: 30_000,
    lookahead_ms: 15_000,
  }
  markers.push(marker)

  // 卡片上的「本场标记数」来自 /v1/streamers，这里同步一下
  const streamer = db.streamers.find((s) => s.session_id === row.id)
  if (streamer) streamer.marker_count = (streamer.marker_count ?? 0) + 1
  return json(marker, 201)
}

/** 改标记 / 删标记 */
const sessionMarkerItem: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/sessions\/(\d+)\/markers\/(\d+)$/)
  if (!match) return undefined
  const markerId = Number(match[2])
  const marker = markers.find((m) => m.id === markerId)
  if (!marker) return notFound(`标记 ${markerId} 不存在`)

  if (ctx.method === 'PATCH') {
    const body = (ctx.body ?? {}) as Record<string, any>
    if (body.label !== undefined) marker.label = String(body.label ?? '').slice(0, 40)
    return json(marker)
  }

  if (ctx.method === 'DELETE') {
    const index = markers.findIndex((m) => m.id === markerId)
    if (index >= 0) markers.splice(index, 1)
    const streamer = db.streamers.find((s) => s.session_id === (marker.view_session_id ?? marker.session_id))
    if (streamer) streamer.marker_count = Math.max(0, (streamer.marker_count ?? 1) - 1)
    return noContent()
  }

  return undefined
}

/** 停录续接建议 */
const mergeCandidateList: MockHandler = (ctx) => {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/session-merge-candidates') return undefined
  return json({ items: mergeCandidates.map((candidate) => ({ ...candidate })) })
}

/** 手动合并若干场次 */
const mergeGroups: MockHandler = (ctx) => {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/session-groups') return undefined
  const body = (ctx.body ?? {}) as Record<string, any>
  const ids = Array.isArray(body.source_session_ids)
    ? body.source_session_ids.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value))
    : []
  const result = mergeSources(ids)
  if (result.error) return result.error
  return json({ id: result.group?.id ?? null }, 201)
}

/** 确认 / 忽略续接建议 */
const mergeCandidateAction: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/session-merge-candidates\/(\d+)\/(confirm|dismiss)$/)
  if (!match || ctx.method !== 'POST') return undefined
  const id = Number(match[1])
  const action = match[2]
  const index = mergeCandidates.findIndex((candidate) => candidate.id === id)
  if (index < 0) return notFound(`续接建议 ${id} 不存在`)
  const candidate = mergeCandidates[index]

  if (action === 'dismiss') {
    mergeCandidates.splice(index, 1)
    return json({ success: true })
  }

  const result = mergeSources([candidate.previous_session_id, candidate.source_session_id])
  if (result.error) return result.error
  mergeCandidates.splice(index, 1)
  return json({ id: result.group?.id ?? null })
}

/** 自动切片的全局状态 */
const autoClipStatus: MockHandler = (ctx) => {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/auto-clip/status') return undefined
  const status: AutoClipStatus = {
    enabled: true,
    configured: true,
    api_host: 'api.deepseek.com',
    chat_model: 'deepseek-chat',
    asr_host: 'api.siliconflow.cn',
    asr_model: 'FunAudioLLM/SenseVoiceSmall',
    key_source: 'config',
    thumbnails: 'auto',
    thumbnails_active: true,
    vision: true,
    asr_segments: true,
    max_asr_minutes: 180,
    max_chat_tokens: 200_000,
  }
  return json(status)
}

/** 批量取多个场次的任务；没有任务的场次不出现在结果里 */
const autoClipJobsRoute: MockHandler = (ctx) => {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/auto-clip/jobs') return undefined
  const raw = ctx.query.get('session_ids') ?? ''
  const ids = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value))
  const jobs = ids
    .map((sessionId) => latestJob(sessionId))
    .filter((job): job is AutoClipJob => job !== null)
    .map(tickJob)
  return json({ jobs })
}

/** 场次的自动切片任务 / 预估 / 入队 / 取消 */
const sessionAutoClip: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/auto-clip$/)
  if (!Number.isFinite(id)) return undefined
  const row = findSession(id)
  if (!row) return notFound(`场次 ${id} 不存在`)

  if (ctx.method === 'GET') {
    const job = latestJob(id)
    return json({
      enabled: true,
      job: job ? tickJob(job) : null,
      estimate: job ? estimateOf(row, job.reuse_transcript) : null,
    })
  }

  if (ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Record<string, any>
    const reuse = body.reuse_transcript === true
    if (body.confirm !== true) {
      // 只要预估，不入队
      const job = latestJob(id)
      return json({
        enabled: true,
        job: job ? tickJob(job) : null,
        estimate: estimateOf(row, reuse),
      })
    }
    const estimate = estimateOf(row, reuse)
    const job: AutoClipJob = {
      id: nextId(autoClipJobRows),
      session_id: id,
      trigger: 'manual',
      state: 'queued',
      stage: null,
      progress_done: 0,
      progress_total: 0,
      not_before: 0,
      error: null,
      asr_planned_seconds: estimate.asr_seconds,
      asr_seconds: 0,
      tokens_in: 0,
      tokens_out: 0,
      images: 0,
      warnings: [],
      reuse_transcript: reuse,
      created_at: Date.now(),
      started_at: null,
      finished_at: null,
    }
    autoClipJobRows.push(job)
    return json({ enabled: true, job, estimate })
  }

  if (ctx.method === 'DELETE') {
    const job = latestJob(id)
    if (job && (job.state === 'queued' || job.state === 'running')) {
      job.state = 'canceled'
      job.stage = null
      job.finished_at = Date.now()
    }
    return noContent()
  }

  return undefined
}

/** 候选片段列表 */
const sessionSuggestions: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/suggestions$/)
  if (!Number.isFinite(id) || ctx.method !== 'GET') return undefined
  if (!findSession(id)) return notFound(`场次 ${id} 不存在`)
  const rows = suggestions
    .filter((suggestion) => suggestion.session_id === id || suggestion.view_session_id === id)
    .sort((a, b) => a.in_ms - b.in_ms)
  return json({ suggestions: rows })
}

/** 接受 / 忽略候选片段 */
const suggestionAction: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/sessions\/(\d+)\/suggestions\/(\d+)\/(accept|dismiss)$/)
  if (!match || ctx.method !== 'POST') return undefined
  const sessionId = Number(match[1])
  const suggestionId = Number(match[2])
  const action = match[3]
  const row = findSession(sessionId)
  if (!row) return notFound(`场次 ${sessionId} 不存在`)
  const suggestion = suggestions.find((item) => item.id === suggestionId)
  if (!suggestion) return notFound(`候选 ${suggestionId} 不存在`)

  if (action === 'dismiss') {
    suggestion.state = 'dismissed'
    suggestion.updated_at = Date.now()
    suggestion.expires_at = null
    return json(suggestion)
  }

  if (suggestion.state !== 'pending' && suggestion.state !== 'expired') return badRequest('这条候选已经处理过了')
  const body = (ctx.body ?? {}) as Record<string, any>
  const duration = durationOf(row)
  const inMs = clamp(Number(body.in_ms ?? suggestion.in_ms), 0, duration)
  const outMs = clamp(Number(body.out_ms ?? suggestion.out_ms), 0, duration)
  if (outMs <= inMs) return badRequest('入点必须早于出点')

  const owner = ownerAt(row, inMs)
  const clip = newClip({
    session_id: owner.source,
    view_session_id: row.id,
    source_session_id: owner.source,
    in_ms: Math.round(inMs),
    out_ms: Math.round(outMs),
    title: String(body.title ?? suggestion.title).slice(0, 80),
    state: 'draft',
  })
  clips.push(clip)

  suggestion.state = 'accepted'
  suggestion.clip_id = clip.id
  suggestion.in_ms = Math.round(inMs)
  suggestion.out_ms = Math.round(outMs)
  suggestion.updated_at = Date.now()
  suggestion.expires_at = null
  return json({ suggestion, clip })
}

/** 自动切片连通性测试 */
const autoClipTest: MockHandler = (ctx) => {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/auto-clip/test') return undefined
  return json({
    tested_at: Date.now(),
    chat: { status: 'ok', elapsed_ms: 812, message: 'deepseek-chat 可用', capable: true, http_status: 200 },
    vision: { status: 'warning', elapsed_ms: 1203, message: '模型能连上，但拒收图片', capable: false, http_status: 200 },
    asr: { status: 'ok', elapsed_ms: 1560, message: 'SenseVoiceSmall 可用', capable: true, http_status: 200 },
  })
}

/** 关键帧：回看时用来吸附落刀点，按 60 秒网格给 */
const sessionKeyframes: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/keyframes$/)
  if (!Number.isFinite(id) || ctx.method !== 'GET') return undefined
  const row = findSession(id)
  if (!row) return notFound(`场次 ${id} 不存在`)

  const duration = durationOf(row)
  const rawFrom = Number(ctx.query.get('from') ?? 0)
  const rawTo = Number(ctx.query.get('to') ?? duration)
  const from = Math.max(0, Number.isFinite(rawFrom) ? rawFrom : 0)
  const to = Math.min(duration, Number.isFinite(rawTo) ? rawTo : duration)
  const start = Math.floor(from / MIN) * MIN

  const keyframes: Keyframe[] = []
  const limit = 600
  let truncated = false
  for (let t = start; t <= to; t += MIN) {
    if (keyframes.length >= limit) {
      truncated = true
      break
    }
    const readable = row.segments.find(
      (segment) =>
        (segment.state === 'recording' || segment.state === 'finished' || segment.state === 'pending_delete') &&
        t >= segment.start_ms &&
        t <= (segment.end_ms ?? segment.start_ms),
    )
    if (readable) keyframes.push({ t_ms: t, segment_id: readable.id })
  }
  return json({ keyframes, truncated })
}

/** 缩图（占位 SVG） */
const sessionThumb: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/thumb$/)
  if (!Number.isFinite(id) || ctx.method !== 'GET') return undefined
  const row = findSession(id)
  if (!row) return notFound(`场次 ${id} 不存在`)
  const raw = Number(ctx.query.get('t') ?? 0)
  const atMs = clamp(Number.isFinite(raw) ? raw : 0, 0, durationOf(row))
  return thumbResponse(row, atMs)
}

/** DVR 回看流：演示站没有真实分段文件，统一 415，播放器显示错误态但页面不崩 */
const sessionMedia: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/media$/)
  if (!Number.isFinite(id) || ctx.method !== 'GET') return undefined
  const row = findSession(id)
  if (!row) return notFound(`场次 ${id} 不存在`)
  return text(
    `演示站没有真实的 DVR 回看流：场次 ${id} 的录像文件不在浏览器里（这是 mock 环境，只提供时间轴与切片功能）`,
    415,
  )
}

/** 压制配方（render-settings 是旧路径，读到的是同一份） */
const sessionRecipe: MockHandler = (ctx) => {
  const match = ctx.path.match(/^\/v1\/sessions\/(\d+)\/(render-recipe|render-settings)$/)
  if (!match) return undefined
  const id = Number(match[1])

  if (ctx.method === 'GET') {
    const recipe = recipes.get(id)
    if (recipe) return json(recipe)
    const created = defaultRecipe()
    recipes.set(id, created)
    return json(created)
  }

  if (ctx.method === 'PUT') {
    const body = ctx.body
    if (!body || typeof body !== 'object') return badRequest('压制配方必须是 JSON 对象')
    recipes.set(id, body as RenderRecipe)
    return json(body as RenderRecipe)
  }

  return undefined
}

/** 压制素材列表 / 上传 */
const sessionRenderAssets: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/sessions\/(\d+)\/render-assets$/)
  if (!Number.isFinite(id)) return undefined

  if (ctx.method === 'GET') return json({ assets: assetsFor(id) })

  if (ctx.method === 'POST') {
    const contentType = (ctx.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.startsWith('image/')) return badRequest('只支持 JPEG / PNG / WebP 图片')
    const assetId = assetSeq++
    const asset: RenderAsset = {
      id: assetId,
      width: 320,
      height: 180,
      sha256: fakeSha(assetId),
      url: `/v1/render-assets/${assetId}`,
    }
    assetRegistry.set(asset.id, asset)
    assetsFor(id).push(asset)
    return json(asset, 201)
  }

  return undefined
}

/** 压制素材取图 / 删除 */
const renderAssetItem: MockHandler = (ctx) => {
  const id = idOf(ctx, /^\/v1\/render-assets\/(\d+)$/)
  if (!Number.isFinite(id)) return undefined

  if (ctx.method === 'GET') {
    const asset = assetRegistry.get(id)
    if (!asset) return notFound('素材不存在')
    return uploadedAssetSvg(asset.width, asset.height)
  }

  if (ctx.method === 'DELETE') {
    assetRegistry.delete(id)
    for (const list of renderAssets.values()) {
      const index = list.findIndex((asset) => asset.id === id)
      if (index >= 0) list.splice(index, 1)
    }
    return noContent()
  }

  return undefined
}

/** 服务器上的 ffmpeg 是否可用（精确剪、MP4 转封装要用） */
const toolsStatus: MockHandler = (ctx) => {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/tools') return undefined
  return json({ ffmpeg: { available: true, error: null } })
}

export const sessionHandlers: MockHandler[] = [
  listSessions,
  sessionDetail,
  sessionClips,
  sessionClipItem,
  sessionMarkers,
  sessionMarkerItem,
  sessionAutoClip,
  sessionSuggestions,
  suggestionAction,
  sessionKeyframes,
  sessionThumb,
  sessionMedia,
  sessionRecipe,
  sessionRenderAssets,
  mergeCandidateList,
  mergeGroups,
  mergeCandidateAction,
  autoClipStatus,
  autoClipJobsRoute,
  autoClipTest,
  clipDetail,
  clipExport,
  clipDownload,
  clipCover,
  renderAssetItem,
  toolsStatus,
]

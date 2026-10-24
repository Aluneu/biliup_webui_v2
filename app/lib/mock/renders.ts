// ============================================================================
// Mock：压制任务（renders / 录后合成）
// ----------------------------------------------------------------------------
// 本模块覆盖的接口（全是演示站假数据，写操作会真的改内存里的数组）：
//
//   GET    /v1/renders?state=&session_id=&limit=&offset=   任务列表（过滤 + 分页）
//   GET    /v1/renders/{jid}                               单条任务
//   DELETE /v1/renders/{jid}                               删除任务记录
//   POST   /v1/renders/{jid}/cancel                        取消（queued/running → cancelled）
//   POST   /v1/renders/{jid}/retry                         重试（复制成一条新的 queued）
//   GET    /v1/renders/{jid}/download                      演示站没有真实 MP4，返回 404 文本
//   GET    /v1/sessions/{id}/renders                       某个场次的全部压制任务
//   POST   /v1/sessions/{id}/renders                       整场合成入队（202）
//   GET    /v1/render-gpus                                 GPU 快照（NVENC 机器 + 权限不足的 QSV 核显）
//   GET    /v1/render-tools · /v1/render-capabilities      合成工具 / 编码器自检（两条路由等价）
//   GET    /v1/render-fonts/{id}                           占位字体路由（演示站未内置字体文件）
//   GET    /v1/sessions/{id}/render-assets                 遮挡图片素材列表
//   POST   /v1/sessions/{id}/render-assets                 上传图片（裸 PNG/JPEG body），201 返回 {id}
//   GET    /v1/render-assets/{aid}                         素材二进制（演示站用 SVG 占位图代替）
//   DELETE /v1/render-assets/{aid}                         删除素材
//   POST   /v1/sessions/{id}/render-preview                弹幕 ASS 预览（ass / font_urls / 画幅 / 起点）
//
// 不在本模块（避免和并行的模块重复）：
//   * GET/PUT /v1/sessions/{id}/render-recipe 与 /render-settings → sessions 模块负责；
//   * GET /v1/tools → 核心 / fleet 模块负责；
//   * 场次、切片、投稿等其它接口一概不碰。
//
// 几点设计说明：
//   * 任务列表的 total 就是真实数组长度（37 条），删除 / 新建 / 重试之后 total 会跟着变，
//     所以 /renders 页面翻页、按状态和场次过滤都不会出现「总数 37 但第二页空白」。
//   * 进度模型和真实后端一致：total_ms 是素材时长，ratio = processed_ms / total_ms，
//     speed 是编码倍速，eta_ms = 剩余素材时长 / speed。running 任务的 processed_ms、
//     ratio、eta、已耗时都按真实时钟现算，页面 2 秒轮询一次，进度和剩余时间会真的往前走。
//   * 契约字段以 app/lib/renders.ts 的 RenderJob 为准（file_name / output_bytes / ratio / eta_ms…）；
//     这里额外多给 stage / recipe 摘要 / progress_done / output 摘要，
//     在 DevTools 里能直接看清「这条任务合成了什么、产物是什么」。
//   * 字体：演示站没有随包中文字体文件，所以 render-preview 的 font_urls 返回空数组
//     （前端会跳过字体下载，jassub 用内置回退字体照样画出 ASS 版式）；
//     /v1/render-tools 里按真实契约列出字体地址，/v1/render-fonts/* 返回 404 文本说明情况。
// ============================================================================

import type { MockCtx, MockHandler } from './types'
import { badRequest, json, noContent, notFound, seeded, seededInt, text, uploadedAssetSvg } from './util'
import { nextId } from './state'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type JobState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
/** 合成阶段：音轨 / 视频 / 封装（后端 stage 字段的取值） */
type RenderStage = 'audio' | 'video' | 'mux'
type RenderQuality = 'space_saver' | 'balanced' | 'high_quality'

const JOB_STATES: JobState[] = ['queued', 'running', 'ready', 'failed', 'cancelled']
const QUALITIES: RenderQuality[] = ['space_saver', 'balanced', 'high_quality']

/** 任务里带的 recipe 摘要：一眼看出这条任务压了什么 */
interface RecipeSummary {
  danmaku: boolean
  mask: boolean
  images: number
  quality: RenderQuality
  resolution: string
}

/** 任务所属场次的信息（只读，真实场次接口由 sessions 模块负责） */
interface SessionMeta {
  name: string
  title: string
  width: number
  height: number
}

/** 内存里的任务行；对外的 RenderJob 视图由 jobView() 现算 */
interface JobRow {
  id: number
  session_id: number
  clip_id: number | null
  state: JobState
  stage: RenderStage
  phase: string
  /** 素材总时长（毫秒）：整场就是场次时长，切片就是切片长度 */
  total_ms: number | null
  /** 编码倍速（相对于素材时长），例如 3.2 表示 1 秒能压 3.2 秒素材 */
  encode_speed: number | null
  /** 只用来在「分段」维度上再报一次进度，和 ratio 同步 */
  progress_total: number | null
  error: string | null
  file_name: string | null
  output_bytes: number | null
  duration_ms: number | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  requested_encoder: string
  requested_device: string | null
  encoder: string | null
  encoder_device: string | null
  fallback_reason: string | null
  fps: number | null
  recipe: RecipeSummary
  retry_of?: number
}

interface AssetRow {
  id: number
  session_id: number
  width: number
  height: number
  sha256: string
}

// ---------------------------------------------------------------------------
// 时间常量与场次表
// ---------------------------------------------------------------------------

const NOW = Date.now()
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
/** 任务从入队到真正开始压制的排队时间 */
const QUEUE_DELAY = 6 * SECOND

const FALLBACK_SESSION: SessionMeta = {
  name: '演播室',
  title: '演示场次',
  width: 1920,
  height: 1080,
}

/**
 * 场次 id 锚定：5001 老番茄（正在录制）、5002 影视飓风、5003 午夜琴房、5004 猫猫台；
 * 4901~4906 是已经录完的历史场次。
 */
const SESSIONS: Record<number, SessionMeta> = {
  5001: { name: '老番茄', title: '【实况】今晚通宵打星际，来就完了', width: 1920, height: 1080 },
  5002: { name: '影视飓风', title: '聊聊我们是怎么拍 4K 视频的（含设备清单）', width: 3840, height: 2160 },
  5003: { name: '午夜琴房', title: '深夜钢琴即兴 · 点歌请打在弹幕里', width: 1920, height: 1080 },
  5004: { name: '猫猫台', title: 'rank 冲分，掉段就下播', width: 1920, height: 1080 },
  4901: { name: '水友赛直播间', title: '周末水友赛 第 12 期 · 决赛', width: 1920, height: 1080 },
  4902: { name: '老番茄', title: '【切片】星际争霸名场面合集', width: 1920, height: 1080 },
  4903: { name: '影视飓风', title: '幕后花絮：灯位到底怎么摆', width: 1920, height: 1080 },
  4904: { name: '午夜琴房', title: '凌晨三点的肖邦', width: 1920, height: 1080 },
  4905: { name: '猫猫台', title: '猫咪 ASMR · 只听得见呼噜声', width: 1920, height: 1080 },
  4906: { name: '周末电台', title: '周末电台 第 88 期', width: 1920, height: 1080 },
}

function sessionOf(id: number): SessionMeta {
  const found: SessionMeta | undefined = SESSIONS[id]
  return found ?? { ...FALLBACK_SESSION, name: `场次 #${id}`, title: `场次 #${id}` }
}

function resolutionOf(meta: SessionMeta): string {
  if (meta.height >= 2000) return '2160p'
  if (meta.height >= 1400) return '1440p'
  if (meta.height <= 720) return '720p'
  return '1080p'
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<RenderStage, string> = {
  audio: '压制音频',
  video: '压制视频',
  mux: '封装 MP4',
}

const QUEUE_PHASE = '排队中（等待编码器插槽）'

function phaseOf(state: JobState, stage: RenderStage): string {
  if (state === 'queued') return QUEUE_PHASE
  if (state === 'running') return STAGE_LABEL[stage]
  if (state === 'ready') return '已完成'
  if (state === 'cancelled') return '已取消'
  return `已失败（${STAGE_LABEL[stage]}）`
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 取数值并夹到区间里；拿不到就用默认值 */
function num(value: any, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? clamp(n, min, max) : fallback
}

/**
 * 把种子打散（murmur3 的 finalizer）。
 * util 里的 seededInt 是线性同余，等步长的种子会落在同一段里——用它生成
 * 二十来条历史任务会出现「状态和失败原因几乎一样」的假数据，这里额外混一次。
 */
function mix(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** [min, max) 区间里的稳定整数 */
function pick(seed: number, min: number, max: number): number {
  return min + (mix(seed) % Math.max(1, max - min))
}

/** 2026-10-23 这样的日期串，用来拼产物文件名 */
function stampOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 演示用的假 sha256（64 位十六进制），素材列表里看起来像真的一样 */
function fakeSha(seed: number): string {
  const rnd = seeded(seed)
  let out = ''
  for (let i = 0; i < 32; i++) out += Math.floor(rnd() * 256).toString(16).padStart(2, '0')
  return out
}

// ---------------------------------------------------------------------------
// 任务数据：13 条手工编排（覆盖全部状态与阶段）+ 24 条历史任务（撑起分页）
// ---------------------------------------------------------------------------

interface JobSeed {
  id: number
  session: number
  state: JobState
  stage: RenderStage
  /** 距今多久创建（毫秒） */
  ago: number
  clip?: number | null
  /** 素材时长（毫秒） */
  media_ms?: number | null
  /** 编码倍速；finished 的任务用它反推压制实际耗时 */
  speed?: number | null
  /** 失败 / 取消时：从开始到中断实际花了多久 */
  wall_ms?: number | null
  progress_total?: number | null
  error?: string | null
  file?: string | null
  bytes?: number | null
  duration?: number | null
  fps?: number | null
  requested_encoder?: string
  requested_device?: string | null
  encoder?: string | null
  encoder_device?: string | null
  fallback?: string | null
  recipe?: Partial<RecipeSummary>
  retry_of?: number
}

function makeJob(seed: JobSeed): JobRow {
  const created_at = NOW - seed.ago
  const started_at = seed.state === 'queued' ? null : created_at + QUEUE_DELAY
  const total_ms = seed.media_ms ?? null
  const speed = seed.speed ?? null
  const wall =
    seed.wall_ms ?? (total_ms !== null && speed !== null && speed > 0 ? Math.round(total_ms / speed) : null)
  const finished_at = started_at === null || seed.state === 'running' ? null : started_at + (wall ?? 0)
  const meta = sessionOf(seed.session)
  const recipe: RecipeSummary = {
    danmaku: true,
    mask: false,
    images: 0,
    quality: 'balanced',
    resolution: resolutionOf(meta),
    ...seed.recipe,
  }
  return {
    id: seed.id,
    session_id: seed.session,
    clip_id: seed.clip ?? null,
    state: seed.state,
    stage: seed.stage,
    phase: phaseOf(seed.state, seed.stage),
    total_ms,
    encode_speed: speed,
    progress_total: seed.progress_total ?? null,
    error: seed.error ?? null,
    file_name: seed.file ?? null,
    output_bytes: seed.bytes ?? null,
    duration_ms: seed.duration ?? null,
    created_at,
    started_at,
    finished_at,
    requested_encoder: seed.requested_encoder ?? 'auto',
    requested_device: seed.requested_device ?? null,
    encoder: seed.encoder ?? null,
    encoder_device: seed.encoder_device ?? null,
    fallback_reason: seed.fallback ?? null,
    fps: seed.fps ?? null,
    recipe,
    retry_of: seed.retry_of,
  }
}

const CURATED: JobSeed[] = [
  // ---- running：三条，分别在音频 / 视频 / 封装阶段；进度随真实时钟往前走 ----
  {
    id: 9001,
    session: 5001,
    state: 'running',
    stage: 'video',
    ago: 6 * MINUTE,
    clip: 771,
    // 25 分钟的高光切片，NVENC 大约 1.9 倍速：已经压了 6 分钟，四成多
    media_ms: 1_500_000,
    speed: 1.9,
    progress_total: 8,
    fps: 114.0,
    requested_encoder: 'h264_nvenc',
    requested_device: '0',
    encoder: 'h264_nvenc',
    encoder_device: '0',
    recipe: { danmaku: true, mask: true, images: 2, quality: 'high_quality' },
  },
  {
    id: 9002,
    session: 5002,
    state: 'running',
    stage: 'audio',
    ago: 9 * MINUTE,
    // 4K 整场：音轨提取比视频快，QSV 权限不足后视频走 CPU 兜底
    media_ms: 8_460_000,
    speed: 3.5,
    progress_total: 40,
    fps: null,
    requested_encoder: 'h264_qsv',
    requested_device: '/dev/dri/renderD129',
    encoder: 'libx264',
    encoder_device: null,
    fallback: 'GPU 编码器初始化失败，已回退 CPU（h264_qsv → libx264，8 线程）',
    recipe: { danmaku: true, mask: false, images: 0, quality: 'high_quality' },
  },
  {
    id: 9003,
    session: 5003,
    state: 'running',
    stage: 'mux',
    ago: 28 * MINUTE,
    clip: 782,
    // 4 小时的整场，前两个阶段已完成，正在封装最后几个分段
    media_ms: 14_400_000,
    speed: 6.0,
    progress_total: 6,
    fps: null,
    requested_encoder: 'auto',
    encoder: 'h264_nvenc',
    encoder_device: '0',
    recipe: { danmaku: true, mask: true, images: 1, quality: 'balanced' },
  },

  // ---- queued：两条，一条带图片遮挡、一条纯弹幕 ----
  {
    id: 9004,
    session: 5004,
    state: 'queued',
    stage: 'audio',
    ago: 90 * SECOND,
    clip: 795,
    media_ms: 1_260_000,
    requested_encoder: 'auto',
    recipe: { danmaku: false, mask: true, images: 1, quality: 'space_saver' },
  },
  {
    id: 9005,
    session: 5001,
    state: 'queued',
    stage: 'audio',
    ago: 40 * SECOND,
    clip: 796,
    media_ms: 620_000,
    requested_encoder: 'h264_nvenc',
    requested_device: '0',
    recipe: { danmaku: true, mask: true, images: 3, quality: 'balanced' },
  },

  // ---- ready：已完成，带产物文件名 / 体积 / 时长 ----
  {
    id: 9006,
    session: 5001,
    state: 'ready',
    stage: 'mux',
    ago: 42 * MINUTE,
    clip: 765,
    file: 'patch_2026-10-23_老番茄_开场三分钟翻车.mp4',
    bytes: 1_284_325_376,
    media_ms: 3_720_000,
    duration: 3_720_000,
    speed: 4.0,
    fps: 118.2,
    requested_encoder: 'h264_nvenc',
    requested_device: '0',
    encoder: 'h264_nvenc',
    encoder_device: '0',
    recipe: { danmaku: true, mask: true, images: 2, quality: 'high_quality' },
  },
  {
    id: 9007,
    session: 5002,
    state: 'ready',
    stage: 'mux',
    ago: 1.6 * HOUR,
    file: 'patch_2026-10-23_影视飓风_4K机位走位实拍.mp4',
    bytes: 6_871_947_264,
    media_ms: 8_460_000,
    duration: 8_460_000,
    speed: 3.2,
    fps: 30.4,
    requested_encoder: 'auto',
    encoder: 'h264_nvenc',
    encoder_device: '0',
    recipe: { danmaku: true, mask: true, images: 0, quality: 'high_quality' },
  },

  // ---- failed：一条弹幕字体缺失、一条写盘空间不足 ----
  {
    id: 9008,
    session: 5001,
    state: 'failed',
    stage: 'video',
    ago: 2.2 * HOUR,
    clip: 756,
    media_ms: 1_920_000,
    speed: 1.8,
    wall_ms: 96_000,
    requested_encoder: 'h264_nvenc',
    requested_device: '0',
    encoder: null,
    error: '弹幕字体文件缺失：render-fonts 目录为空，ASS 生成失败，请安装随包字体后重试',
    recipe: { danmaku: true, mask: false, images: 0, quality: 'balanced' },
  },
  {
    id: 9009,
    session: 4901,
    state: 'failed',
    stage: 'mux',
    ago: 3.6 * HOUR,
    media_ms: 14_400_000,
    speed: 5.5,
    wall_ms: 780_000,
    requested_encoder: 'auto',
    encoder: 'h264_nvenc',
    encoder_device: '0',
    error: '封装 MP4 失败：输出目录剩余空间不足（需要 4.8 GiB，可用 1.2 GiB）',
    recipe: { danmaku: true, mask: true, images: 1, quality: 'balanced' },
  },

  // ---- cancelled ----
  {
    id: 9010,
    session: 5004,
    state: 'cancelled',
    stage: 'video',
    ago: 5 * HOUR,
    clip: 744,
    media_ms: 2_400_000,
    speed: 1.2,
    wall_ms: 64_000,
    requested_encoder: 'auto',
    encoder: 'libx264',
    error: '已由用户取消',
    recipe: { danmaku: true, mask: false, images: 0, quality: 'space_saver' },
  },
  {
    id: 9013,
    session: 5003,
    state: 'cancelled',
    stage: 'audio',
    ago: 31 * HOUR,
    clip: 731,
    media_ms: 3_600_000,
    speed: 8.0,
    wall_ms: 30_000,
    requested_encoder: 'auto',
    encoder: null,
    error: '已由用户取消',
    recipe: { danmaku: false, mask: false, images: 0, quality: 'balanced' },
  },

  // ---- 历史 ready：既有 NVENC 整场，也有 CPU 兜底压出来的 ----
  {
    id: 9011,
    session: 4902,
    state: 'ready',
    stage: 'mux',
    ago: 7 * HOUR,
    clip: 738,
    file: 'patch_2026-10-23_老番茄_星际名场面合集.mp4',
    bytes: 2_147_483_648,
    media_ms: 5_400_000,
    duration: 5_400_000,
    speed: 3.0,
    fps: 89.4,
    requested_encoder: 'libx264',
    encoder: 'libx264',
    encoder_device: null,
    fallback: 'GPU 编码器初始化失败，已回退 CPU（h264_nvenc → libx264，8 线程）',
    recipe: { danmaku: true, mask: true, images: 2, quality: 'balanced' },
  },
  {
    id: 9012,
    session: 4903,
    state: 'ready',
    stage: 'mux',
    ago: 26 * HOUR,
    file: 'patch_2026-10-22_影视飓风_幕后花絮灯位怎么摆.mp4',
    bytes: 943_718_400,
    media_ms: 2_880_000,
    duration: 2_880_000,
    speed: 7.2,
    fps: 172.8,
    requested_encoder: 'h264_nvenc',
    requested_device: '0',
    encoder: 'h264_nvenc',
    encoder_device: '0',
    recipe: { danmaku: false, mask: true, images: 1, quality: 'balanced' },
  },
]

/** 历史任务的失败原因模板：填上分段号 / 行号，避免十来条任务用同一句话 */
const FILLER_ERRORS = [
  '拉取分段超时：分段 #{seg} 校验失败，任务中断',
  '弹幕 XML 解析失败：第 {line} 行时间戳越界',
  '编码器输出为空：ffmpeg 退出码 1（分段 #{seg}，内存不足）',
  '封装 MP4 失败：输出目录剩余空间不足（需要 {gb} GiB，可用 {free} GiB）',
  '弹幕字体文件缺失：render-fonts 目录为空，ASS 生成失败',
  '音画时长不一致：视频分段 #{seg} 比音频长 {delta} ms，已中止合成',
]

function fillError(seed: number): string {
  return FILLER_ERRORS[pick(seed, 0, FILLER_ERRORS.length)]
    .replace('{seg}', String(pick(seed + 1, 9000, 9100)))
    .replace('{line}', String(pick(seed + 2, 120, 999)))
    .replace('{gb}', String(pick(seed + 3, 4, 9)))
    .replace('{free}', (pick(seed + 4, 2, 30) / 10).toFixed(1))
    .replace('{delta}', String(pick(seed + 5, 40, 900)))
}

/** 历史任务：够多才有第二页（25 条/页），内容也各不相同 */
const FILLER_TOTAL = 24
const FILLER_FIRST_ID = 9014
const FILLER_SESSIONS = [4901, 4902, 4903, 4904, 4905, 4906, 5001, 5002, 5003, 5004]
const FILLER_SUFFIX = ['整场回放', '名场面合集', '弹幕增强版', '高光时刻', '开场三十分钟', '下播前的最后一小时']

function fillerJobs(): JobRow[] {
  const rows: JobRow[] = []
  for (let i = 0; i < FILLER_TOTAL; i++) {
    const seed = mix(i * 7919 + 1301)
    const session = FILLER_SESSIONS[pick(seed, 0, FILLER_SESSIONS.length)]
    const meta = sessionOf(session)
    const ago = 38 * HOUR + i * 7 * HOUR + pick(seed + 1, 0, 50) * MINUTE
    const created = NOW - ago
    const roll = pick(seed + 2, 0, 100)
    const state: JobState = roll < 62 ? 'ready' : roll < 82 ? 'failed' : 'cancelled'
    const stage: RenderStage = state === 'ready' ? 'mux' : roll < 88 ? 'video' : 'audio'
    const hw = pick(seed + 3, 0, 100) < 58
    const media = (20 + pick(seed + 4, 0, 160)) * MINUTE
    const speed = round1(1.8 + pick(seed + 5, 0, 17) / 10)
    const fallback =
      !hw && pick(seed + 9, 0, 2) === 0
        ? 'GPU 编码器初始化失败，已回退 CPU（h264_nvenc → libx264）'
        : null
    rows.push(
      makeJob({
        id: FILLER_FIRST_ID + i,
        session,
        state,
        stage,
        ago,
        clip: pick(seed + 14, 0, 3) === 0 ? null : pick(seed + 15, 700, 800),
        media_ms: media,
        speed,
        wall_ms: state === 'ready' ? undefined : pick(seed + 16, 40, 600) * SECOND,
        file:
          state === 'ready'
            ? `patch_${stampOf(created)}_${meta.name}_${FILLER_SUFFIX[pick(seed + 8, 0, FILLER_SUFFIX.length)]}.mp4`
            : null,
        bytes: state === 'ready' ? Math.round((media / 1000) * pick(seed + 7, 1_400_000, 3_600_000)) : null,
        duration: state === 'ready' ? media : null,
        fps: round1(44 + pick(seed + 6, 0, 190) / 10),
        requested_encoder: hw ? 'h264_nvenc' : 'libx264',
        requested_device: hw ? '0' : null,
        encoder: hw ? 'h264_nvenc' : 'libx264',
        encoder_device: hw ? '0' : null,
        fallback,
        error:
          state === 'failed' ? fillError(seed + 17) : state === 'cancelled' ? '已由用户取消' : null,
        recipe: {
          danmaku: pick(seed + 10, 0, 100) < 78,
          mask: pick(seed + 11, 0, 100) < 55,
          images: pick(seed + 12, 0, 4),
          quality: QUALITIES[pick(seed + 13, 0, QUALITIES.length)],
        },
      })
    )
  }
  return rows
}

/** 任务表（内存态）：写操作都改这个数组 */
const JOBS: JobRow[] = [...CURATED.map(makeJob), ...fillerJobs()]

function jobById(id: number): JobRow | undefined {
  return JOBS.find((row) => row.id === id)
}

function sortedJobs(rows: JobRow[]): JobRow[] {
  return [...rows].sort((a, b) => b.created_at - a.created_at || b.id - a.id)
}

function jobsOfSession(sessionId: number): JobRow[] {
  return sortedJobs(JOBS.filter((row) => row.session_id === sessionId))
}

// ---------------------------------------------------------------------------
// 对外的 RenderJob 视图：进度、耗时、速度、ETA 全部按当前时钟现算
// ---------------------------------------------------------------------------

function jobView(row: JobRow, now: number): Record<string, any> {
  const meta = sessionOf(row.session_id)
  const started = row.started_at
  const finished = row.finished_at
  const total = row.total_ms
  const nominal = row.encode_speed

  let elapsed = 0
  let processed: number | null = null
  let ratio: number | null = null
  let speed: number | null = nominal
  let eta: number | null = null

  if (row.state === 'queued') {
    speed = null
  } else if (row.state === 'running') {
    elapsed = started === null ? 0 : Math.max(0, now - started)
    if (total !== null && nominal !== null && nominal > 0) {
      processed = Math.min(total, Math.round(elapsed * nominal))
      ratio = clamp(processed / total, 0, 0.99)
      eta = Math.round((total - processed) / nominal)
    }
  } else {
    // ready / failed / cancelled：按「开始 → 结束」的实际墙钟算
    elapsed = started !== null && finished !== null ? Math.max(0, finished - started) : 0
    if (total !== null) {
      processed =
        row.state === 'ready'
          ? total
          : elapsed > 0 && nominal !== null
            ? Math.min(total, Math.round(elapsed * nominal))
            : null
    }
    if (row.state === 'ready') ratio = 1
    if (elapsed > 0 && processed !== null) speed = round2(processed / elapsed)
  }

  const done =
    ratio !== null && row.progress_total !== null
      ? clamp(Math.round(ratio * row.progress_total), 0, row.progress_total)
      : null

  return {
    id: row.id,
    session_id: row.session_id,
    clip_id: row.clip_id,
    // —— 契约字段（app/lib/renders.ts 的 RenderJob）——
    file_name: row.file_name,
    state: row.state,
    phase: row.phase,
    ratio: ratio === null ? null : round2(ratio),
    error: row.error,
    output_bytes: row.output_bytes,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    download_url: row.state === 'ready' ? `/v1/renders/${row.id}/download` : null,
    requested_encoder: row.requested_encoder,
    requested_device: row.requested_device,
    encoder: row.encoder,
    encoder_device: row.encoder_device,
    fallback_reason: row.fallback_reason,
    fps: row.state === 'queued' ? null : row.fps,
    speed: speed === null ? null : round1(speed),
    processed_ms: processed,
    total_ms: total,
    started_at: row.started_at,
    finished_at: row.finished_at,
    elapsed_ms: Math.round(elapsed),
    eta_ms: eta,
    updated_at: row.finished_at ?? now,
    session_name: meta.name,
    session_title: meta.title,
    // —— 演示站多加的说明性字段 ——
    stage: row.stage,
    progress_done: done,
    progress_total: row.progress_total,
    recipe: row.recipe,
    output:
      row.state === 'ready' && row.file_name
        ? { file_name: row.file_name, bytes: row.output_bytes ?? 0, duration_ms: row.duration_ms ?? 0 }
        : null,
    retry_of: row.retry_of ?? null,
  }
}

// ---------------------------------------------------------------------------
// 分页 / 过滤
// ---------------------------------------------------------------------------

function pageOf(ctx: MockCtx): { limit: number; offset: number } {
  const rawLimit = Number(ctx.query.get('limit') ?? '')
  const rawOffset = Number(ctx.query.get('offset') ?? '')
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(clamp(rawLimit, 1, 100)) : 25
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

function filteredJobs(ctx: MockCtx): JobRow[] {
  const rawState = (ctx.query.get('state') ?? '').trim()
  const state = JOB_STATES.find((item) => item === rawState)
  const rawSession = Number(ctx.query.get('session_id') ?? '')
  const sessionId = Number.isFinite(rawSession) && rawSession > 0 ? rawSession : null
  return sortedJobs(
    JOBS.filter((row) => (!state || row.state === state) && (sessionId === null || row.session_id === sessionId))
  )
}

// ---------------------------------------------------------------------------
// 写操作：取消 / 重试 / 删除 / 新建
// ---------------------------------------------------------------------------

function cancelJob(row: JobRow, now: number): JobRow {
  if (row.state === 'queued' || row.state === 'running') {
    row.state = 'cancelled'
    row.phase = phaseOf('cancelled', row.stage)
    row.error = '已由用户取消'
    row.finished_at = now
  }
  return row
}

/** 重试：复制成一条全新的 queued 任务，配置原样带过去，失败原因清空 */
function retryJob(source: JobRow): JobRow {
  const now = Date.now()
  const row: JobRow = {
    ...source,
    id: nextId(JOBS),
    state: 'queued',
    stage: 'audio',
    phase: phaseOf('queued', 'audio'),
    progress_total: null,
    error: null,
    file_name: null,
    output_bytes: null,
    duration_ms: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    encoder: null,
    encoder_device: null,
    fallback_reason: null,
    fps: null,
    recipe: { ...source.recipe },
    retry_of: source.id,
  }
  JOBS.push(row)
  return row
}

/** 从请求体里的 recipe 归纳出一份摘要（字段缺省也安全） */
function recipeSummary(recipe: any, meta: SessionMeta): RecipeSummary {
  const regions: any[] = Array.isArray(recipe?.regions) ? recipe.regions : []
  const rawQuality = recipe?.encoding?.quality
  const quality: RenderQuality =
    rawQuality === 'space_saver' || rawQuality === 'high_quality' ? rawQuality : 'balanced'
  return {
    danmaku: recipe?.danmaku?.enabled === true,
    mask: regions.length > 0,
    images: regions.filter((item) => item && item.asset_id !== null && item.asset_id !== undefined).length,
    quality,
    resolution: resolutionOf(meta),
  }
}

function createJob(sessionId: number, body: any): JobRow {
  const meta = sessionOf(sessionId)
  const rawEncoder = body?.recipe?.encoding?.encoder
  const rawDevice = body?.recipe?.encoding?.device
  const clipId =
    typeof body?.clip_id === 'number' && Number.isFinite(body.clip_id) ? body.clip_id : null
  const row: JobRow = {
    id: nextId(JOBS),
    session_id: sessionId,
    clip_id: clipId,
    state: 'queued',
    stage: 'audio',
    phase: phaseOf('queued', 'audio'),
    // 新建时还没有探测素材时长，后端也是任务开始后才填
    total_ms: null,
    encode_speed: null,
    progress_total: null,
    error: null,
    file_name: null,
    output_bytes: null,
    duration_ms: null,
    created_at: Date.now(),
    started_at: null,
    finished_at: null,
    requested_encoder: typeof rawEncoder === 'string' && rawEncoder ? rawEncoder : 'auto',
    requested_device: typeof rawDevice === 'string' && rawDevice ? rawDevice : null,
    encoder: null,
    encoder_device: null,
    fallback_reason: null,
    fps: null,
    recipe: recipeSummary(body?.recipe, meta),
  }
  JOBS.push(row)
  return row
}

// ---------------------------------------------------------------------------
// GPU 快照与合成工具自检
// ---------------------------------------------------------------------------

/** 让利用率随采样时间轻微抖动，曲线看起来是活的 */
function jitter(base: number, now: number, amplitude: number, periodMs = 9000): number {
  const wave = Math.sin((now / periodMs) * Math.PI * 2)
  return round1(base + wave * amplitude)
}

function gpuSnapshot(now: number): Record<string, any> {
  return {
    devices: [
      {
        id: 'nvidia:0',
        name: 'NVIDIA GeForce RTX 4070',
        vendor: 'nvidia',
        render_node: '/dev/dri/renderD128',
        utilization_percent: jitter(63.5, now, 6),
        encoder_utilization_percent: jitter(41, now, 9),
        memory_used_bytes: 3_221_225_472 + Math.round(jitter(120, now, 60) * 1024 * 1024),
        memory_total_bytes: 12_884_901_888,
        error: null,
        engine_utilization: [
          { name: '3D', utilization_percent: jitter(63.5, now, 6) },
          { name: 'Encoder', utilization_percent: jitter(41, now, 9) },
          { name: 'Copy', utilization_percent: jitter(4.2, now, 2, 15000) },
        ],
        memory_kind: 'dedicated',
        memory_source: 'nvidia-smi',
      },
      {
        id: 'intel:0',
        name: 'Intel UHD Graphics 770',
        vendor: 'intel',
        render_node: '/dev/dri/renderD129',
        utilization_percent: null,
        encoder_utilization_percent: null,
        memory_used_bytes: 536_870_912,
        memory_total_bytes: null,
        error: 'QSV 编码器初始化失败：/dev/dri/renderD129 权限不足（需要 video 组），压制已改用 NVENC',
        engine_utilization: [
          { name: 'Video', utilization_percent: null },
          { name: 'Render/3D', utilization_percent: null },
        ],
        memory_kind: 'shared',
        memory_source: null,
      },
    ],
    sampled_at: Math.floor(now / 2000) * 2000,
  }
}

/** 随包字体：演示站没有真实字体文件，地址按契约列出，实际请求返回 404 文本 */
const FONT_URLS = ['/v1/render-fonts/NotoSansCJKsc-Regular.otf']

function renderTools(): Record<string, any> {
  return {
    tools: {
      available: true,
      ffmpeg: true,
      libass: true,
      libx264: true,
      danmaku_factory: true,
      font: true,
      error: null,
      // 编码器自检：NVENC 可用；QSV 有设备节点但权限不足；VAAPI / AMF 不适用；CPU 兜底
      encoders: [
        {
          name: 'h264_nvenc',
          label: 'NVIDIA NVENC · RTX 4070',
          available: true,
          device: '0',
          error: null,
        },
        {
          name: 'h264_qsv',
          label: 'Intel Quick Sync · UHD 770',
          available: false,
          device: '/dev/dri/renderD129',
          error: 'QSV 初始化失败：/dev/dri/renderD129 权限不足（需要把运行用户加入 video 组），可改用 NVENC 或 CPU 编码',
        },
        {
          name: 'h264_vaapi',
          label: 'VAAPI · /dev/dri/renderD128',
          available: false,
          device: '/dev/dri/renderD128',
          error: '未找到可用的 VAAPI 设备节点 /dev/dri/renderD128',
        },
        {
          name: 'h264_amf',
          label: 'AMD AMF（仅 Windows）',
          available: false,
          device: null,
          error: '当前系统为 Linux，AMF 适配器不可用',
        },
        {
          name: 'libx264',
          label: 'CPU · libx264（8 线程）',
          available: true,
          device: null,
          error: null,
        },
      ],
    },
    font_urls: FONT_URLS,
  }
}

// ---------------------------------------------------------------------------
// 遮挡图片素材（裸 PNG / JPEG 上传，读回来是 SVG 占位图）
// ---------------------------------------------------------------------------

const ASSETS: AssetRow[] = [
  { id: 6101, session_id: 5001, width: 480, height: 270, sha256: fakeSha(6101) },
  { id: 6102, session_id: 5001, width: 200, height: 200, sha256: fakeSha(6102) },
  { id: 6103, session_id: 5002, width: 640, height: 360, sha256: fakeSha(6103) },
  { id: 6104, session_id: 5004, width: 320, height: 180, sha256: fakeSha(6104) },
]

function assetView(asset: AssetRow): Record<string, any> {
  return {
    id: asset.id,
    width: asset.width,
    height: asset.height,
    sha256: asset.sha256,
    url: `/v1/render-assets/${asset.id}`,
  }
}

function sessionAssets(sessionId: number): AssetRow[] {
  return ASSETS.filter((asset) => asset.session_id === sessionId)
}

// ---------------------------------------------------------------------------
// 弹幕 ASS 预览
// ---------------------------------------------------------------------------

const DANMAKU_SAMPLES = [
  '来了来了',
  '这波操作可以的',
  '前面的让让，让我看第一视角',
  '哈哈哈这也行',
  '主播今天状态不错',
  '666',
  '前方高能，弹幕护体',
  '名场面预定',
  '这个 BGM 叫什么名字',
  '刚下班，蹲一个',
  '手速太顶了吧',
  '这波直接封神',
  '别抖了，镜头糊了',
  '要重播看十遍',
  '解说别停，继续',
]

/** ASS 时间戳：H:MM:SS.cc */
function assTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const centis = Math.floor((total % 1000) / 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`
}

interface AssLine {
  start: number
  end: number
  text: string
}

function buildAss(opts: {
  title: string
  width: number
  height: number
  font: string
  size: number
  opacity: number
  outline: number
  lines: AssLine[]
}): string {
  // ASS 颜色是 &HAABBGGRR，AA=00 不透明、FF 全透明
  const alpha = Math.round(clamp(1 - opts.opacity, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
  const head = [
    '[Script Info]',
    `Title: 弹幕预览 · ${opts.title}`,
    'ScriptType: v4.00+',
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Danmaku,${opts.font},${opts.size},&H${alpha}FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${opts.outline},1,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const body = opts.lines.map(
    (line) => `Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Danmaku,,0,0,0,,${line.text}`
  )
  return [...head, ...body].join('\n')
}

function previewPayload(sessionId: number, body: any): Record<string, any> {
  const meta = sessionOf(sessionId)
  const d = body?.recipe?.danmaku ?? {}
  const from = num(body?.from_ms, 0, 0, Number.MAX_SAFE_INTEGER)
  const to = num(body?.to_ms, from + 5 * MINUTE, from + 1000, Number.MAX_SAFE_INTEGER)
  const span = Math.max(1000, to - from)
  const enabled = d.enabled === true
  const font = typeof d.font === 'string' && d.font.trim() ? d.font : 'Noto Sans CJK SC'
  const size = Math.round(num(d.font_size, 38, 8, 200))
  const opacity = num(d.opacity, 0.8, 0, 1)
  const outline = num(d.outline, 2, 0, 4)
  const scrollSeconds = num(d.scroll_seconds, 12, 2, 60)

  // 窗口内的真实弹幕条数（只抽样写 24 条进 ASS，避免预览请求体无谓变大）
  const commentCount = enabled
    ? Math.max(0, Math.round((span / 1000) * (1.6 + seededInt(sessionId + from, 0, 24) / 10)))
    : 0
  const shown = Math.min(24, commentCount)
  const lines: AssLine[] = []
  if (shown > 0) {
    const room = Math.max(0, span - scrollSeconds * 1000)
    const offsetSeed = sessionId + Math.floor(from / 1000)
    for (let i = 0; i < shown; i++) {
      const start = shown === 1 ? 0 : Math.round((room * i) / (shown - 1))
      lines.push({
        start,
        end: start + scrollSeconds * 1000,
        text: DANMAKU_SAMPLES[(i * 7 + offsetSeed) % DANMAKU_SAMPLES.length],
      })
    }
  }

  return {
    ass: buildAss({
      title: meta.title,
      width: meta.width,
      height: meta.height,
      font,
      size,
      opacity,
      outline,
      lines,
    }),
    // 演示站不带真实字体文件：这里不给地址，前端直接跳过字体下载（jassub 用内置回退字体）
    font_urls: [] as string[],
    width: meta.width,
    height: meta.height,
    origin_ms: from,
    // 还在录制的场次，弹幕时间轴是估算的（前端会提示「历史弹幕使用估算起点」）
    estimated_timing: sessionId === 5001,
    comment_count: commentCount,
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const P_RENDERS = '/v1/renders'
const P_RENDERS_ONE = /^\/v1\/renders\/(\d+)$/
const P_RENDERS_ACTION = /^\/v1\/renders\/(\d+)\/(cancel|retry)$/
const P_RENDERS_DOWNLOAD = /^\/v1\/renders\/(\d+)\/download$/
const P_SESSION_RENDERS = /^\/v1\/sessions\/(\d+)\/renders$/
const P_SESSION_ASSETS = /^\/v1\/sessions\/(\d+)\/render-assets$/
const P_SESSION_PREVIEW = /^\/v1\/sessions\/(\d+)\/render-preview$/
const P_ASSET_ONE = /^\/v1\/render-assets\/(\d+)$/
const P_FONT_ONE = /^\/v1\/render-fonts\/([^/]+)$/

export const renderHandlers: MockHandler[] = [
  // GET /v1/renders?state=&session_id=&limit=&offset= —— 压制任务页的主列表
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== P_RENDERS) return undefined
    const rows = filteredJobs(ctx)
    const { limit, offset } = pageOf(ctx)
    const now = Date.now()
    return json({
      jobs: rows.slice(offset, offset + limit).map((row) => jobView(row, now)),
      total: rows.length,
      limit,
      offset,
    })
  },

  // GET /v1/renders/{jid} —— 单条任务
  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    const m = ctx.path.match(P_RENDERS_ONE)
    if (!m) return undefined
    const row = jobById(Number(m[1]))
    return row ? json(jobView(row, Date.now())) : notFound(`压制任务 #${m[1]} 不存在`)
  },

  // GET /v1/renders/{jid}/download —— 演示站没有真实 MP4，返回 404 文本
  (ctx) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return undefined
    const m = ctx.path.match(P_RENDERS_DOWNLOAD)
    if (!m) return undefined
    const row = jobById(Number(m[1]))
    if (!row) return text(`压制任务 #${m[1]} 不存在`, 404)
    const attachment = ctx.query.get('attachment') === 'true' ? '（attachment 下载）' : ''
    return text(
      [
        `演示站没有真实的 MP4 产物：压制任务 #${row.id} 的 ${row.file_name ?? '输出文件'} 只是假数据${attachment}。`,
        '真实部署里这条请求会返回可播放的 MP4 流（?attachment=true 时作为附件下载）。',
      ].join('\n'),
      404
    )
  },

  // DELETE /v1/renders/{jid} —— 删除任务记录
  (ctx) => {
    if (ctx.method !== 'DELETE') return undefined
    const m = ctx.path.match(P_RENDERS_ONE)
    if (!m) return undefined
    const index = JOBS.findIndex((row) => row.id === Number(m[1]))
    if (index < 0) return notFound(`压制任务 #${m[1]} 不存在`)
    JOBS.splice(index, 1)
    return noContent()
  },

  // POST /v1/renders/{jid}/cancel · /retry —— 写操作真的改内存
  (ctx) => {
    if (ctx.method !== 'POST') return undefined
    const m = ctx.path.match(P_RENDERS_ACTION)
    if (!m) return undefined
    const row = jobById(Number(m[1]))
    if (!row) return notFound(`压制任务 #${m[1]} 不存在`)
    const now = Date.now()
    if (m[2] === 'cancel') return json(jobView(cancelJob(row, now), now))
    return json(jobView(retryJob(row), now), 202)
  },

  // GET /v1/sessions/{id}/renders —— 回看页「合成任务」列表（2 秒轮询）
  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    const m = ctx.path.match(P_SESSION_RENDERS)
    if (!m) return undefined
    const now = Date.now()
    return json({ jobs: jobsOfSession(Number(m[1])).map((row) => jobView(row, now)) })
  },

  // POST /v1/sessions/{id}/renders —— 整场合成入队，202 + 新的排队任务
  (ctx) => {
    if (ctx.method !== 'POST') return undefined
    const m = ctx.path.match(P_SESSION_RENDERS)
    if (!m) return undefined
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {}
    const row = createJob(Number(m[1]), body)
    return json(jobView(row, Date.now()), 202)
  },

  // GET /v1/render-gpus —— GPU 卡片（2 秒轮询，利用率随时间轻微抖动）
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/render-gpus') return undefined
    return json(gpuSnapshot(Date.now()))
  },

  // GET /v1/render-tools · /v1/render-capabilities —— 两条路由等价
  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    if (ctx.path !== '/v1/render-tools' && ctx.path !== '/v1/render-capabilities') return undefined
    return json(renderTools())
  },

  // GET /v1/render-fonts/{id} —— 占位字体路由：演示站没有字体文件，明确返回 404 文本
  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    const m = ctx.path.match(P_FONT_ONE)
    if (!m) return undefined
    return text(
      `演示站未内置随包字体文件：/v1/render-fonts/${m[1]} 只是占位路由。\n真实部署里这里返回字体二进制，供弹幕预览渲染 ASS。`,
      404
    )
  },

  // GET /v1/sessions/{id}/render-assets —— 遮挡图片素材列表
  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    const m = ctx.path.match(P_SESSION_ASSETS)
    if (!m) return undefined
    return json({ assets: sessionAssets(Number(m[1])).map(assetView) })
  },

  // POST /v1/sessions/{id}/render-assets —— 裸 PNG/JPEG body，201 返回素材信息
  (ctx) => {
    if (ctx.method !== 'POST') return undefined
    const m = ctx.path.match(P_SESSION_ASSETS)
    if (!m) return undefined
    const sessionId = Number(m[1])
    const contentType = (ctx.headers.get('Content-Type') ?? '').toLowerCase()
    if (contentType && !contentType.startsWith('image/')) {
      return badRequest('只支持 PNG / JPEG 图片素材')
    }
    const id = nextId(ASSETS)
    // 演示站不解析图片头（body 是 File/Blob，同步拿不到尺寸），统一按 16:9 缩略图记录
    const asset: AssetRow = {
      id,
      session_id: sessionId,
      width: 320,
      height: 180,
      sha256: fakeSha(id),
    }
    ASSETS.push(asset)
    return json(assetView(asset), 201)
  },

  // GET /v1/render-assets/{aid} —— 素材二进制：演示站用 SVG 占位图代替
  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    const m = ctx.path.match(P_ASSET_ONE)
    if (!m) return undefined
    const asset = ASSETS.find((row) => row.id === Number(m[1]))
    if (!asset) return notFound(`图片素材 #${m[1]} 不存在`)
    return uploadedAssetSvg(asset.width, asset.height)
  },

  // DELETE /v1/render-assets/{aid} —— 删除素材
  (ctx) => {
    if (ctx.method !== 'DELETE') return undefined
    const m = ctx.path.match(P_ASSET_ONE)
    if (!m) return undefined
    const index = ASSETS.findIndex((row) => row.id === Number(m[1]))
    if (index < 0) return notFound(`图片素材 #${m[1]} 不存在`)
    ASSETS.splice(index, 1)
    return noContent()
  },

  // POST /v1/sessions/{id}/render-preview —— 弹幕 ASS 预览
  (ctx) => {
    if (ctx.method !== 'POST') return undefined
    const m = ctx.path.match(P_SESSION_PREVIEW)
    if (!m) return undefined
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {}
    return json(previewPayload(Number(m[1]), body))
  },
]

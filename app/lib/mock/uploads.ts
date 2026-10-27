// ============================================================================
// Mock：投稿模板 / 手动投稿 / 发布队列 / 上传队列 / 录播文件 / B 站稿件
// ----------------------------------------------------------------------------
// 覆盖（`mock/index.ts` 路由链里的 `uploadHandlers`；插在 sessions / renders 之后、
// core 之前，因此这里只接自己的路径，其余一律 `return undefined` 交给下一个处理器）：
//
//   投稿模板  GET    /v1/upload/streamers
//             GET    /v1/upload/streamers/{id}
//             POST   /v1/upload/streamers             直接读 db.templates
//             PUT    /v1/upload/streamers/{id}
//             DELETE /v1/upload/streamers/{id}
//   手动投稿  POST   /v1/uploads                       把选中的录播文件排进上传队列
//   发布队列  GET    /v1/publish-jobs[?session={id}]
//             POST   /v1/publish-jobs                 集中发布，返回 {jobs, skipped}
//             POST   /v1/publish-jobs/preview          返回 {archives: PreviewArchive[]}
//             GET    /v1/publish-jobs/{id}
//             POST   /v1/publish-jobs/resume           B 站 601 暂停后继续整个队列
//             POST   /v1/publish-jobs/{id}/retry
//             DELETE /v1/publish-jobs/{id}             排队中的移出队列 / 进行中的取消
//             POST   /v1/clips/{id}/publish            单切片发布（同样是 Enqueued）
//   上传队列  GET    /v1/upload-queue?source=&state=&limit=&offset=
//             GET    /v1/upload-queue/{id}             带上 files[] 明细
//   录播文件  GET    /v1/videos                       直接返回 db.videos（原数组）
//             GET    /v1/files/location?kind=recording&file_name=…（或 kind=render&id=…、?path=…）
//             POST   /v1/files/reveal
//   B 站稿件  GET    /v1/users/{id}/archives?status=&from_page=&max_pages=
//   账号/分区 GET    /v1/users、POST /v1/users、DELETE /v1/users/{id}、
//             GET    /v1/users/{id}（昵称 / 头像）、GET /bili/archive/pre（投稿分区树）
//
// 字段与枚举一律照前端类型来（../api-streamer.ts、../publish.ts、../upload-queue.ts）：
// 上传队列的 source/state 用界面上真有中文标签的那一套（automatic / manual / clip /
// sync / ha / ha_append / ha_resume × queued / running / retrying / submitting /
// succeeded / partial / failed / interrupted / unknown / paused），否则界面上会显示成
// 「其他来源」「其他状态」。发布任务与上传队列表里没有的字段不凭空加。
//
// 写操作真的改内存：模板增删改落在 db.templates 上（其它页面立刻看到），发布任务、
// 上传队列、B 站稿件是内存数组，刷新页面仍在（mock 模块只在本页面生命周期内存在）。
// ============================================================================

import type { BiliArchive, BiliArchivePage, BiliType, User } from '../api-streamer'
import type { Enqueued, PreviewArchive, PublishJob, RenderedArchive, StudioOverride } from '../publish'
import type { UploadQueueFile, UploadQueueTask } from '../upload-queue'
import type { MockHandler } from './types'
import { badRequest, json, notFound, ok } from './util'
import { db, NOW_SEC, nextId, type TemplateRow } from './state'

// ---------------------------------------------------------------------------
// 时间基准：论文/秒混用是后端的坑，这里统一按契约来——
// 上传队列、发布任务的 *_at 是毫秒；录播文件 updateTime、B 站稿件的 ptime/ctime/dtime 是秒。
// ---------------------------------------------------------------------------

const NOW_MS = NOW_SEC * 1000
const agoMs = (seconds: number) => NOW_MS - seconds * 1000
const agoSec = (seconds: number) => NOW_SEC - seconds

/** 小工具：query 里的整数参数，缺省 / 非法 / 越界都夹到合法范围 */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  // 注意 Number(null) 是 0，缺参时必须先走 fallback，否则 limit 会被夹成 1
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

// ===========================================================================
// 1. 投稿模板：直接操作 db.templates（与「投稿管理」「直播间编辑」共享）
// ===========================================================================

/** 新建模板时补全的默认值：与后端 StudioEntity 的字段一一对应 */
const TEMPLATE_DEFAULTS = {
  template_name: '未命名投稿模板',
  user_cookie: 'biliup-cookies',
  copyright: 2,
  copyright_source: '',
  tid: 17,
  tid_v2: null,
  cover_path: '',
  title: '',
  description: '',
  dynamic: '',
  tags: [] as string[],
  dtime: null,
  mission_id: null,
  dolby: 0,
  hires: 0,
  no_reprint: 0,
  is_only_self: 0,
  up_selection_reply: 0,
  up_close_reply: 0,
  // 前端 StudioEntity 叫 up_close_danmu，state.ts 的 TemplateRow 写成了 up_close_danmaku：
  // 两个都存一份，界面读得到、类型也完整
  up_close_danmu: 0,
  up_close_danmaku: 0,
  charging_pay: 0,
  credits: [] as { username: string; uid: number }[],
  uploader: 'biliup-rs',
  extra_fields: '',
}

function templatePayload(raw: any): Partial<TemplateRow> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Partial<TemplateRow>
  const patch: Partial<TemplateRow> = { ...body }
  // 必填项兜底，避免新建一半的模板在列表里变成「undefined」
  if (typeof body.template_name !== 'string' || !body.template_name.trim()) {
    delete patch.template_name
  } else {
    patch.template_name = body.template_name.trim()
  }
  if (Array.isArray(body.tags)) patch.tags = body.tags.map(String)
  if (Array.isArray(body.credits)) {
    patch.credits = body.credits
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({ username: String(c.username ?? ''), uid: Number(c.uid) || 0 }))
  }
  if (body.dtime === undefined) delete patch.dtime
  // 「关闭弹幕」在前端叫 up_close_danmu、在 TemplateRow 里叫 up_close_danmaku，两边都写
  if (patch.up_close_danmu !== undefined) patch.up_close_danmaku = patch.up_close_danmu
  else if (patch.up_close_danmaku !== undefined) patch.up_close_danmu = patch.up_close_danmaku
  return patch
}

/** 列表 / 详情回给前端的视图：补上 StudioEntity 的 up_close_danmu 别名 */
function templateView(row: TemplateRow): TemplateRow {
  return { ...row, up_close_danmu: row.up_close_danmu ?? row.up_close_danmaku ?? 0 }
}

function createTemplate(ctx: { body: any }): TemplateRow {
  const patch = templatePayload(ctx.body)
  const row: TemplateRow = {
    ...TEMPLATE_DEFAULTS,
    user_cookie: db.cookies[0]?.name ?? TEMPLATE_DEFAULTS.user_cookie,
    ...patch,
    id: nextId(db.templates),
  }
  db.templates.push(row)
  return row
}

// ===========================================================================
// 2. 发布队列（PublishJob / PreviewArchive）
// ---------------------------------------------------------------------------
// 真实后端会按切片的场次、模板、封面算出最终稿件；mock 里没有切片数据，因此：
//   · 场次统一归到第一个演示房间（5001 老番茄），这样切片工作台的发布队列看得见；
//   · 标题 / 简介 / 标签直接按模板 + studio_override 渲染，够界面展示即可。
// ===========================================================================

let queuePaused: string | null = null // 非 null = B 站 601 暂停了整个队列

const publishJobs: PublishJob[] = [
  {
    id: 1501,
    session_id: 5001,
    clip_ids: [77],
    combine: false,
    state: 'done',
    step: 'submit',
    detail: '已投稿，等 B 站审核',
    ratio: null,
    uploaded: 1,
    error: null,
    bvid: 'BV1xx411c7mD',
    cancelling: false,
    title: '全员掉线名场面',
    created_by: 1,
    created_at: agoMs(2400),
    updated_at: agoMs(1800),
  },
  {
    id: 1502,
    session_id: 5001,
    clip_ids: [79, 80],
    combine: true,
    state: 'running',
    step: 'upload',
    detail: '上传第 1 个分 P',
    ratio: 0.37,
    uploaded: 0,
    error: null,
    bvid: null,
    cancelling: false,
    title: '致命公司高光合集',
    created_by: 1,
    created_at: agoMs(1500),
    updated_at: agoMs(3),
  },
  {
    id: 1503,
    session_id: 5001,
    clip_ids: [81],
    combine: false,
    state: 'queued',
    step: null,
    detail: '等前面的任务做完',
    ratio: null,
    uploaded: 0,
    error: null,
    bvid: null,
    cancelling: false,
    title: '水友赛预告片',
    created_by: 1,
    created_at: agoMs(1200),
    updated_at: agoMs(1200),
  },
]

const nextJobId = () => publishJobs.reduce((max, job) => Math.max(max, job.id), 1500) + 1

/**
 * 模板标题 / 简介 / 标签用的变量，与后端 `Recorder` 保持一致：
 * `{streamer}` `{title}` `{url}` + strftime（按开播时间格式化）。
 */
interface TemplateVars {
  streamer: string
  title: string
  url: string
  /** 这场录制的开始时间：`%Y-%m-%d` 等指令按它格式化 */
  date: Date
}

function templateVars(template: TemplateRow): TemplateVars {
  const streamer =
    db.streamers.find((s) => s.upload_streamers_id === template.id) ?? db.streamers[0]
  return {
    streamer: streamer?.remark ?? '主播',
    title: '【实况】今晚通宵打星际，来就完了',
    url: streamer?.url ?? 'https://live.bilibili.com/77330',
    date: new Date(NOW_SEC * 1000),
  }
}

/** 只实现模板里常用的 strftime 指令，不认识的指令原样保留（后端 chrono 的集合更大，演示够用） */
function strftime(date: Date, format: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return format.replace(/%([YymdHMSj%])/g, (token, code: string) => {
    switch (code) {
      case 'Y':
        return String(date.getFullYear())
      case 'y':
        return String(date.getFullYear()).slice(-2)
      case 'm':
        return pad(date.getMonth() + 1)
      case 'd':
        return pad(date.getDate())
      case 'H':
        return pad(date.getHours())
      case 'M':
        return pad(date.getMinutes())
      case 'S':
        return pad(date.getSeconds())
      case 'j': {
        const yearStart = new Date(date.getFullYear(), 0, 1)
        return pad(Math.floor((date.getTime() - yearStart.getTime()) / 86_400_000) + 1, 3)
      }
      case '%':
        return '%'
      default:
        return token
    }
  })
}

/**
 * 模板渲染：先按开播时间做 strftime，再替换 `{streamer}` `{title}` `{url}`。
 * 顺序和后端一致——变量值里的 `%` 不会被当成格式符；未知的 `{xxx}` 原样保留。
 */
function fillVars(text: string, vars: TemplateVars): string {
  return strftime(vars.date, text).replace(
    /\{(streamer|title|url)\}/g,
    (_, key: 'streamer' | 'title' | 'url') => vars[key],
  )
}

/** 转载来源：模板填了就用模板的（去掉「转自」前缀），否则用直播间地址 */
function sourceUrl(template: TemplateRow, vars: TemplateVars): string {
  const raw = template.copyright_source?.trim()
  if (raw) return raw.replace(/^转自\s*/, '')
  return vars.url
}

function templateFor(templateId: number | null | undefined): TemplateRow | undefined {
  if (templateId == null) return db.templates[0]
  return db.templates.find((t) => t.id === templateId)
}

function overrideOf(body: { studio_override?: StudioOverride }): StudioOverride | undefined {
  const over = body.studio_override
  return over && typeof over === 'object' ? over : undefined
}

function templateIdOf(body: { template_id?: number | null }): number | null | undefined {
  const id = body.template_id
  if (id === null) return null
  return typeof id === 'number' && Number.isFinite(id) ? id : undefined
}

/** 按模板 + 覆盖设置算一个稿件（预览与发布共用） */
function previewOf(
  clipIds: number[],
  combine: boolean,
  templateId: number | null | undefined,
  over: StudioOverride | undefined,
): PreviewArchive {
  const template = templateFor(templateId)
  if (!template) {
    return {
      clip_ids: clipIds,
      template_id: templateId ?? null,
      rendered: null,
      problem: '还没有投稿模板：请先在「投稿管理」里新建一个',
      cover: null,
    }
  }
  const vars = templateVars(template)
  const title = fillVars(over?.title?.trim() || template.title || template.template_name, vars)
  const dtime =
    over?.dtime !== undefined
      ? over.dtime === 0
        ? null
        : over.dtime
      : template.dtime
        ? NOW_SEC + template.dtime
        : null
  const rendered: RenderedArchive = {
    title,
    desc: fillVars(over?.desc ?? template.description, vars),
    tags: over?.tags?.length ? over.tags : template.tags,
    tid: over?.tid ?? template.tid,
    tid_v2: over?.tid_v2 ?? template.tid_v2 ?? null,
    // 切片是直播片段，一律按转载投稿（与界面固定的「转载」一致）
    copyright: 2,
    source: sourceUrl(template, vars),
    dtime,
    part_titles: combine
      ? clipIds.map((id, index) => `P${index + 1} ${title}（切片 #${id}）`)
      : [`P1 ${title}`],
    template_self_made: template.copyright === 1,
    template_name: template.template_name,
  }
  return {
    clip_ids: clipIds,
    template_id: template.id,
    rendered,
    problem: null,
    cover: over?.cover ?? { source: 'live' },
  }
}

/** 把一次发布请求拆成任务：combine 时全部切片合成一个稿件，否则一个切片一个稿件 */
function enqueue(body: {
  clip_ids?: unknown
  combine?: unknown
  template_id?: number | null
  studio_override?: StudioOverride
}): Enqueued {
  const ids = Array.isArray(body.clip_ids)
    ? body.clip_ids.map(Number).filter((id) => Number.isFinite(id))
    : []
  const combine = body.combine === true && ids.length > 1
  const groups: number[][] = combine ? [ids] : ids.map((id) => [id])
  const over = overrideOf(body)
  const templateId = templateIdOf(body)
  const now = Date.now()
  const jobs = groups.map((group) => {
    const preview = previewOf(group, group.length > 1, templateId, over)
    const job: PublishJob = {
      id: nextJobId(),
      // mock 里拿不到切片所属场次，统一归到第一个演示房间，发布队列才看得见
      session_id: 5001,
      clip_ids: group,
      combine: group.length > 1,
      state: 'queued',
      step: null,
      detail: '排队中，等前面的任务做完',
      ratio: null,
      uploaded: 0,
      error: null,
      bvid: null,
      cancelling: false,
      title: preview.rendered?.title ?? null,
      created_by: 1,
      created_at: now,
      updated_at: now,
    }
    publishJobs.push(job)
    return job
  })
  return { jobs, skipped: [] }
}

// ===========================================================================
// 3. 上传队列（UploadQueueTask）
// ---------------------------------------------------------------------------
// 10 条任务，覆盖 7 种来源与 10 种状态：跑着的、排队的、重试的、投稿的、成功的、
// 部分成功、失败、中断、结果未知、暂停，筛选与「需要关注」都能看出区别。
// ===========================================================================

function qFile(
  id: string,
  order: number,
  name: string,
  state: string,
  confirmed: number,
  total: number | null,
  retries = 0,
  error: string | null = null,
): UploadQueueFile {
  return { id, order, name, state, bytes_confirmed: confirmed, total_bytes: total, retries, error }
}

const queueTasks: UploadQueueTask[] = [
  {
    id: 'u_7f3a',
    source: 'clip',
    scheduler_group: 'clip-publish',
    order: 1,
    queue_position: 1,
    title: '全员掉线名场面',
    streamer_name: '老番茄',
    session_id: 5001,
    template_name: '老番茄-自动投稿',
    state: 'running',
    phase: 'uploading',
    current_file: 'clip_77.mp4',
    bytes_confirmed: 31_457_280,
    total_bytes: 52_428_800,
    speed_bytes_per_sec: 6_291_456,
    files_succeeded: 0,
    files_failed: 0,
    retries: 0,
    next_retry_at: null,
    error: null,
    bvid: null,
    created_at: agoMs(1800),
    updated_at: agoMs(2),
    files: [qFile('f1', 1, 'clip_77.mp4', 'running', 31_457_280, 52_428_800)],
  },
  {
    id: 'u_7f3b',
    source: 'automatic',
    scheduler_group: 'automatic-pool',
    order: 1,
    queue_position: null,
    title: '老番茄_【实况】今晚通宵打星际_2026-10-23T21_00_00.flv',
    streamer_name: '老番茄',
    session_id: 5001,
    template_name: '老番茄-自动投稿',
    state: 'queued',
    phase: 'waiting_slot',
    current_file: null,
    bytes_confirmed: 0,
    total_bytes: null,
    speed_bytes_per_sec: 0,
    files_succeeded: 0,
    files_failed: 0,
    retries: 0,
    next_retry_at: null,
    error: null,
    bvid: null,
    created_at: agoMs(600),
    updated_at: agoMs(600),
    files: [
      qFile('f1', 1, '老番茄_【实况】今晚通宵打星际_2026-10-23T21_00_00.flv', 'queued', 0, 5_368_709_120),
      qFile('f2', 2, '老番茄_【实况】今晚通宵打星际_2026-10-23T22_30_00.flv', 'queued', 0, 2_147_483_648),
    ],
  },
  {
    id: 'u_7f3c',
    source: 'automatic',
    scheduler_group: 'automatic-pool',
    order: 2,
    queue_position: 2,
    title: '影视飓风_聊聊我们是怎么拍 4K 视频的_2026-10-23T20_10_00.mp4',
    streamer_name: '影视飓风',
    session_id: 5002,
    template_name: '影视飓风-横屏搬运',
    state: 'submitting',
    phase: 'submitting',
    current_file: null,
    bytes_confirmed: 3_221_225_472,
    total_bytes: 3_221_225_472,
    speed_bytes_per_sec: 0,
    files_succeeded: 1,
    files_failed: 0,
    retries: 0,
    next_retry_at: null,
    error: null,
    bvid: null,
    created_at: agoMs(3600),
    updated_at: agoMs(60),
    files: [qFile('f1', 1, '影视飓风_聊聊我们是怎么拍 4K 视频的_2026-10-23T20_10_00.mp4', 'succeeded', 3_221_225_472, 3_221_225_472)],
  },
  {
    id: 'u_7f3d',
    source: 'manual',
    scheduler_group: 'manual',
    order: 1,
    queue_position: null,
    title: '午夜琴房_钢琴即兴_2026-10-23T22_05_00.flv',
    streamer_name: '午夜琴房',
    session_id: 5003,
    template_name: '午夜琴房-纯音频',
    state: 'succeeded',
    phase: 'finished',
    current_file: null,
    bytes_confirmed: 1_073_741_824,
    total_bytes: 1_073_741_824,
    speed_bytes_per_sec: 0,
    files_succeeded: 1,
    files_failed: 0,
    retries: 0,
    next_retry_at: null,
    error: null,
    bvid: 'BV1xx411c7mF',
    created_at: agoMs(7200),
    updated_at: agoMs(6500),
    files: [qFile('f1', 1, '午夜琴房_钢琴即兴_2026-10-23T22_05_00.flv', 'succeeded', 1_073_741_824, 1_073_741_824)],
  },
  {
    id: 'u_7f3e',
    source: 'sync',
    scheduler_group: 'sync',
    order: 1,
    queue_position: null,
    title: '猫猫台_rank 冲分_2026-10-23T19_40_00.flv',
    streamer_name: '猫猫台',
    session_id: 5004,
    template_name: null,
    state: 'retrying',
    phase: 'retrying',
    current_file: 'part_03.flv',
    bytes_confirmed: 2_147_483_648,
    total_bytes: null,
    // 等下次重试，此刻没有在传，速度为 0
    speed_bytes_per_sec: 0,
    files_succeeded: 2,
    files_failed: 1,
    retries: 2,
    next_retry_at: NOW_MS + 120_000,
    error: '分段 part_02 传输中断：connection reset by peer',
    bvid: null,
    created_at: agoMs(5000),
    updated_at: agoMs(30),
    files: [
      qFile('f1', 1, 'part_01.flv', 'succeeded', 1_073_741_824, 1_073_741_824),
      qFile('f2', 2, 'part_02.flv', 'failed', 0, 1_073_741_824, 2, 'connection reset by peer'),
      qFile('f3', 3, 'part_03.flv', 'running', 1_073_741_824, null),
    ],
  },
  {
    id: 'u_7f3f',
    source: 'ha',
    scheduler_group: 'ha-pool',
    order: 1,
    queue_position: null,
    title: 'RED 摄影机拆解直播',
    streamer_name: '影视飓风',
    session_id: 5002,
    template_name: null,
    state: 'failed',
    phase: 'submitting',
    current_file: null,
    bytes_confirmed: 8_589_934_592,
    total_bytes: 8_589_934_592,
    speed_bytes_per_sec: 0,
    files_succeeded: 1,
    files_failed: 0,
    retries: 2,
    next_retry_at: null,
    error: '投稿失败：-104 账号未登录',
    bvid: null,
    created_at: agoMs(9000),
    updated_at: agoMs(8400),
    files: [qFile('f1', 1, 'RED 摄影机拆解直播.flv', 'succeeded', 8_589_934_592, 8_589_934_592)],
  },
  {
    id: 'u_7f40',
    source: 'ha_resume',
    scheduler_group: 'ha-pool',
    order: 2,
    queue_position: null,
    title: '【水友赛】今晚八点，一起来玩致命公司！',
    streamer_name: '老番茄',
    session_id: 5001,
    template_name: '老番茄-自动投稿',
    state: 'interrupted',
    phase: 'finished',
    current_file: null,
    bytes_confirmed: 21_474_836_480,
    total_bytes: 21_474_836_480,
    speed_bytes_per_sec: 0,
    files_succeeded: 1,
    files_failed: 0,
    retries: 0,
    next_retry_at: null,
    error: '服务重启时任务尚未完成，可到「录制文件」里重新投稿',
    bvid: null,
    created_at: agoMs(12_000),
    updated_at: agoMs(11_000),
    files: [qFile('f1', 1, '【水友赛】今晚八点，一起来玩致命公司！.flv', 'succeeded', 21_474_836_480, 21_474_836_480)],
  },
  {
    id: 'u_7f41',
    source: 'automatic',
    scheduler_group: 'automatic-pool',
    order: 3,
    queue_position: null,
    title: '周末电台_第 88 期_2026-10-22T20_00_00.flv',
    streamer_name: '周末电台',
    session_id: null,
    template_name: null,
    state: 'unknown',
    phase: 'submitting',
    current_file: null,
    bytes_confirmed: 2_684_354_560,
    total_bytes: 2_684_354_560,
    speed_bytes_per_sec: 0,
    files_succeeded: 1,
    files_failed: 0,
    retries: 1,
    next_retry_at: null,
    error: '投稿请求超时，结果未知：请到 B 站稿件管理核对',
    bvid: null,
    created_at: agoMs(20_000),
    updated_at: agoMs(19_000),
    files: [qFile('f1', 1, '周末电台_第 88 期_2026-10-22T20_00_00.flv', 'succeeded', 2_684_354_560, 2_684_354_560)],
  },
  {
    id: 'u_7f42',
    source: 'manual',
    scheduler_group: 'manual',
    order: 2,
    queue_position: null,
    title: '老番茄_【实况】今晚通宵打星际_2026-10-23T22_30_00.flv',
    streamer_name: '老番茄',
    session_id: 5001,
    template_name: '老番茄-自动投稿',
    state: 'partial',
    phase: 'finished',
    current_file: null,
    bytes_confirmed: 2_147_483_648,
    total_bytes: 2_147_483_648,
    speed_bytes_per_sec: 0,
    files_succeeded: 1,
    files_failed: 1,
    retries: 1,
    next_retry_at: null,
    error: '1 个分 P 上传失败：-404 请求被拦截',
    bvid: null,
    created_at: agoMs(4000),
    updated_at: agoMs(3600),
    files: [
      qFile('f1', 1, 'part_01.flv', 'succeeded', 2_147_483_648, 2_147_483_648),
      qFile('f2', 2, 'part_02.flv', 'failed', 0, 1_073_741_824, 1, '-404 请求被拦截'),
    ],
  },
  {
    id: 'u_7f43',
    source: 'ha_append',
    scheduler_group: 'ha-pool',
    order: 3,
    queue_position: null,
    title: '午夜琴房 深夜加播钢琴即兴',
    streamer_name: '午夜琴房',
    session_id: 5003,
    template_name: '午夜琴房-纯音频',
    state: 'paused',
    phase: 'waiting_slot',
    current_file: null,
    bytes_confirmed: 0,
    total_bytes: null,
    speed_bytes_per_sec: 0,
    files_succeeded: 0,
    files_failed: 0,
    retries: 0,
    next_retry_at: null,
    error: null,
    bvid: null,
    created_at: agoMs(2400),
    updated_at: agoMs(1200),
    files: [qFile('f1', 1, '午夜琴房 深夜加播钢琴即兴.flv', 'queued', 0, null)],
  },
]

/** 概况卡片的四个数字：对全量任务算，不受 source/state 筛选影响 */
function queueSummary() {
  const isRunning = (task: UploadQueueTask) => task.state === 'running' || task.state === 'submitting'
  const idle = new Set(['queued', 'paused'])
  const attention = new Set(['failed', 'interrupted', 'unknown', 'partial'])
  return {
    uploading: queueTasks.filter(isRunning).length,
    queued: queueTasks.filter((task) => idle.has(task.state)).length,
    attention: queueTasks.filter((task) => attention.has(task.state)).length,
    speed_bytes_per_sec: queueTasks
      .filter(isRunning)
      .reduce((sum, task) => sum + (task.speed_bytes_per_sec || 0), 0),
  }
}

/** 列表不带文件明细（点「文件明细」时再走 GET /v1/upload-queue/{id}） */
function withoutFiles(task: UploadQueueTask): UploadQueueTask {
  const copy: UploadQueueTask = { ...task }
  delete copy.files
  return copy
}

let manualSeq = 0

// ===========================================================================
// 4. B 站远程稿件（BiliArchive，时间戳是秒）
// ===========================================================================

const archiveRows: BiliArchive[] = [
  {
    aid: 114_514_191,
    bvid: 'BV1xx411c7mD',
    title: '老番茄 今晚通宵打星际 直播回放',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514191.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 5760,
    desc: '直播间：https://live.bilibili.com/77330 本场直播录播，由 biliup 自动投稿。',
    state: 0,
    state_desc: '已通过',
    dtime: 0,
    ptime: agoSec(3600),
    ctime: agoSec(4200),
  },
  {
    aid: 114_514_192,
    bvid: 'BV1xx411c7mE',
    title: '影视飓风 4K 幕后花絮',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514192.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 1830,
    desc: '聊聊我们是怎么拍 4K 视频的，幕后花絮合集。',
    state: 0,
    state_desc: '已通过',
    dtime: 0,
    ptime: agoSec(86_400),
    ctime: agoSec(90_000),
  },
  {
    aid: 114_514_193,
    bvid: 'BV1xx411c7mF',
    title: '午夜琴房 钢琴即兴 第 88 期',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514193.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 5400,
    desc: '深夜钢琴即兴，点歌请打在弹幕里。',
    state: 0,
    state_desc: '已通过',
    dtime: 0,
    ptime: agoSec(172_800),
    ctime: agoSec(180_000),
  },
  {
    aid: 114_514_194,
    bvid: 'BV1xx411c7mG',
    title: '猫猫台 rank 冲分 名场面合集',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514194.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 726,
    desc: '排位冲分高光时刻，一次看个够。',
    state: 0,
    state_desc: '已通过',
    dtime: 0,
    ptime: agoSec(259_200),
    ctime: agoSec(260_000),
  },
  {
    aid: 114_514_195,
    bvid: 'BV1xx411c7mH',
    title: '水友赛 深夜五排 第 12 期',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514195.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 3600,
    desc: '斗鱼水友赛录播合集，第 12 期。',
    state: 0,
    state_desc: '已通过',
    dtime: 0,
    ptime: agoSec(345_600),
    ctime: agoSec(350_000),
  },
  {
    aid: 114_514_196,
    bvid: 'BV1xx411c7mJ',
    title: '老番茄 星际争霸 高能剪辑',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514196.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 942,
    desc: '直播切片高能剪辑，审核通过后定时公开。',
    state: 1,
    state_desc: '审核中',
    dtime: agoSec(-7200),
    ptime: 0,
    ctime: agoSec(1800),
  },
  {
    aid: 114_514_197,
    bvid: 'BV1xx411c7mK',
    title: '影视飓风 设备清单大公开',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514197.jpg',
    reject_reason: '',
    reject_reason_url: '',
    duration: 1500,
    desc: '摄影机、镜头、灯光的完整设备清单。',
    state: 1,
    state_desc: '审核中',
    dtime: 0,
    ptime: 0,
    ctime: agoSec(2400),
  },
  {
    aid: 114_514_198,
    bvid: 'BV1xx411c7mL',
    title: '周末电台 第 88 期 深夜电台',
    cover: 'https://i0.hdslb.com/bfs/archive/demo_114514198.jpg',
    reject_reason: '稿件封面含二维码，请修改封面后重新提交',
    reject_reason_url: 'https://member.bilibili.com/platform/upload-manager/article?aid=114514198',
    duration: 4800,
    desc: '周末电台第 88 期，深夜陪伴。',
    state: -1,
    state_desc: '未通过',
    dtime: 0,
    ptime: 0,
    ctime: agoSec(432_000),
  },
]

/** status 筛选（与 archives 页的下拉一一对应） */
const ARCHIVE_FILTERS: Record<string, (row: BiliArchive) => boolean> = {
  is_pubing: (row) => row.state === 1,
  pubed: (row) => row.state === 0,
  not_pubed: (row) => row.state === -1,
}

// ===========================================================================
// 5. B 站账号（/v1/users）：Cookie 文件列表 + 昵称头像，投稿模板的「投稿账号」也用它
// ===========================================================================

/** 演示账号的显示名（第一个是投稿模板们在用的那个 cookie 文件） */
const ACCOUNT_NAMES: Record<number, string> = {
  1: '老番茄的投稿号',
  2: '午夜琴房的斗鱼号',
  3: '猫猫台的虎牙号',
}

const accountName = (id: number, fallback: string) => ACCOUNT_NAMES[id] ?? fallback

function userRows(): User[] {
  return db.cookies.map((cookie) => ({
    id: cookie.id,
    name: accountName(cookie.id, cookie.name),
    // 投稿模板的 user_cookie 存的是凭据文件名，下拉框的 value 必须对得上
    value: cookie.name,
    platform: cookie.platform,
  }))
}

/** 去掉路径 / 后缀，得到一个像凭据文件名的名字 */
function cookieFileName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value
  return base.replace(/\.json$/i, '') || 'cookies'
}

// ===========================================================================
// 6. 分区树（GET /bili/archive/pre）：新建 / 编辑投稿模板的分区级联选择
// ===========================================================================

const biliType = (id: number, name: string, desc = '', children: BiliType[] = []): BiliType => ({
  id,
  name,
  desc,
  children,
})

const BILI_TYPES: BiliType[] = [
  biliType(1, '动画', '动画相关', [
    biliType(24, 'MAD·AMV', 'MAD·AMV'),
    biliType(25, 'MMD·3D', 'MMD·3D'),
    biliType(47, '短片·手书·配音', '短片·手书·配音'),
  ]),
  biliType(4, '游戏', '游戏相关', [
    biliType(17, '单机游戏', '单机游戏'),
    biliType(171, '电子竞技', '电子竞技'),
    biliType(172, '手机游戏', '手机游戏'),
    biliType(65, '网络游戏', '网络游戏'),
  ]),
  biliType(3, '音乐', '音乐相关', [
    biliType(28, '原创音乐', '原创音乐'),
    biliType(31, '翻唱', '翻唱'),
    biliType(30, 'VOCALOID·UTAU', 'VOCALOID·UTAU'),
  ]),
  biliType(160, '生活', '生活相关', [
    biliType(21, '日常', '日常'),
    biliType(138, '搞笑', '搞笑'),
    biliType(76, '美食圈', '美食圈'),
    biliType(75, '动物圈', '动物圈'),
  ]),
  biliType(181, '影视', '影视相关', [
    biliType(182, '影视杂谈', '影视杂谈'),
    biliType(183, '影视剪辑', '影视剪辑'),
    biliType(85, '短片', '短片'),
  ]),
  biliType(203, '资讯', '资讯相关', [
    biliType(211, '热点', '热点'),
    biliType(212, '科技', '科技'),
    biliType(213, '财经', '财经'),
  ]),
]

// ===========================================================================
// 7. 处理器
// ===========================================================================

const isUploadStreamers = '/v1/upload/streamers'
const STREAMER_ITEM = /^\/v1\/upload\/streamers\/(\d+)$/
const ARCHIVE_ITEM = /^\/v1\/users\/(\d+)\/archives$/
const USER_ITEM = /^\/v1\/users\/(\d+)$/
const CLIP_PUBLISH = /^\/v1\/clips\/(\d+)\/publish$/
const PUBLISH_ITEM = /^\/v1\/publish-jobs\/(\d+)$/
const PUBLISH_RETRY = /^\/v1\/publish-jobs\/(\d+)\/retry$/
const QUEUE_ITEM = /^\/v1\/upload-queue\/([^/]+)$/

export const uploadHandlers: MockHandler[] = [
  // -------------------------------------------------------------------------
  // 投稿模板
  // -------------------------------------------------------------------------
  (ctx) => {
    if (ctx.path !== isUploadStreamers) return undefined
    if (ctx.method === 'GET') return json(db.templates.map(templateView))
    if (ctx.method === 'POST') {
      // 编辑页也是 POST 到集合地址、body 里带 id：已有 id 就当更新（与后端行为一致）
      const body = (ctx.body ?? {}) as Partial<TemplateRow>
      const id = Number(body.id)
      if (Number.isFinite(id) && id > 0) {
        const row = db.templates.find((t) => t.id === id)
        if (row) {
          Object.assign(row, templatePayload(body))
          return json(templateView(row))
        }
      }
      return json(templateView(createTemplate(ctx)), 201)
    }
    return undefined
  },

  // GET / PUT / DELETE /v1/upload/streamers/{id}
  (ctx) => {
    const match = ctx.path.match(STREAMER_ITEM)
    if (!match) return undefined
    const id = Number(match[1])
    const row = db.templates.find((t) => t.id === id)
    if (!row) return notFound('投稿模板不存在')
    if (ctx.method === 'GET') return json(templateView(row))
    if (ctx.method === 'PUT' || ctx.method === 'PATCH') {
      Object.assign(row, templatePayload(ctx.body), { id })
      return json(templateView(row))
    }
    if (ctx.method === 'DELETE') {
      db.templates.splice(db.templates.indexOf(row), 1)
      return ok({ success: true, id })
    }
    return undefined
  },

  // -------------------------------------------------------------------------
  // 手动投稿：POST /v1/uploads —— 把选中的录播文件排进上传队列
  // -------------------------------------------------------------------------
  (ctx) => {
    if (ctx.method !== 'POST' || ctx.path !== '/v1/uploads') return undefined
    // 前端发的是 JSON {files, template_id}；也容忍 multipart 表单（浏览器直接提交）
    const isForm = typeof FormData !== 'undefined' && ctx.body instanceof FormData
    const body = (!isForm && ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as {
      files?: unknown
      template_id?: unknown
    }
    const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : []
    if (files.length === 0) return badRequest('没有选择要投稿的文件')

    const template =
      db.templates.find((t) => t.id === Number(body.template_id)) ?? db.templates[0]
    const id = `u_manual_${++manualSeq}`
    const now = Date.now()
    const task: UploadQueueTask = {
      id,
      source: 'manual',
      scheduler_group: 'manual',
      order: queueTasks.filter((t) => t.scheduler_group === 'manual').length + 1,
      queue_position: null,
      title: files[0],
      streamer_name: null,
      session_id: null,
      template_name: template?.template_name ?? null,
      state: 'queued',
      phase: 'waiting_slot',
      current_file: null,
      bytes_confirmed: 0,
      total_bytes: files.reduce((sum, name) => sum + videoSize(name), 0) || null,
      speed_bytes_per_sec: 0,
      files_succeeded: 0,
      files_failed: 0,
      retries: 0,
      next_retry_at: null,
      error: null,
      bvid: null,
      created_at: now,
      updated_at: now,
      files: files.map((name, index) =>
        qFile(`f${index + 1}`, index + 1, name, 'queued', 0, videoSize(name) || null),
      ),
    }
    queueTasks.push(task)
    return json({ success: true, task_id: id, files, template_id: template?.id ?? null }, 201)
  },

  // -------------------------------------------------------------------------
  // 发布队列：预览 / 入队 / 查询 / 重试 / 移出
  // -------------------------------------------------------------------------
  (ctx) => {
    if (ctx.method !== 'POST' || ctx.path !== '/v1/publish-jobs/preview') return undefined
    const body = (ctx.body ?? {}) as { clip_ids?: unknown; combine?: unknown }
    const ids = Array.isArray(body.clip_ids)
      ? body.clip_ids.map(Number).filter((id) => Number.isFinite(id))
      : []
    if (ids.length === 0) return badRequest('没有选择要发布的切片')
    const combine = body.combine === true && ids.length > 1
    const over = overrideOf(ctx.body as { studio_override?: StudioOverride })
    const templateId = templateIdOf(ctx.body as { template_id?: number | null })
    const archives: PreviewArchive[] = combine
      ? [previewOf(ids, true, templateId, over)]
      : ids.map((id) => previewOf([id], false, templateId, over))
    return json({ archives })
  },

  (ctx) => {
    if (ctx.path !== '/v1/publish-jobs') return undefined
    if (ctx.method === 'GET') {
      const session = ctx.query.get('session')
      const wanted = session == null || session === '' ? null : Number(session)
      const jobs =
        wanted == null || !Number.isFinite(wanted)
          ? publishJobs
          : publishJobs.filter((job) => job.session_id === wanted)
      return json({ paused: queuePaused, jobs: jobs.slice().sort((a, b) => a.id - b.id) })
    }
    if (ctx.method === 'POST') return json(enqueue(ctx.body ?? {}))
    return undefined
  },

  // POST /v1/publish-jobs/resume：B 站 601 暂停后继续整个队列
  (ctx) => {
    if (ctx.method !== 'POST' || ctx.path !== '/v1/publish-jobs/resume') return undefined
    queuePaused = null
    const now = Date.now()
    for (const job of publishJobs) {
      if (job.state === 'paused' || job.state === 'failed') {
        job.state = 'queued'
        job.step = null
        job.detail = '继续排队'
        job.ratio = null
        job.error = null
        job.updated_at = now
      }
    }
    return ok({ success: true })
  },

  // POST /v1/clips/{id}/publish：单切片发布
  (ctx) => {
    const match = ctx.path.match(CLIP_PUBLISH)
    if (!match || ctx.method !== 'POST') return undefined
    const clipId = Number(match[1])
    return json(enqueue({ ...(ctx.body ?? {}), clip_ids: [clipId] }))
  },

  // GET / POST retry / DELETE /v1/publish-jobs/{id}
  (ctx) => {
    const retry = ctx.path.match(PUBLISH_RETRY)
    if (retry) {
      if (ctx.method !== 'POST') return undefined
      const job = publishJobs.find((item) => item.id === Number(retry[1]))
      if (!job) return notFound('发布任务不存在')
      job.state = 'queued'
      job.step = null
      job.detail = '重新排队，等前面的任务做完'
      job.ratio = null
      job.error = null
      job.cancelling = false
      job.updated_at = Date.now()
      return json(job)
    }

    const match = ctx.path.match(PUBLISH_ITEM)
    if (!match) return undefined
    const index = publishJobs.findIndex((item) => item.id === Number(match[1]))
    if (index < 0) return notFound('发布任务不存在')
    const job = publishJobs[index]
    if (ctx.method === 'GET') return json(job)
    if (ctx.method === 'DELETE') {
      // 正在跑的：只能标记取消（投稿请求还没发出才停得下来）；其余直接移出队列
      if (job.state === 'running') {
        job.state = 'cancelled'
        job.cancelling = false
        job.detail = '已取消，没有投稿'
        job.ratio = null
        job.updated_at = Date.now()
        return json(job)
      }
      publishJobs.splice(index, 1)
      return ok({ success: true, id: job.id })
    }
    return undefined
  },

  // -------------------------------------------------------------------------
  // 上传队列：列表（筛选 + 分页 + 概况）与单任务明细
  // -------------------------------------------------------------------------
  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/upload-queue') return undefined
    const source = ctx.query.get('source') ?? ''
    const state = ctx.query.get('state') ?? ''
    const limit = intParam(ctx.query.get('limit'), 25, 1, 200)
    const offset = intParam(ctx.query.get('offset'), 0, 0, 100_000)
    const filtered = queueTasks.filter(
      (task) => (!source || task.source === source) && (!state || task.state === state),
    )
    return json({
      tasks: filtered.slice(offset, offset + limit).map(withoutFiles),
      total: filtered.length,
      summary: queueSummary(),
      error: null,
    })
  },

  (ctx) => {
    if (ctx.method !== 'GET') return undefined
    const match = ctx.path.match(QUEUE_ITEM)
    if (!match) return undefined
    const id = decodeURIComponent(match[1])
    const task = queueTasks.find((item) => item.id === id)
    if (!task) return notFound('上传任务不存在')
    return json(task)
  },

  // -------------------------------------------------------------------------
  // 录播文件：列表、定位、在服务器上打开所在文件夹
  // -------------------------------------------------------------------------
  (ctx) =>
    ctx.method === 'GET' && ctx.path === '/v1/videos' ? json(db.videos) : undefined,

  (ctx) => {
    if (ctx.method !== 'GET' || ctx.path !== '/v1/files/location') return undefined
    const explicit = ctx.query.get('path')
    const kind = ctx.query.get('kind') ?? 'recording'
    const name =
      explicit ||
      (kind === 'render'
        ? `renders/render-${ctx.query.get('id') ?? '0'}.mp4`
        : ctx.query.get('file_name') ?? '')
    if (!name) return badRequest('缺少要定位的文件名')
    const clean = name.replace(/^[\\/]+/, '')
    return json({
      // 演示站的「服务器」是 Linux 上的 biliup 数据目录
      path: `/opt/biliup/data/${clean}`,
      // 演示站点跑在本机时可以直接打开文件管理器；这里固定给 true 让按钮有反馈
      can_open: true,
    })
  },

  (ctx) =>
    ctx.method === 'POST' && ctx.path === '/v1/files/reveal' ? ok({ success: true }) : undefined,

  // -------------------------------------------------------------------------
  // B 站稿件：GET /v1/users/{id}/archives
  // -------------------------------------------------------------------------
  (ctx) => {
    const match = ctx.path.match(ARCHIVE_ITEM)
    if (!match || ctx.method !== 'GET') return undefined
    const status = ctx.query.get('status') ?? 'all'
    const fromPage = intParam(ctx.query.get('from_page'), 1, 1, 1000)
    const maxPages = intParam(ctx.query.get('max_pages'), 1, 1, 10)
    const pageSize = 20
    const filter = ARCHIVE_FILTERS[status]
    const rows = filter ? archiveRows.filter(filter) : archiveRows
    const total = rows.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const start = (fromPage - 1) * pageSize
    const page: BiliArchivePage = {
      from_page: fromPage,
      page_size: pageSize,
      total,
      total_pages: totalPages,
      fetched_pages: Math.max(0, Math.min(maxPages, totalPages - (fromPage - 1))),
      archives: rows.slice(start, start + pageSize * maxPages),
    }
    return json(page)
  },

  // -------------------------------------------------------------------------
  // B 站账号：列表 / 新增 / 删除 / 昵称头像
  // -------------------------------------------------------------------------
  (ctx) => {
    if (ctx.path !== '/v1/users') return undefined
    if (ctx.method === 'GET') return json(userRows())
    if (ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as { value?: unknown }
      const value = typeof body.value === 'string' ? body.value.trim() : ''
      if (!value) return badRequest('请填写 Cookie 文件路径')
      const name = cookieFileName(value)
      const row = { id: nextId(db.cookies), name, value, platform: 'bilibili' }
      db.cookies.push(row)
      return json(
        { id: row.id, name: accountName(row.id, name), value: row.name, platform: row.platform },
        201,
      )
    }
    return undefined
  },

  (ctx) => {
    const match = ctx.path.match(USER_ITEM)
    if (!match) return undefined
    const id = Number(match[1])
    if (ctx.method === 'GET') {
      const cookie = db.cookies.find((item) => item.id === id)
      if (!cookie) return notFound('账号不存在')
      return json({
        data: {
          name: accountName(id, cookie.name),
          face: `https://i0.hdslb.com/bfs/face/demo_${id}.jpg`,
        },
      })
    }
    if (ctx.method === 'DELETE') {
      const index = db.cookies.findIndex((item) => item.id === id)
      if (index < 0) return notFound('账号不存在')
      db.cookies.splice(index, 1)
      return ok({ success: true, id })
    }
    return undefined
  },

  // -------------------------------------------------------------------------
  // 分区树（新建 / 编辑投稿模板用；编辑页没有它会一直转圈）
  // -------------------------------------------------------------------------
  (ctx) =>
    ctx.method === 'GET' && ctx.path === '/bili/archive/pre'
      ? json({ data: { typelist: BILI_TYPES } })
      : undefined,
]

// ---------------------------------------------------------------------------
// 辅助：录播文件（db.videos）里按文件名找大小，手动投稿排进队列时用来算总量
// ---------------------------------------------------------------------------

function videoSize(name: string): number {
  return db.videos.find((video) => video.name === name)?.size ?? 0
}

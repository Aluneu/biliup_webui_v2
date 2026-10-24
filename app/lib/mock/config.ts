// ============================================================================
// Mock：空间配置 / 平台插件 / B 站账号 / 斗鱼登录 / 用户管理
// ----------------------------------------------------------------------------
// 本模块负责「空间配置」这一片区域在演示站里的假数据，覆盖接口：
//
//   · 空间配置      GET/PUT /v1/configuration（整份配置，键名与 public/config.toml 一致）
//   · 斗鱼登录      POST /v1/douyu/validate-cookie、GET /v1/douyu/auth/status、
//                   POST /v1/douyu/auth/refresh
//   · B 站账号      GET/POST /v1/users、GET/DELETE /v1/users/{id}、GET /v1/users/check、
//                   GET /v1/get_qrcode、POST /v1/login_by_qrcode
//   · 用户管理      GET/POST /v1/web-users、GET /v1/web-users/roles、
//                   PUT/DELETE /v1/web-users/{id}、PUT /v1/web-users/{id}/password、
//                   POST /v1/web-users/{id}/logout-all
//   · B 站辅助      GET /bili/archive/pre（投稿分区树）、GET /bili/space/myinfo、
//                   GET /bili/proxy（占位图，避免外链图片在离线演示时挂掉）
//   · 自动切片配置  GET /v1/auto-clip/status、POST /v1/auto-clip/test
//
// 写操作真的改内存（配置、Cookie 文件、用户），保存后重新 GET 就能读到新值；
// 刷新页面不会丢，重启浏览器回到初始状态。
//
// 时间戳：`web-users` 的 created_at / last_login_at 与斗鱼状态里的
// last_success_at / last_checked_at / next_refresh_at 都是 **Unix 秒**
// （前端 humDate / timeAgo / douyuAuthDate 都按秒解析）。
//
// 不属于本模块的接口一律 return undefined，交给 mock/index.ts 路由链后面的处理器
// （/v1/me、/v1/status、/v1/logout、/v1/tools、/v1/renders*、/v1/upload*、/v1/sessions*、
//  /v1/fleet* 等由其它模块负责）。
// ============================================================================

import type { MockCtx, MockHandler } from './types'
import { json, ok, noContent, notFound, badRequest, placeholderPng } from './util'
import { db, NOW_SEC, nextId } from './state'
import type { CookieRow } from './state'
import type { Permission, Role } from '../use-me'

// ---------------------------------------------------------------------------
// 空间配置：默认值 / 真实配置对象
// ---------------------------------------------------------------------------

/**
 * 一份完整、真实的配置对象：
 * 键名与 `public/config.toml` 逐项对应，另外带上空间配置页各平台面板会读写的全部字段
 * （`app/ui/plugins/*.tsx`、`app/ui/plugins/auto-clip.tsx`、`app/ui/plugins/developer.tsx`）。
 * 没在演示里用的项给 null / 空数组，保持与后端「缺省」的语义一致。
 */
let configuration: Record<string, any> = {
  // ---------------- 全局下载 ----------------
  downloader: 'mesio',
  sync_save_dir: null,
  ffmpeg_path: null,
  render_fonts_dir: null,
  file_size: 2_621_440_000, // 2.44 GiB，与 public/config.toml 的 file_size 一致（字节）
  segment_time: '01:00:00',
  filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S{title}',
  segment_processor_parallel: false,
  filtering_threshold: 20, // MB
  delay: 300, // 秒
  event_loop_interval: 30,
  checker_sleep: 10,
  pool1_size: 5,
  pool2_size: 3,
  live_merge_minutes: 10,
  retention_hours: 24,
  min_free_space: 10_737_418_240, // 10 GiB
  check_sourcecode: 15,
  preview_transport: 'relay', // relay | direct
  preview_max_minutes: 30,
  // 画面遮挡（马赛克）的默认配置：单个直播间可在自己的 override.mosaic_config 里覆盖
  mosaic_config: {
    enabled: false,
    regions: [],
    mode: null,
  },

  // ---------------- 全局上传 ----------------
  submit_api: 'web', // web | app | b-cut-android
  uploader: 'biliup-rs', // Noop | bili_web | biliup-rs
  lines: 'AUTO',
  threads: 3,
  max_upload_limit: 6,
  use_live_cover: true,

  // ---------------- 哔哩哔哩 ----------------
  bili_qn: 10000, // 10000 原画
  bili_cdn: ['cn-gotcha204', 'ov-gotcha05'],
  bili_cdn_fallback: true,
  bili_protocol: 'stream', // stream | hls_ts | hls_fmp4
  bilibili_danmaku: true,
  bilibili_danmaku_detail: false,
  bilibili_danmaku_raw: false,
  bili_liveapi: 'https://api.live.bilibili.com',
  bili_fallback_api: 'https://api.live.bilibili.com',
  bili_anonymous_origin: false,
  bili_hls_transcode_timeout: 60,
  bili_force_source: false,
  bili_replace_cn01: [],

  // ---------------- 斗鱼 ----------------
  douyu_cookie:
    'acf_username=demo; acf_uid=demo_10086; acf_auth=demo_****; acf_did=demo_device_01;',
  douyu_ltp0: 'demo_ltp0_****',
  douyu_refresh_device_id: 'demo_dy_did_****',
  douyu_auto_refresh: true,
  douyu_deviceId: '10000000000000000000000000001511',
  douyu_codec: 'AVC', // '' | AVC | HEVC
  douyu_rate: 0, // 0 原画 / 8 / 4 / 3 / 2
  douyu_danmaku: true,
  douyu_cdn: 'hw-h5',
  douyu_force_hs: false,
  douyu_disable_interactive_game: false,

  // ---------------- 虎牙 ----------------
  huya_max_ratio: 10000,
  huya_danmaku: false,
  huya_cdn: 'AL',
  huya_cdn_fallback: false,
  huya_protocol: 'Flv',
  huya_imgplus: true,
  huya_mobile_api: false,
  huya_use_wup: true,

  // ---------------- 抖音 ----------------
  douyin_quality: 'origin', // origin | uhd | hd | sd | ld | md
  douyin_danmaku: true,
  douyin_protocol: 'flv',
  douyin_double_screen: false,
  douyin_true_origin: false,

  // ---------------- YouTube ----------------
  youtube_enable_download_live: true,
  youtube_enable_download_playback: true,
  youtube_after_date: null,
  youtube_before_date: null,
  youtube_max_videosize: null,
  youtube_max_resolution: '1080',
  youtube_prefer_vcodec: 'av01|vp9|avc',
  youtube_prefer_acodec: 'opus|mp4a',

  // ---------------- Twitch / TwitCasting / CC / 克拉克拉 / 快手 ----------------
  twitch_danmaku: true,
  twitch_disable_ads: true,
  twitcasting_quality: 'high',
  twitcasting_danmaku: false,
  twitcasting_password: null,
  cc_protocol: 'hls',
  kila_protocol: 'flv',
  kuaishou_cookie: '',

  // ---------------- 平台账号 Cookie（config.toml 的 [user] 段） ----------------
  user: {
    bili_cookie:
      'SESSDATA=demo_****;bili_jct=demo_****;DedeUserID=12345;DedeUserID__ckMd5=demo_****;',
    bili_cookie_file: 'biliup-cookies',
    douyin_cookie: '',
    twitch_cookie: '',
    youtube_cookie: '',
    twitcasting_cookie: '',
    afreecatv_username: '',
    afreecatv_password: '',
    'niconico-email': '',
    'niconico-password': '',
    'niconico-user-session': '',
    'niconico-purge-credentials': '',
  },

  // ---------------- 自动切片（空间配置页的「自动切片」区块） ----------------
  auto_clip: {
    enabled: true,
    base_url: 'https://api.deepseek.com/v1',
    api_key: 'sk-demo…9f2c', // 掩码：原样交回表示不修改
    chat_model: 'deepseek-chat',
    asr_base_url: 'https://api.siliconflow.cn/v1',
    asr_api_key: '',
    asr_model: 'FunAudioLLM/SenseVoiceSmall',
    asr_language: 'zh',
    asr_prompt: '老番茄、影视飓风、致命公司、星际争霸、水友赛',
    thumbnails: 'auto', // auto | on | off
    max_asr_minutes: 180,
    max_chat_tokens: 200_000,
    chat_timeout_secs: 180,
    asr_timeout_secs: 300,
    min_clip_secs: 15,
    max_clip_secs: 180,
    max_candidates: 20,
  },

  // ---------------- 日志（config.toml 的 [LOGGING.*] 段） ----------------
  LOGGING: {
    formatters: {
      verbose: {
        format:
          '%(asctime)s %(filename)s[line:%(lineno)d](Pid:%(process)d Tname:%(threadName)s) %(levelname)s %(message)s',
        datefmt: '%Y-%m-%d %H:%M:%S',
      },
      simple: {
        format: '%(filename)s%(lineno)d[%(levelname)s]Tname:%(threadName)s %(message)s',
      },
    },
    handlers: {
      console: {
        level: 'DEBUG',
        class: 'logging.StreamHandler',
        formatter: 'simple',
        stream: 'ext://sys.stdout',
      },
      file: {
        level: 'DEBUG',
        class: 'biliup.common.log.SafeRotatingFileHandler',
        when: 'W0',
        interval: 1,
        backupCount: 1,
        filename: 'ds_update.log',
        formatter: 'verbose',
        encoding: 'utf-8',
      },
    },
    root: { handlers: ['console'], level: 'INFO' },
    loggers: { biliup: { handlers: ['file'], level: 'INFO' } },
  },
  loggers_level: 'INFO',
}

/**
 * `PUT /v1/configuration` 的合并语义：只覆盖请求里带的键。
 * 嵌套对象（user / auto_clip / LOGGING）逐层合并，数组与标量整体替换，
 * 显式传 null 就是清空（前端把清空的数字框统一整理成 null）。
 */
function mergeConfig(base: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const next: Record<string, any> =
    base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch as Record<string, any>)) {
    next[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? mergeConfig(next[key], value)
        : value
  }
  return next
}

// ---------------------------------------------------------------------------
// 工具：头像占位图（SVG data URI）
// ---------------------------------------------------------------------------
// 演示站拉不到外链图片，`<img>` 又不会经过 mock 的 fetch 拦截，因此头像直接内联成
// data URI：不产生任何网络请求，离线部署时也不会出现裂图。

const AVATAR_COLORS: [string, string][] = [
  ['#3a2f8f', '#ff5f7e'],
  ['#134074', '#5ec8ff'],
  ['#5b2a86', '#ffb86b'],
  ['#1f6f54', '#8ff7c8'],
  ['#7a2033', '#ff9f68'],
  ['#2b3a67', '#9db4ff'],
]

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function avatarDataUri(name: string, seed: number): string {
  const [from, to] = AVATAR_COLORS[Math.abs(seed) % AVATAR_COLORS.length]
  const initial = Array.from(name.trim())[0] ?? '播'
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<circle cx="48" cy="48" r="48" fill="url(#a)"/>` +
    `<text x="48" y="62" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" ` +
    `font-size="40" font-weight="600" fill="#ffffff" text-anchor="middle">${escapeXml(initial)}</text>` +
    '</svg>'
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// ---------------------------------------------------------------------------
// B 站账号 / Cookie 文件
// ---------------------------------------------------------------------------

/** Cookie 文件对应的 B 站昵称（`GET /v1/users/{id}` 用它补全账号列表） */
function cookieDisplayName(cookie: CookieRow): string {
  if (cookie.name === 'biliup-cookies') return '老番茄'
  if (cookie.platform === 'douyu') return '斗鱼账号 · 水友赛直播间'
  if (cookie.platform === 'huya') return '虎牙账号 · 午夜琴房'
  if (cookie.name.includes('影视飓风')) return '影视飓风'
  return cookie.name || 'B 站账号'
}

/** 按 Cookie 文件查一行（value 是文件路径或文件内容，name 是文件名） */
function findCookie(key: string): CookieRow | undefined {
  return db.cookies.find((c) => c.value === key || c.name === key)
}

/** `POST /v1/users` 的 value 是 Cookie 文件路径：文件名去掉 .json 作为账号名 */
function cookieNameOf(value: string): string {
  const base = value.split(/[\\/]/).pop() || value
  return base.replace(/\.json$/i, '').trim() || 'cookies'
}

/** 已存在就复用，不存在才新建：扫码登录与手动添加走同一份内存数据 */
function ensureCookie(name: string, value: string, platform = 'bilibili'): CookieRow {
  const existing = findCookie(name) ?? findCookie(value)
  if (existing) return existing
  const row: CookieRow = { id: nextId(db.cookies), name, value, platform }
  db.cookies.push(row)
  return row
}

// ---------------------------------------------------------------------------
// 斗鱼登录状态（GET /v1/douyu/auth/status）
// ---------------------------------------------------------------------------
// 字段严格按 `app/lib/douyu-auth.ts` 的 `DouyuAuthStatus`：时间都是 Unix 秒，
// 只回安全状态，绝不回 Cookie / LTP0 / 设备号。has_* 与 refresh_state 由当前配置推出来，
// 所以在空间配置里清空 LTP0 后再看状态会立刻变成「缺少续期凭据」。

type DouyuLoginState = 'unknown' | 'valid' | 'invalid' | 'anonymous'
type DouyuRefreshState =
  | 'disabled'
  | 'missing_credentials'
  | 'scheduled'
  | 'refreshing'
  | 'retry'
  | 'credentials_invalid'

const douyu: {
  accountId: string
  loginState: DouyuLoginState
  lastSuccessAt: number | null
  lastCheckedAt: number | null
  nextRefreshAt: number | null
  failureCount: number
} = {
  accountId: '123456789',
  loginState: 'valid',
  lastSuccessAt: NOW_SEC - 2 * 3600,
  lastCheckedAt: NOW_SEC - 600,
  nextRefreshAt: NOW_SEC + 3 * 86400,
  failureCount: 0,
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

function douyuRefreshState(): DouyuRefreshState {
  if (configuration.douyu_auto_refresh === false) return 'disabled'
  if (!filled(configuration.douyu_ltp0) || !filled(configuration.douyu_refresh_device_id)) {
    return 'missing_credentials'
  }
  if (douyu.loginState === 'invalid') return 'credentials_invalid'
  if (douyu.failureCount > 0) return 'retry'
  return 'scheduled'
}

function douyuStatusPayload(streamerId: number | null) {
  const hasCookie = filled(configuration.douyu_cookie)
  const hasLtp0 = filled(configuration.douyu_ltp0)
  const hasDeviceId = filled(configuration.douyu_refresh_device_id)
  return {
    streamer_id: streamerId,
    // 前端不读的两个别名：方便别的页面/调试直接看「配没配、开没开自动续期」
    configured: hasCookie && hasLtp0,
    auto_refresh: configuration.douyu_auto_refresh !== false,
    enabled: configuration.douyu_auto_refresh !== false,
    has_cookie: hasCookie,
    has_ltp0: hasLtp0,
    has_device_id: hasDeviceId,
    login_state: hasCookie ? douyu.loginState : ('anonymous' as DouyuLoginState),
    refresh_state: douyuRefreshState(),
    account_id: hasCookie ? douyu.accountId : null,
    last_success_at: douyu.lastSuccessAt,
    last_checked_at: douyu.lastCheckedAt,
    next_refresh_at: douyu.nextRefreshAt,
    failure_count: douyu.failureCount,
    needs_login: douyu.loginState === 'invalid',
  }
}

// ---------------------------------------------------------------------------
// 用户管理（/v1/web-users）
// ---------------------------------------------------------------------------

interface WebUser {
  id: number
  username: string
  role: Role
  disabled: boolean
  created_at: number
  last_login_at: number | null
}

interface RoleInfo {
  role: Role
  permissions: Permission[]
}

/** 与 `app/lib/use-me.ts` 的 Permission 联合类型逐项一致 */
const ALL_PERMISSIONS: Permission[] = [
  'streamer.view',
  'preview.view',
  'recording.control',
  'streamer.edit',
  'streamer.hooks',
  'upload.submit',
  'template.edit',
  'account.manage',
  'config.view',
  'config.edit',
  'log.view',
  'file.view',
  'user.manage',
  'clip.edit',
  'node.manage',
]

const ROLE_VALUES: Role[] = ['admin', 'operator', 'viewer']

/** 角色目录：每个角色实际拥有的权限点，前端按它渲染「角色说明」与图例 */
const ROLES: RoleInfo[] = [
  { role: 'admin', permissions: [...ALL_PERMISSIONS] },
  {
    role: 'operator',
    permissions: [
      'streamer.view',
      'preview.view',
      'recording.control',
      'streamer.edit',
      'streamer.hooks',
      'upload.submit',
      'template.edit',
      'clip.edit',
      'account.manage',
      'config.view',
      'log.view',
      'file.view',
    ],
  },
  { role: 'viewer', permissions: ['streamer.view', 'preview.view', 'file.view', 'log.view'] },
]

let webUsers: WebUser[] = [
  {
    id: 1,
    username: 'demo',
    role: 'admin',
    disabled: false,
    created_at: NOW_SEC - 120 * 86400,
    last_login_at: NOW_SEC - 420,
  },
  {
    id: 2,
    username: 'operator01',
    role: 'operator',
    disabled: false,
    created_at: NOW_SEC - 60 * 86400,
    last_login_at: NOW_SEC - 3 * 3600,
  },
  {
    id: 3,
    username: 'viewer01',
    role: 'viewer',
    disabled: false,
    created_at: NOW_SEC - 30 * 86400,
    last_login_at: null,
  },
]

const MIN_PASSWORD_LENGTH = 8

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_VALUES.includes(value as Role)
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) return '请输入密码'
  if (new TextEncoder().encode(password).length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`
  }
  return null
}

const webUserById = (id: number) => webUsers.find((u) => u.id === id)

// ---------------------------------------------------------------------------
// B 站投稿分区树（GET /bili/archive/pre）
// ---------------------------------------------------------------------------
// 结构 = `{code, message, data: {typelist: BiliType[]}}`；BiliType 可递归，
// 这里给一级分区 + 3~5 个二级分区，tid 用 B 站投稿分区的真实编号：
// 4 游戏 / 17 单机游戏、21 生活 / 211 日常、1 动画 / 24 MAD·AMV、3 音乐 / 31 翻唱 …

interface BiliType {
  id: number
  name: string
  desc: string
  children: BiliType[]
}

const child = (id: number, name: string, desc: string): BiliType => ({ id, name, desc, children: [] })

const TYPELIST: BiliType[] = [
  {
    id: 4,
    name: '游戏',
    desc: '游戏实况、攻略与电竞赛事',
    children: [
      child(17, '单机游戏', '实况、攻略、通关'),
      child(172, '桌游棋牌', '桌游、棋牌、跑团'),
      child(19, '手机游戏', '手游实况与攻略'),
      child(65, '网络游戏', 'MMO、联机、开黑'),
      child(171, '电子竞技', '赛事、解说、复盘'),
    ],
  },
  {
    id: 21,
    name: '生活',
    desc: '日常、搞笑与手工',
    children: [
      child(211, '日常', 'vlog、生活记录'),
      child(138, '搞笑', '搞笑片段、整活'),
      child(161, '手工', '手作、模型、DIY'),
      child(217, '美食圈', '探店、做饭、吃播'),
      child(218, '动物圈', '萌宠日常'),
    ],
  },
  {
    id: 1,
    name: '动画',
    desc: '二次元创作与剪辑',
    children: [
      child(24, 'MAD·AMV', '动画剪辑、踩点'),
      child(25, 'MMD·3D', 'MMD、3D 动画'),
      child(47, '短片·手书·配音', '手书、配音、短片'),
      child(27, '综合', '综合二次元内容'),
    ],
  },
  {
    id: 36,
    name: '知识',
    desc: '科普、人文与职场',
    children: [
      child(201, '科学科普', '自然科学、数理化'),
      child(124, '社科·法律·心理', '社会、法律、心理'),
      child(228, '人文历史', '历史、文学、哲学'),
      child(207, '财经商业', '财经、商业分析'),
      child(208, '校园学习', '课程、学习方法'),
    ],
  },
  {
    id: 188,
    name: '科技',
    desc: '数码、软件与极客',
    children: [
      child(95, '数码', '手机、电脑、外设'),
      child(230, '软件应用', '软件、效率工具'),
      child(231, '计算机技术', '编程、运维、AI'),
      child(233, '极客DIY', '硬件改造、自制设备'),
    ],
  },
  {
    id: 3,
    name: '音乐',
    desc: '原创、翻唱与演奏',
    children: [
      child(28, '原创音乐', '原创歌曲、编曲'),
      child(31, '翻唱', '翻唱、 acoustic'),
      child(30, 'VOCALOID·UTAU', '虚拟歌姬调教'),
      child(59, '演奏', '乐器演奏、合奏'),
    ],
  },
  {
    id: 181,
    name: '影视',
    desc: '影视杂谈、剪辑与预告',
    children: [
      child(182, '影视杂谈', '影评、剧评'),
      child(183, '影视剪辑', '混剪、二创'),
      child(85, '短片', '原创短片'),
      child(184, '预告·资讯', '预告片、影视资讯'),
    ],
  },
  {
    id: 5,
    name: '娱乐',
    desc: '综艺、明星与娱乐杂谈',
    children: [
      child(71, '综艺', '综艺片段与整期'),
      child(137, '明星综合', '明星相关剪辑'),
      child(241, '娱乐杂谈', '娱乐向闲聊'),
      child(242, '粉丝创作', '应援、二创'),
    ],
  },
  {
    id: 129,
    name: '舞蹈',
    desc: '宅舞、街舞与舞蹈综合',
    children: [
      child(20, '宅舞', '宅舞、翻跳'),
      child(154, '街舞', '街舞、freestyle'),
      child(156, '民族舞', '民族舞、古典舞'),
      child(199, '舞蹈综合', '舞蹈合集与教学'),
    ],
  },
  {
    id: 119,
    name: '鬼畜',
    desc: '鬼畜调教与音MAD',
    children: [
      child(22, '鬼畜调教', '鬼畜、调教'),
      child(26, '音MAD', '音MAD、素材混音'),
      child(126, '人力VOCALOID', '人力调教'),
      child(127, '鬼畜剧场', '鬼畜剧情向'),
    ],
  },
  {
    id: 76,
    name: '美食',
    desc: '美食制作与探店',
    children: [
      child(212, '美食制作', '家常菜、烘焙'),
      child(213, '美食侦探', '探店、寻味'),
      child(214, '美食测评', '零食、食材测评'),
      child(216, '美食记录', '一人食、日常记录'),
    ],
  },
  {
    id: 177,
    name: '纪录片',
    desc: '人文、科学与自然',
    children: [
      child(37, '人文·历史', '历史人文纪录'),
      child(178, '科学·探索', '科学探索'),
      child(179, '社会生活', '社会观察'),
      child(180, '其他', '其他纪录片'),
    ],
  },
]

// ---------------------------------------------------------------------------
// 1. 空间配置：GET / PUT /v1/configuration
// ---------------------------------------------------------------------------

/** 空间配置的完整配置对象（含 user / auto_clip / LOGGING 三个嵌套段） */
function getConfiguration(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/configuration') return undefined
  return json(configuration)
}

/**
 * 保存空间配置：合并保存（只覆盖请求里带的键）并回传保存后的整份配置。
 * 前端 `PUT /v1/configuration` 忽略响应体，但这里返回新对象方便调试与二次读取。
 */
function putConfiguration(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'PUT' || ctx.path !== '/v1/configuration') return undefined
  const body = ctx.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('请求体必须是 JSON 对象')
  }
  configuration = mergeConfig(configuration, body)
  return json(configuration)
}

// ---------------------------------------------------------------------------
// 2. 斗鱼登录
// ---------------------------------------------------------------------------

/** 测试 Cookie 是否可用：`{valid: boolean}`，空 Cookie 直接判无效 */
function validateDouyuCookie(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/douyu/validate-cookie') return undefined
  const cookie = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any).cookie : null
  if (!filled(cookie)) return json({ valid: false, message: 'Cookie不能为空' })
  const text = String(cookie)
  // 登录凭据至少要包含 acf_uid 与 acf_auth（与真实斗鱼 Cookie 的要求一致）
  const valid = /acf_uid=/.test(text) && /acf_auth=/.test(text)
  return json({
    valid,
    account_id: valid ? douyu.accountId : null,
    message: valid ? 'Cookie有效（已通过登录验证）' : 'Cookie 缺少 acf_uid 或 acf_auth',
  })
}

/** 斗鱼登录/续期状态（只回安全状态，不回 Cookie 凭据） */
function douyuAuthStatus(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/douyu/auth/status') return undefined
  const raw = ctx.query.get('streamer_id')
  const streamerId = raw && /^\d+$/.test(raw) ? Number(raw) : null
  return json(douyuStatusPayload(streamerId))
}

/** 手动续期：真的把「上次成功 / 下次续期」往前推，界面上的时间随之变化 */
function douyuAuthRefresh(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/douyu/auth/refresh') return undefined
  const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any) : {}
  const streamerId = typeof body.streamer_id === 'number' ? body.streamer_id : null
  const nowSec = Math.floor(Date.now() / 1000)
  if (streamerId === null) {
    douyu.lastSuccessAt = nowSec
    douyu.lastCheckedAt = nowSec
    douyu.nextRefreshAt = nowSec + 3 * 86400
    douyu.failureCount = 0
    douyu.loginState = filled(configuration.douyu_cookie) ? 'valid' : 'anonymous'
  }
  const payload = douyuStatusPayload(streamerId)
  if (streamerId !== null) {
    // 房间级续期不写空间配置的状态，只让这一次响应看起来是刚续期成功
    payload.last_success_at = nowSec
    payload.next_refresh_at = nowSec + 3 * 86400
    payload.refresh_state = 'scheduled'
  }
  return json(payload)
}

// ---------------------------------------------------------------------------
// 3. B 站账号 / Cookie 文件
// ---------------------------------------------------------------------------

/**
 * 账号列表：投稿模板与空间配置的「B 站 Cookie 文件」下拉都用它。
 * `value` 取凭据文件名（后端里就是 Cookie 文件路径）：模板的 `user_cookie` 与配置的
 * `user.bili_cookie_file` 存的都是文件名，下拉框的 value 必须对得上才显示成账号名。
 */
function listBiliUsers(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/users') return undefined
  return json(
    db.cookies.map((cookie) => ({
      id: cookie.id,
      name: cookieDisplayName(cookie),
      value: cookie.name,
      platform: cookie.platform,
    }))
  )
}

/** 添加账号（Cookie 文件路径）：同名的文件已存在时复用，避免列表里出现重复项 */
function createBiliUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/users') return undefined
  const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any) : {}
  const value = typeof body.value === 'string' ? body.value.trim() : ''
  if (!value) return badRequest('Cookie 文件路径不能为空')
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : cookieNameOf(value)
  const row = ensureCookie(name, value)
  return json(
    { id: row.id, name: cookieDisplayName(row), value: row.name, platform: row.platform },
    201
  )
}

/** 兼容用的存在性查询（前端当前未调用，按名字或路径查） */
function checkBiliUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/users/check') return undefined
  const key = (ctx.query.get('value') ?? ctx.query.get('name') ?? '').trim()
  const found = key ? findCookie(key) : undefined
  return json({ exists: !!found, name: found?.name ?? null, count: db.cookies.length })
}

/** 单个账号资料：`{data: {name, face}}`，账号列表用它补全昵称与头像 */
function getBiliUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET') return undefined
  const match = ctx.path.match(/^\/v1\/users\/(\d+)$/)
  if (!match) return undefined
  const cookie = db.cookies.find((c) => c.id === Number(match[1]))
  if (!cookie) return notFound('账号不存在')
  const name = cookieDisplayName(cookie)
  return json({ data: { name, face: avatarDataUri(name, cookie.id) } })
}

/** 删除账号（连 Cookie 文件一起删掉；投稿模板里仍引用它的会显示「Cookie已失效」） */
function deleteBiliUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'DELETE') return undefined
  const match = ctx.path.match(/^\/v1\/users\/(\d+)$/)
  if (!match) return undefined
  const index = db.cookies.findIndex((c) => c.id === Number(match[1]))
  if (index < 0) return notFound('账号不存在')
  db.cookies.splice(index, 1)
  return noContent()
}

/** 扫码登录第一步：拿二维码内容（前端把整个响应回传给 login_by_qrcode） */
function getQrcode(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/get_qrcode') return undefined
  return json({
    code: 0,
    message: 'ok',
    data: {
      url: 'https://passport.bilibili.com/qrcode/h5/redirect?w_web=1&token=demo_token',
      oauthKey: 'demo_token',
    },
  })
}

/**
 * 扫码登录第二步：演示站直接算扫码成功，返回凭据文件名。
 * `filename` 同时放在顶层与 `data.filename`：真实后端在顶层，接口文档里写在 data 里，
 * 两处都给，前端 `onSuccess(data.filename)` 一定能拿到值。
 */
function loginByQrcode(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/login_by_qrcode') return undefined
  const row = ensureCookie('biliup-cookies', 'biliup-cookies')
  return json({
    code: 0,
    message: 'ok',
    filename: row.name,
    data: { filename: row.name },
  })
}

// ---------------------------------------------------------------------------
// 4. 用户管理（/v1/web-users）
// ---------------------------------------------------------------------------

function listWebUsers(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/web-users') return undefined
  return json(webUsers)
}

/** 角色目录（含每个角色的权限点），前端不再手写「哪个角色能做什么」 */
function listWebUserRoles(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/web-users/roles') return undefined
  return json(ROLES)
}

/** 新建用户：用户名唯一，密码至少 8 个字符，角色必须是三种之一 */
function createWebUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/web-users') return undefined
  const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any) : {}
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (!username) return badRequest('请输入用户名')
  if (webUsers.some((u) => u.username === username)) return badRequest('用户名已存在')
  const problem = passwordProblem(body.password)
  if (problem) return badRequest(problem)
  if (!isRole(body.role)) return badRequest('角色不合法')
  const user: WebUser = {
    id: nextId(webUsers),
    username,
    role: body.role,
    disabled: false,
    created_at: NOW_SEC,
    last_login_at: null,
  }
  webUsers.push(user)
  return json(user, 201)
}

/** 修改用户：角色、启用/禁用、重置密码可以分开改（前端不同弹窗用同一个 PUT） */
function updateWebUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'PUT') return undefined
  const match = ctx.path.match(/^\/v1\/web-users\/(\d+)$/)
  if (!match) return undefined
  const user = webUserById(Number(match[1]))
  if (!user) return notFound('用户不存在')
  const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any) : {}
  if (body.role !== undefined) {
    if (!isRole(body.role)) return badRequest('角色不合法')
    user.role = body.role
  }
  if (body.disabled !== undefined) user.disabled = body.disabled === true
  if (body.password !== undefined) {
    const problem = passwordProblem(body.password)
    if (problem) return badRequest(problem)
  }
  if (body.username !== undefined && typeof body.username === 'string') {
    const username = body.username.trim()
    if (!username) return badRequest('请输入用户名')
    if (webUsers.some((u) => u.username === username && u.id !== user.id)) {
      return badRequest('用户名已存在')
    }
    user.username = username
  }
  return json(user)
}

/** 单独的重置密码接口（PUT /v1/web-users/{id}/password） */
function updateWebUserPassword(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'PUT') return undefined
  const match = ctx.path.match(/^\/v1\/web-users\/(\d+)\/password$/)
  if (!match) return undefined
  const user = webUserById(Number(match[1]))
  if (!user) return notFound('用户不存在')
  const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any) : {}
  const password = body.password ?? body.new_password
  const problem = passwordProblem(password)
  if (problem) return badRequest(problem)
  return ok({ success: true, username: user.username })
}

/** 强制下线：演示站没有真实会话，只回一个「已下线」的结果 */
function logoutAllWebUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST') return undefined
  const match = ctx.path.match(/^\/v1\/web-users\/(\d+)\/logout-all$/)
  if (!match) return undefined
  const user = webUserById(Number(match[1]))
  if (!user) return notFound('用户不存在')
  return ok({ success: true, username: user.username, revoked_sessions: 2 })
}

function deleteWebUser(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'DELETE') return undefined
  const match = ctx.path.match(/^\/v1\/web-users\/(\d+)$/)
  if (!match) return undefined
  const index = webUsers.findIndex((u) => u.id === Number(match[1]))
  if (index < 0) return notFound('用户不存在')
  webUsers.splice(index, 1)
  return noContent()
}

// ---------------------------------------------------------------------------
// 5. B 站辅助接口
// ---------------------------------------------------------------------------

/** 投稿分区树（模板编辑、发布抽屉的分区选择） */
function biliArchivePre(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/bili/archive/pre') return undefined
  return json({ code: 0, message: 'ok', data: { typelist: TYPELIST } })
}

/** B 站空间信息：`?user=` 传 Cookie 文件名，返回昵称与头像 */
function biliSpaceMyinfo(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/bili/space/myinfo') return undefined
  const key = ctx.query.get('user') ?? ''
  const cookie = key ? findCookie(key) : undefined
  const name = cookie ? cookieDisplayName(cookie) : '老番茄'
  const seed = cookie?.id ?? 1
  return json({
    code: 0,
    message: 'ok',
    data: {
      mid: 946974,
      name,
      face: avatarDataUri(name, seed),
      sign: 'biliup 演示站 · 这是假的 B 站账号',
      level: 6,
      isLogin: true,
      vip: { status: 1, type: 2, label: { text: '年度大会员' } },
    },
  })
}

/** 图片代理：离线环境拉不到外链图片，统一回一张 1×1 占位图 */
function biliProxy(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/bili/proxy') return undefined
  return placeholderPng()
}

// ---------------------------------------------------------------------------
// 6. 自动切片配置（空间配置页的「自动切片」区块）
// ---------------------------------------------------------------------------

function autoClipSection(): Record<string, any> {
  const section = configuration.auto_clip
  return section && typeof section === 'object' ? section : {}
}

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  try {
    return new URL(url.trim()).host
  } catch {
    return url.trim()
  }
}

/** 自动切片能力状态：密钥只回来源（env / config），不回明文 */
function autoClipStatus(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'GET' || ctx.path !== '/v1/auto-clip/status') return undefined
  const section = autoClipSection()
  return json({
    enabled: section.enabled === true,
    configured: filled(section.base_url) && filled(section.chat_model),
    api_host: hostOf(section.base_url),
    chat_model: section.chat_model ?? null,
    asr_host: hostOf(section.asr_base_url ?? section.base_url),
    asr_model: section.asr_model ?? null,
    key_source: 'config',
    thumbnails: section.thumbnails ?? 'auto',
    thumbnails_active: true,
    vision: true,
    asr_segments: true,
    max_asr_minutes: section.max_asr_minutes ?? 300,
    max_chat_tokens: section.max_chat_tokens ?? 300_000,
  })
}

/** 「测试连接」：按表单当前值判定，地址/模型没填就先提示 */
function autoClipTest(ctx: MockCtx): Response | undefined {
  if (ctx.method !== 'POST' || ctx.path !== '/v1/auto-clip/test') return undefined
  const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as any) : {}
  const baseUrl = body.base_url ?? autoClipSection().base_url
  const model = body.chat_model ?? autoClipSection().chat_model
  if (!filled(baseUrl) || !filled(model)) {
    return badRequest('先填写接口地址与分析用的模型，再测试连接')
  }
  return json({
    tested_at: Date.now(),
    chat: {
      status: 'ok',
      elapsed_ms: 812,
      message: `${model} 可用（演示站假数据）`,
      capable: null,
      http_status: 200,
    },
    vision: {
      status: 'ok',
      elapsed_ms: 1043,
      message: '模型可以看图',
      capable: true,
      http_status: 200,
    },
    asr: {
      status: 'ok',
      elapsed_ms: 1260,
      message: '转写接口可用',
      capable: true,
      http_status: 200,
    },
  })
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------
// 每个处理器自己判断 method + path，不属于自己的一律 return undefined。
// 顺序无关紧要（都是精确路径或带数字 id 的正则），但保持「读在前、写在后」便于阅读。

export const configHandlers: MockHandler[] = [
  // 空间配置
  getConfiguration,
  putConfiguration,
  // 斗鱼登录
  validateDouyuCookie,
  douyuAuthStatus,
  douyuAuthRefresh,
  // B 站账号 / Cookie 文件
  listBiliUsers,
  createBiliUser,
  checkBiliUser,
  getBiliUser,
  deleteBiliUser,
  getQrcode,
  loginByQrcode,
  // 用户管理
  listWebUsers,
  listWebUserRoles,
  createWebUser,
  updateWebUser,
  updateWebUserPassword,
  logoutAllWebUser,
  deleteWebUser,
  // B 站辅助
  biliArchivePre,
  biliSpaceMyinfo,
  biliProxy,
  // 自动切片配置
  autoClipStatus,
  autoClipTest,
]

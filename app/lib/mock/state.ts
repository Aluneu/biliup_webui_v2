// ============================================================================
// Mock 层：共享内存数据
// ----------------------------------------------------------------------------
// 这里放「多个页面都要读」的实体：直播间、投稿模板、Cookie 文件、录播文件、开播信息。
// 各业务模块（streamers / sessions / renders / uploads / fleet / config）可以直接
// 读改这些数组，因此在演示站里新建直播间、暂停、删除都会真的反映到其它页面上。
// ============================================================================

const now = Math.floor(Date.now() / 1000)
const mins = (n: number) => now - n * 60

/** 正在录制的验证码式状态字符串，与后端 WorkerStatus 的 Display 一致 */
export const STATUS = {
  working: 'Working',
  idle: 'Idle',
  pause: 'Pause',
  outOfSchedule: 'OutOfSchedule',
} as const

export interface StreamerRow {
  id: number
  url: string
  remark: string
  filename: string
  filename_prefix?: string
  split_time?: number
  split_size?: number
  upload_streamers_id?: number | null
  status: string
  upload_status?: string
  live_bytes_per_sec?: number | null
  live_streamer_name?: string | null
  live_cover_url?: string | null
  live_avatar_url?: string | null
  preview?: any
  session_id?: number | null
  marker_count?: number | null
  auto_clip_after_live?: boolean
  format?: string
  time_range?: string | string[]
  excluded_keywords?: string[]
  preprocessor?: any[]
  segment_processor?: any[]
  downloaded_processor?: any[]
  postprocessor?: any[]
  opt_args?: string[]
  override?: Record<string, any>
  [key: string]: any
}

export interface TemplateRow {
  id: number
  template_name: string
  user_cookie: string
  copyright: number
  copyright_source: string
  tid: number
  tid_v2?: number | null
  cover_path: string
  title: string
  description: string
  dynamic: string
  tags: string[]
  dtime: number | null
  mission_id?: number | null
  dolby: number
  hires: number
  no_reprint: number
  is_only_self: number
  up_selection_reply: number
  up_close_reply: number
  up_close_danmaku: number
  charging_pay: number
  credits: { username: string; uid: number }[]
  uploader: string
  extra_fields?: string
  [key: string]: any
}

export interface CookieRow {
  id: number
  name: string
  value: string
  platform: string
}

export interface VideoRow {
  key: number
  name: string
  updateTime: number
  size: number
  session_id?: number
  segment_start_ms?: number
}

export interface InfoRow {
  id: number
  name: string
  url: string
  title: string
  date: number
  live_cover_path: string
  has_timeline?: boolean
}

// ---------------------------------------------------------------------------
// 追加的直播间（ids 9~30）
// ---------------------------------------------------------------------------
// 上面 8 个是手写的主线房间；这里再用工厂函数铺满一屏半，让「直播管理」的分页、
// 平台筛选、批量操作、各种状态标签都有东西可点。
// 新加的录制中房间 `session_id` 为 null —— 表示刚开始拉流、第一个分段还没开写，
// 剪辑台里它们会出现在「还没生成场次」的提示里，和真实后端一致。

/** 空闲房间：只填必须字段，其余走默认值 */
function idleRoom(id: number, url: string, remark: string, extra: Partial<StreamerRow> = {}): StreamerRow {
  return {
    id,
    url,
    remark,
    filename: '{streamer}%Y-%m-%dT%H_%M_%S',
    upload_streamers_id: ((id - 1) % 4) + 1,
    status: STATUS.idle,
    upload_status: '',
    preview: null,
    session_id: null,
    marker_count: null,
    format: 'flv',
    time_range: '',
    ...extra,
  }
}

/** 录制中的房间：带预览能力与写盘速率，其余同上 */
function liveRoom(
  id: number,
  url: string,
  remark: string,
  format: 'flv' | 'mpegts' | 'fmp4',
  rate: number,
  extra: Partial<StreamerRow> = {}
): StreamerRow {
  return idleRoom(id, url, remark, {
    status: STATUS.working,
    upload_status: 'Pending',
    live_bytes_per_sec: rate,
    live_streamer_name: remark,
    live_cover_url: `https://demo.local/live/${id}/cover.jpg`,
    live_avatar_url: `https://demo.local/live/${id}/avatar.jpg`,
    preview: {
      available: true,
      format,
      codecs: format === 'fmp4' ? 'avc1.640028,mp4a.40.2' : null,
      reason: null,
      danmaku: !url.includes('twitch'),
      direct: { capable: false, reason: '演示站没有真实 CDN，统一走 biliup 中转' },
      subscribers: 0,
      max_subscribers: 4,
    },
    ...extra,
  })
}

const extraStreamers: StreamerRow[] = [
  // ---- 录制中（再加 4 路，总计 8 路在录）----
  liveRoom(9, 'https://live.bilibili.com/445566', '阿神解说', 'flv', 5_242_880, {
    format: 'flv',
    override: { segment_time: '00:30:00' },
  }),
  liveRoom(10, 'https://www.huya.com/990012', '厨房里的老陈', 'mpegts', 3_932_160, {
    format: 'ts',
    postprocessor: [{ run: 'python3 /opt/biliup/hooks/transcode.py' }],
  }),
  liveRoom(11, 'https://live.douyin.com/73312299', '小满的深夜电台', 'flv', 2_621_440, {
    preview: {
      available: false,
      format: null,
      codecs: null,
      reason: '抖音需要 App 端签名，暂不支持复用直播流做页面预览',
      danmaku: true,
      direct: { capable: false, reason: '抖音直链需要 Cookie 签名' },
      subscribers: 0,
      max_subscribers: 4,
    },
  }),
  liveRoom(12, 'https://www.twitch.tv/demo_esports', 'ESL 赛事转播', 'fmp4', 9_646_080, {
    format: 'mp4',
    excluded_keywords: ['广告', '中场休息'],
  }),

  // ---- 闲时（等开播）----
  idleRoom(13, 'https://live.bilibili.com/88231', '画画的阿May'),
  idleRoom(14, 'https://live.bilibili.com/552201', '单机老李'),
  idleRoom(15, 'https://live.bilibili.com/337788', '周三读书会', { upload_streamers_id: 2 }),
  idleRoom(16, 'https://live.bilibili.com/660012', '小白装机日记'),
  idleRoom(17, 'https://www.douyu.com/55221', '深夜食堂', {
    override: { douyu_rate: '0', douyu_codec: 'HEVC' },
  }),
  idleRoom(18, 'https://www.douyu.com/918273', '德州扑克解说'),
  idleRoom(19, 'https://www.douyu.com/4610', '民谣现场', { format: 'mp4' }),
  idleRoom(20, 'https://www.huya.com/770088', '星际争霸老将'),
  idleRoom(21, 'https://www.huya.com/330021', '户外钓鱼佬', {
    time_range: ['05:30:00', '09:00:00'],
  }),
  idleRoom(22, 'https://www.youtube.com/@demo-piano/live', '钢琴搬运工', { format: 'mp4' }),
  idleRoom(23, 'https://live.kuaishou.com/u/demo_laoxiang', '老乡的山货'),
  idleRoom(24, 'https://play.afreecatv.com/demo_bj', '韩服单排'),

  // ---- 已暂停（手动停了录制）----
  idleRoom(25, 'https://live.bilibili.com/777888', '周末电台·旧号', { status: STATUS.pause }),
  idleRoom(26, 'https://www.twitch.tv/demo_art', '插画直播间', { status: STATUS.pause }),
  idleRoom(27, 'https://www.douyu.com/66889', '夜间电台', { status: STATUS.pause }),

  // ---- 未到录制时段（有 time_range）----
  idleRoom(28, 'https://live.bilibili.com/111222', '晚八点档', {
    status: STATUS.outOfSchedule,
    time_range: ['20:00:00', '22:30:00'],
  }),
  idleRoom(29, 'https://www.youtube.com/@demo-weekly/live', '每周五直播', {
    status: STATUS.outOfSchedule,
    time_range: ['19:30:00', '21:00:00'],
    format: 'mp4',
  }),
  idleRoom(30, 'https://www.huya.com/990088', '凌晨修仙局', {
    status: STATUS.outOfSchedule,
    time_range: ['00:00:00', '03:00:00'],
  }),
]

/** 直播间覆盖的 30 个房间：8 路录制中（其中 4 路可页面预览）、暂停、闲置、未到时段，平台覆盖 bilibili/douyu/huya/douyin/twitch/youtube/kuaishou/afreecatv */
export const db: {
  streamers: StreamerRow[]
  templates: TemplateRow[]
  cookies: CookieRow[]
  videos: VideoRow[]
  infos: InfoRow[]
} = {
  streamers: [
    {
      id: 1,
      url: 'https://live.bilibili.com/77330',
      remark: '老番茄',
      filename: '{streamer}%Y-%m-%dT%H_%M_%S',
      split_time: 0,
      split_size: 0,
      upload_streamers_id: 1,
      status: STATUS.working,
      upload_status: 'Pending',
      live_bytes_per_sec: 4_404_019,
      live_streamer_name: '老番茄',
      live_cover_url: 'https://i0.hdslb.com/bfs/live/demo_cover_77330.jpg',
      live_avatar_url: 'https://i0.hdslb.com/bfs/face/demo_avatar_77330.jpg',
      preview: {
        available: true,
        format: 'flv',
        codecs: null,
        reason: null,
        danmaku: true,
        direct: { capable: false, reason: 'CDN 需要 Referer 防盗链，走 biliup 中转' },
        subscribers: 1,
        max_subscribers: 4,
      },
      session_id: 5001,
      marker_count: 3,
      auto_clip_after_live: true,
      format: 'flv',
      time_range: '',
      excluded_keywords: ['回放', '测试'],
      segment_processor: [{ render: { danmaku: true } }],
      postprocessor: ['rm'],
    },
    {
      id: 2,
      url: 'https://live.bilibili.com/21548251',
      remark: '影视飓风',
      filename: '{streamer}_{title}',
      split_time: 5400,
      split_size: 4_294_967_296,
      upload_streamers_id: 2,
      status: STATUS.working,
      upload_status: 'Working',
      live_bytes_per_sec: 8_807_093,
      live_streamer_name: '影视飓风',
      live_cover_url: 'https://i0.hdslb.com/bfs/live/demo_cover_21548251.jpg',
      live_avatar_url: 'https://i0.hdslb.com/bfs/face/demo_avatar_21548251.jpg',
      preview: {
        available: true,
        format: 'fmp4',
        codecs: 'avc1.640028,mp4a.40.2',
        reason: null,
        danmaku: true,
        direct: { capable: true, reason: null },
        subscribers: 0,
        max_subscribers: 4,
      },
      session_id: 5002,
      marker_count: 1,
      format: 'mp4',
      time_range: '',
      override: { segment_time: '00:45:00', bili_qn: '10000' },
    },
    {
      id: 3,
      url: 'https://www.douyu.com/12345',
      remark: '水友赛直播间',
      filename: '{streamer}_{title}',
      upload_streamers_id: 3,
      status: STATUS.idle,
      upload_status: '',
      live_streamer_name: null,
      preview: null,
      session_id: null,
      format: 'flv',
      time_range: '',
      override: { douyu_rate: '0', douyu_codec: 'AVC' },
    },
    {
      id: 4,
      url: 'https://live.bilibili.com/123456',
      remark: '周末电台',
      filename: '{streamer}%Y-%m-%dT%H_%M_%S',
      status: STATUS.pause,
      upload_status: '',
      preview: null,
      session_id: null,
      format: 'flv',
      time_range: '',
    },
    {
      id: 5,
      url: 'https://live.bilibili.com/99999',
      remark: '小众音乐人',
      filename: '{streamer}_{title}',
      status: STATUS.outOfSchedule,
      upload_status: '',
      preview: null,
      session_id: null,
      format: 'flv',
      time_range: ['20:00:00', '22:00:00'],
    },
    {
      id: 6,
      url: 'https://www.huya.com/880001',
      remark: '午夜琴房',
      filename: '{streamer}%Y-%m-%dT%H_%M_%S',
      status: STATUS.working,
      upload_status: 'Pending',
      live_bytes_per_sec: 3_145_728,
      live_streamer_name: '午夜琴房',
      live_cover_url: 'https://anchorpost.msstatic.com/demo_880001.jpg',
      live_avatar_url: 'https://anchorpost.msstatic.com/demo_avatar_880001.jpg',
      preview: {
        available: false,
        format: null,
        codecs: null,
        reason: '当前下载器为 ffmpeg 子进程落盘，无法复用流做预览',
        danmaku: false,
        direct: { capable: false, reason: '虎牙直链需要 Cookie 签名' },
        subscribers: 0,
        max_subscribers: 4,
      },
      session_id: 5003,
      marker_count: 0,
      format: 'flv',
      time_range: '',
      postprocessor: [{ run: 'python3 /opt/biliup/hooks/notify.py' }],
    },
    {
      id: 7,
      url: 'https://www.youtube.com/@demo-channel/live',
      remark: '海外观察',
      filename: '{streamer}%Y-%m-%dT%H_%M_%S',
      status: STATUS.idle,
      upload_status: '',
      preview: null,
      session_id: null,
      format: 'mp4',
      time_range: '',
    },
    {
      id: 8,
      url: 'https://www.twitch.tv/demo_cat',
      remark: '猫猫台',
      filename: '{streamer}_{title}',
      status: STATUS.working,
      upload_status: 'Working',
      live_bytes_per_sec: 6_920_550,
      live_streamer_name: 'demo_cat',
      live_cover_url: 'https://static-cdn.jtvnw.net/demo_cover_cat.jpg',
      live_avatar_url: 'https://static-cdn.jtvnw.net/demo_avatar_cat.jpg',
      preview: {
        available: true,
        format: 'flv',
        codecs: null,
        reason: null,
        danmaku: false,
        direct: { capable: true, reason: null },
        subscribers: 0,
        max_subscribers: 4,
      },
      session_id: 5004,
      marker_count: 2,
      format: 'flv',
      time_range: '',
    },
    ...extraStreamers,
  ],

  templates: [
    {
      id: 1,
      template_name: '老番茄-自动投稿',
      user_cookie: 'biliup-cookies',
      copyright: 2,
      copyright_source: '转自 https://live.bilibili.com/77330',
      tid: 172,
      tid_v2: 187,
      cover_path: '',
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
      up_close_danmaku: 0,
      charging_pay: 1,
      credits: [{ username: '观众A', uid: 998877 }],
      uploader: 'biliup-rs',
      extra_fields: '{"subtitle":"open"}',
    },
    {
      id: 2,
      template_name: '影视飓风-横屏搬运',
      user_cookie: 'biliup-cookies',
      copyright: 1,
      copyright_source: '',
      tid: 211,
      tid_v2: null,
      cover_path: '',
      title: '{streamer} {title}',
      description: '自制内容，自动投稿。',
      dynamic: '',
      tags: ['影视飓风', '4K', '幕后'],
      dtime: null,
      mission_id: null,
      dolby: 0,
      hires: 0,
      no_reprint: 1,
      is_only_self: 1,
      up_selection_reply: 0,
      up_close_reply: 0,
      up_close_danmaku: 0,
      charging_pay: 0,
      credits: [],
      uploader: 'bili_web',
      extra_fields: '',
    },
    {
      id: 3,
      template_name: '水友赛-隔天投稿',
      user_cookie: 'biliup-cookies',
      copyright: 2,
      copyright_source: '转自 https://www.douyu.com/12345',
      tid: 17,
      tid_v2: null,
      cover_path: '',
      title: '深夜水友赛 第 {episode} 期',
      description: '斗鱼水友赛录播合集。',
      dynamic: '',
      tags: ['水友赛', '录播'],
      dtime: 28800,
      mission_id: null,
      dolby: 0,
      hires: 0,
      no_reprint: 1,
      is_only_self: 0,
      up_selection_reply: 1,
      up_close_reply: 0,
      up_close_danmaku: 0,
      charging_pay: 0,
      credits: [],
      uploader: 'biliup-rs',
      extra_fields: '',
    },
    {
      id: 4,
      template_name: '午夜琴房-纯音频',
      user_cookie: 'biliup-cookies',
      copyright: 1,
      copyright_source: '',
      tid: 31,
      tid_v2: null,
      cover_path: '',
      title: '午夜琴房 {date} 钢琴即兴',
      description: '钢琴即兴直播录播。',
      dynamic: '',
      tags: ['钢琴', '助眠'],
      dtime: null,
      mission_id: null,
      dolby: 0,
      hires: 0,
      no_reprint: 0,
      is_only_self: 0,
      up_selection_reply: 0,
      up_close_reply: 0,
      up_close_danmaku: 0,
      charging_pay: 0,
      credits: [],
      uploader: 'biliup-rs',
      extra_fields: '',
    },
  ],

  cookies: [
    {
      id: 1,
      name: 'biliup-cookies',
      value: 'SESSDATA=demo_****;bili_jct=demo_****;DedeUserID=12345;',
      platform: 'bilibili',
    },
    {
      id: 2,
      name: 'douyu-cookies',
      value: 'acf_uid=demo_****;acf_auth=demo_****;dy_did=demo_****;',
      platform: 'douyu',
    },
    {
      id: 3,
      name: 'huya-cookies',
      value: 'yyuid=demo_****;udb_uid=demo_****;',
      platform: 'huya',
    },
  ],

  videos: [
    { key: 1, name: '老番茄_【实况】今晚通宵打星际_2026-10-23T21_00_00.flv', updateTime: mins(48), size: 5_368_709_120, session_id: 5001, segment_start_ms: 0 },
    { key: 2, name: '老番茄_【实况】今晚通宵打星际_2026-10-23T22_30_00.flv', updateTime: mins(18), size: 2_147_483_648, session_id: 5001, segment_start_ms: 5_400_000 },
    { key: 3, name: '影视飓风_聊聊我们是怎么拍 4K 视频的_2026-10-23T20_10_00.mp4', updateTime: mins(96), size: 3_221_225_472, session_id: 5002, segment_start_ms: 0 },
    { key: 4, name: '午夜琴房_钢琴即兴_2026-10-23T22_05_00.flv', updateTime: mins(12), size: 1_073_741_824, session_id: 5003, segment_start_ms: 0 },
    { key: 5, name: '猫猫台_rank 冲分_2026-10-23T19_40_00.flv', updateTime: mins(140), size: 4_724_464_025, session_id: 5004, segment_start_ms: 0 },
    { key: 6, name: '周末电台_第 88 期_2026-10-22T20_00_00.flv', updateTime: mins(1500), size: 2_684_354_560 },
  ],

  infos: [
    {
      id: 101,
      name: '老番茄',
      url: 'https://live.bilibili.com/77330',
      title: '【实况】今晚通宵打星际，来就完了',
      date: mins(52),
      live_cover_path: 'https://i0.hdslb.com/bfs/live/demo_cover_77330.jpg',
      has_timeline: true,
    },
    {
      id: 102,
      name: '影视飓风',
      url: 'https://live.bilibili.com/21548251',
      title: '聊聊我们是怎么拍 4K 视频的（含设备清单）',
      date: mins(101),
      live_cover_path: 'https://i0.hdslb.com/bfs/live/demo_cover_21548251.jpg',
      has_timeline: true,
    },
    {
      id: 103,
      name: '午夜琴房',
      url: 'https://www.huya.com/880001',
      title: '深夜钢琴即兴 · 点歌请打在弹幕里',
      date: mins(14),
      live_cover_path: 'https://anchorpost.msstatic.com/demo_880001.jpg',
      has_timeline: true,
    },
    {
      id: 104,
      name: '阿神解说',
      url: 'https://live.bilibili.com/445566',
      title: '【解说】季前赛复盘：这波团战为什么打成这样',
      date: mins(37),
      live_cover_path: 'https://i0.hdslb.com/bfs/live/demo_cover_445566.jpg',
      // 刚开始拉流，第一个分段还没开写 → 还没有场次
      has_timeline: false,
    },
    {
      id: 105,
      name: '厨房里的老陈',
      url: 'https://www.huya.com/990012',
      title: '深夜厨房：一个人也要好好吃饭',
      date: mins(23),
      live_cover_path: 'https://anchorpost.msstatic.com/demo_990012.jpg',
      has_timeline: false,
    },
    {
      id: 106,
      name: '小满的深夜电台',
      url: 'https://live.douyin.com/73312299',
      title: '凌晨一点，聊点睡不着的话题',
      date: mins(66),
      live_cover_path: 'https://p3-pc.douyinpic.com/demo_cover_73312299.jpg',
      has_timeline: false,
    },
    {
      id: 107,
      name: 'ESL 赛事转播',
      url: 'https://www.twitch.tv/demo_esports',
      title: 'ESL Pro League · 小组赛 Day 3',
      date: mins(9),
      live_cover_path: 'https://static-cdn.jtvnw.net/demo_cover_esports.jpg',
      has_timeline: false,
    },
    {
      id: 108,
      name: '猫猫台',
      url: 'https://www.twitch.tv/demo_cat',
      title: 'rank 冲分 · 今天目标大师',
      date: mins(142),
      live_cover_path: 'https://static-cdn.jtvnw.net/demo_cover_cat.jpg',
      has_timeline: true,
    },
  ],
}

export const NOW_SEC = now

export function nextId(rows: { id: number }[]): number {
  return rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0) + 1
}

export function findStreamer(id: number): StreamerRow | undefined {
  return db.streamers.find((s) => s.id === id)
}

/** 平台 → 中文名，界面筛选与标签用 */
export const PLATFORM_LABELS: Record<string, string> = {
  bilibili: '哔哩哔哩',
  douyu: '斗鱼',
  huya: '虎牙',
  twitch: 'Twitch',
  youtube: 'YouTube',
  douyin: '抖音',
  kuaishou: '快手',
  afreecatv: 'AfreecaTV',
  twitcasting: 'TwitCasting',
  cc: '网易 CC',
  kilakila: '克拉克拉',
  nicolive: 'ニコニコ',
  other: '其它',
}

export function platformOf(url: string): string {
  if (url.includes('bilibili.com') || url.includes('b23.tv')) return 'bilibili'
  if (url.includes('douyu.com')) return 'douyu'
  if (url.includes('huya.com')) return 'huya'
  if (url.includes('twitch.tv')) return 'twitch'
  if (url.includes('youtube.com')) return 'youtube'
  if (url.includes('douyin.com')) return 'douyin'
  if (url.includes('kuaishou.com')) return 'kuaishou'
  if (url.includes('afreecatv.com')) return 'afreecatv'
  if (url.includes('twitcasting.tv')) return 'twitcasting'
  if (url.includes('cc.163.com')) return 'cc'
  if (url.includes('kilakila')) return 'kilakila'
  if (url.includes('nicovideo.jp') || url.includes('nico.ms')) return 'nicolive'
  return 'other'
}

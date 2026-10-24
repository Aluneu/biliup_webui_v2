// ============================================================================
// Mock：多机录制（Fleet）/ 节点 / 一主一备（HA）
// ----------------------------------------------------------------------------
// 覆盖本机是控制面时前端真正会打的接口（契约见 repos/webui/specs/entities.md §4）：
//   · 节点：GET /v1/fleet/nodes、GET /v1/fleet/nodes/{id}、DELETE /v1/fleet/nodes/{id}、
//           PUT /v1/fleet/nodes/{id}/labels、GET|PUT /v1/fleet/nodes/{id}/config
//   · 接入：GET|POST /v1/fleet/join-tokens、DELETE /v1/fleet/join-tokens/{id}、
//           GET|POST /v1/fleet/local-node、GET /v1/fleet/accounts
//   · 汇总 / 告警：GET /v1/fleet/summary、GET /v1/fleet/alerts、
//                 DELETE /v1/fleet/alerts/{id}、DELETE /v1/fleet/alerts
//   · 房间：GET|POST /v1/fleet/rooms、PUT|DELETE /v1/fleet/rooms/{id}、
//           POST /v1/fleet/rooms/{id}/assign、…/force、…/pause
//   · 投稿模板：GET|POST /v1/fleet/templates、PUT|DELETE /v1/fleet/templates/{id}
//   · 分层配置：GET|PUT /v1/fleet/configuration、GET /v1/fleet/configuration/history
//   · 一主一备：GET|PUT|DELETE /v1/fleet/ha、GET /v1/fleet/ha/candidates、
//               POST /v1/fleet/ha/join、…/role、…/sessions/{key}/{action}、
//               …/handback/{rooms|templates}/{id}/{abandon|force}，
//               以及配对节点那一侧的 GET /v1/node/ha、GET /v1/node/ha/candidates、
//               POST /v1/node/ha/join、PUT /v1/node/ha、POST /v1/node/ha/role、
//               POST /v1/node/ha/sessions/{key}/{action}
//   · 被移出机群：GET /v1/node/revoked、POST /v1/node/revoked/resume、
//                 DELETE /v1/node/revoked
//
// 数据是模块级内存：改节点标签、移除节点（含自动改派）、改房间、暂停、删除、
// 新建/删除投稿模板、签发/作废加入票据、确认告警、保存全局配置与节点覆盖、
// 配对 / 换上传主机 / 改模式 / 解除配对，都会真的改这里的数组，下一次轮询就能看到。
//
// 字段名照 `entities.md` §4/§8 的 FleetNode / FleetRoom / FleetTemplate 来，
// 不另造一套（房间显示名是 `remark`、房间主键是 `id`、模板账号是 `account_mid`、
// 房间的「未开播 / 录制中」在 `status` 里）。时间一律 Unix 毫秒，锚在
// state.ts 的 NOW_SEC 上，避免服务端渲染与浏览器渲染对不上。
// ============================================================================

import type { MockCtx, MockHandler } from './types'
import { badRequest, json, noContent, notFound } from './util'
import { NOW_SEC, nextId } from './state'
import type { SystemSample } from '../use-system-stats'
import type {
  FleetAccount,
  FleetNode,
  FleetNodes,
  FleetRoom,
  FleetRooms,
  FleetTemplate,
  IssuedTicket,
  JoinToken,
  JoinTokens,
  NodeAccount,
  NodeSummary,
  Removal,
  RemovedRoom,
  RoomStatus,
  ToolStatus,
} from '../use-fleet'
import type {
  ConfigHistory,
  ConfigValues,
  ConfigVersion,
  FleetConfig,
  NodeConfig,
  NodeConfigState,
} from '../fleet-config'
import type { FleetAlert, FleetAlerts, FleetSummary } from '../fleet-alerts'
import type {
  Candidates,
  ExcludedRoom,
  FleetHa,
  HaMode,
  HaParams,
  HandbackEntry,
  LocalRow,
  NodeHa,
  Pair,
  PairSync,
  Returning,
  RowsView,
  SessionRecord,
  Side,
  StandbySession,
  StandbyView,
} from '../fleet-ha'

// ---------------------------------------------------------------------------
// 基本常量与时间
// ---------------------------------------------------------------------------

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const GB = 1024 ** 3

/** 时间锚点（毫秒）：与 state.ts 的 NOW_SEC 一致 */
const NOW_MS = NOW_SEC * 1000

/** 控制面自己的显示名与版本，节点的 Fleet 协议次版本是 5（= PAIR_SINCE，双向同步） */
const CONTROLLER_NAME = 'local-controller'
const CONTROLLER_VERSION = '1.3.4'
const CONTROLLER_PROTO = 5
/** 低于这个协议次版本的节点不上报录制出错、投稿失败（与 use-fleet.ts 的 EVENTS_SINCE 一致） */
const EVENTS_SINCE = 3
const ALERT_CAPACITY = 200
const CONFIG_KEEP = 20

/** 每台节点的采样间隔（毫秒），节点卡片上的曲线用它算断口 */
const SAMPLE_INTERVAL_MS = 2000

/** 演示站里「现在」：始终不早于 NOW_MS，刷新页面后心跳不会倒退 */
function nowMs(): number {
  return Math.max(Date.now(), NOW_MS)
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/** 节点行：`summary` 里只存机器的固有信息，房间数 / 录制数按当前分派实时算 */
interface NodeRow {
  id: number
  name: string
  endpoint_id: string
  labels: string[]
  allow_hooks: boolean
  created_at: number
  last_seen_at: number | null
  version: string | null
  online: boolean
  connected_at: number | null
  path: 'relay' | 'direct' | null
  summary: NodeSummary
  interval_ms: number | null
  proto: number | null
  tools: { ffmpeg: ToolStatus } | null
  accounts: FleetAccount[]
  synced: boolean | null
  config: NodeConfigState
  removing: boolean
  local: boolean
}

const nodes: NodeRow[] = [
  {
    // 控制面这台机器自己：录制用本机的「空间配置」，不收 Fleet 配置
    id: 1,
    name: 'local',
    endpoint_id: 'local-controller',
    labels: ['华东', '海外'],
    allow_hooks: true,
    created_at: NOW_MS - 31 * DAY,
    last_seen_at: NOW_MS - 1200,
    version: CONTROLLER_VERSION,
    online: true,
    connected_at: NOW_MS - 31 * DAY,
    path: null,
    summary: {
      pools: { download: { capacity: 8, occupied: 2 }, upload: { capacity: 4, occupied: 1 } },
      rooms: 0,
      recording: 0,
      cpu: { logical: 16, physical: 8 },
      memory: { used: Math.round(11.2 * GB), total: 32 * GB, limited: false },
      disk: { path: '/data/biliup', total: 2 * 1024 * GB, used: Math.round(1.1 * 1024 * GB), available: Math.round(0.9 * 1024 * GB) },
      interfaces: ['eth0'],
    },
    interval_ms: SAMPLE_INTERVAL_MS,
    proto: CONTROLLER_PROTO,
    tools: { ffmpeg: { available: true, version: '6.1.1' } },
    accounts: [{ mid: 946974, uname: '老番茄' }],
    synced: true,
    config: { sync: 'local', error: null, outdated: false, override_keys: [] },
    removing: false,
    local: true,
  },
  {
    // 杭州边缘机：主力录制节点，4 个房间，直连
    id: 2,
    name: 'edge-hz-01',
    endpoint_id: 'edge-hz-01',
    labels: ['华东', '移动'],
    allow_hooks: true,
    created_at: NOW_MS - 12 * DAY,
    last_seen_at: NOW_MS - 1500,
    version: '1.3.4',
    online: true,
    connected_at: NOW_MS - 3 * DAY,
    path: 'direct',
    summary: {
      pools: { download: { capacity: 8, occupied: 3 }, upload: { capacity: 4, occupied: 1 } },
      rooms: 0,
      recording: 0,
      cpu: { logical: 16, physical: 8 },
      memory: { used: Math.round(9.6 * GB), total: 32 * GB, limited: false },
      disk: { path: '/data/record', total: 4 * 1024 * GB, used: Math.round(2.4 * 1024 * GB), available: Math.round(1.6 * 1024 * GB) },
      interfaces: ['eth0', 'wg0'],
    },
    interval_ms: SAMPLE_INTERVAL_MS,
    proto: CONTROLLER_PROTO,
    tools: { ffmpeg: { available: true, version: '6.1.1' } },
    accounts: [{ mid: 946974, uname: '老番茄' }],
    synced: true,
    config: { sync: 'applied', error: null, outdated: false, override_keys: ['pool1_size', 'sync_save_dir'] },
    removing: false,
    local: false,
  },
  {
    // 北京边缘机：经 relay 中转，没有 ffmpeg，磁盘吃紧（告警来源）
    id: 3,
    name: 'edge-bj-02',
    endpoint_id: 'edge-bj-02',
    labels: ['华北', '海外'],
    allow_hooks: false,
    created_at: NOW_MS - 8 * DAY,
    last_seen_at: NOW_MS - 2400,
    version: '1.3.4',
    online: true,
    connected_at: NOW_MS - 9 * HOUR,
    path: 'relay',
    summary: {
      pools: { download: { capacity: 6, occupied: 2 }, upload: { capacity: 2, occupied: 1 } },
      rooms: 0,
      recording: 0,
      cpu: { logical: 8, physical: 4 },
      memory: { used: Math.round(6.4 * GB), total: 16 * GB, limited: false },
      disk: { path: '/data/record', total: 2 * 1024 * GB, used: Math.round(1.84 * 1024 * GB), available: Math.round(0.16 * 1024 * GB) },
      interfaces: ['eth0'],
    },
    interval_ms: SAMPLE_INTERVAL_MS,
    proto: CONTROLLER_PROTO,
    tools: { ffmpeg: { available: false, version: null } },
    accounts: [{ mid: 12345678, uname: '影视飓风' }],
    synced: false,
    config: { sync: 'pending', error: null, outdated: false, override_keys: ['ffmpeg_path', 'min_free_space'] },
    removing: false,
    local: false,
  },
  {
    // 上海备机：离线 + 磁盘只剩 8%，两个告警都落在它身上
    id: 4,
    name: 'backup-sh-03',
    endpoint_id: 'backup-sh-03',
    labels: ['华东', '备份'],
    allow_hooks: false,
    created_at: NOW_MS - 20 * DAY,
    last_seen_at: NOW_MS - 47 * MIN,
    version: '1.2.9',
    online: false,
    connected_at: null,
    path: null,
    summary: {
      pools: { download: { capacity: 4, occupied: 0 }, upload: { capacity: 2, occupied: 0 } },
      rooms: 0,
      recording: 0,
      cpu: { logical: 8, physical: 4 },
      memory: { used: Math.round(4.2 * GB), total: 16 * GB, limited: false },
      disk: { path: '/mnt/backup', total: 8 * 1024 * GB, used: Math.round(7.36 * 1024 * GB), available: Math.round(0.64 * 1024 * GB) },
      interfaces: ['eth0'],
    },
    interval_ms: SAMPLE_INTERVAL_MS,
    proto: 4,
    tools: { ffmpeg: { available: true, version: '5.1.4' } },
    accounts: [],
    synced: null,
    config: { sync: null, error: null, outdated: true, override_keys: [] },
    removing: false,
    local: false,
  },
]

/** 「本机」节点：控制面自己参与的节点 id；关闭后为 null */
let localNodeId: number | null = 1

/** 「移除并自动改派」的记录，节点页顶部会显示（后端留 10 分钟，这里一直留着到关掉页面） */
const removals: Removal[] = []

function assignedRooms(nodeId: number): number {
  return rooms.filter((room) => room.node_id === nodeId && room.deleted_at === null).length
}

function recordingRooms(nodeId: number): number {
  return rooms.filter(
    (room) => room.node_id === nodeId && room.deleted_at === null && room.status === 'recording' && !room.paused,
  ).length
}

/** 节点卡片上的 CPU / 网络曲线：按节点 id 造一条平滑、确定的序列 */
function sampleSeries(seed: number, cpuBase: number, rxBase: number, txBase: number): SystemSample[] {
  const count = 36
  const end = Math.floor(nowMs() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS
  const out: SystemSample[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const w = seed + i * 0.9
    const cpu = cpuBase + Math.sin(w) * 7 + Math.sin(w * 2.7) * 2.5
    const rx = rxBase * (0.82 + 0.18 * Math.abs(Math.sin(w * 1.3)))
    const tx = txBase * (0.7 + 0.3 * Math.abs(Math.cos(w * 1.1)))
    out.push({
      ts: end - i * SAMPLE_INTERVAL_MS,
      cpu: Math.round(Math.min(97, Math.max(2, cpu)) * 10) / 10,
      rx: Math.round(rx),
      tx: Math.round(tx),
      disk_read_bytes_per_sec: Math.round(rx * 0.12),
      disk_write_bytes_per_sec: Math.round(rx * 1.4),
    })
  }
  return out
}

/** 内部节点行 → 接口里的 FleetNode（房间数、录制数、采样、心跳都按此刻算） */
function nodeView(row: NodeRow): FleetNode {
  const summary: NodeSummary = {
    ...row.summary,
    rooms: assignedRooms(row.id),
    recording: row.online ? recordingRooms(row.id) : 0,
  }
  const rx = (summary.pools.download.occupied + 1) * 2_600_000
  const tx = (summary.pools.upload.occupied + 1) * 640_000
  return {
    ...row,
    last_seen_at: row.online ? nowMs() - 1200 : row.last_seen_at,
    summary,
    assigned_rooms: assignedRooms(row.id),
    samples: row.online ? sampleSeries(row.id * 3 + 1, (summary.cpu?.logical ?? 8) * 2.4, rx, tx) : [],
  }
}

function nodeById(id: number): NodeRow | undefined {
  return nodes.find((node) => node.id === id)
}

// ---------------------------------------------------------------------------
// 房间（Fleet 分派给节点的直播间）
// ---------------------------------------------------------------------------

const rooms: FleetRoom[] = [
  {
    id: 41,
    url: 'https://live.bilibili.com/77330',
    remark: '老番茄',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'flv',
    override: { segment_time: '00:45:00', bili_qn: '10000' },
    preprocessor: null,
    segment_processor: [{ render: { danmaku: true } }],
    downloaded_processor: null,
    postprocessor: ['rm'],
    opt_args: null,
    excluded_keywords: ['回放', '测试'],
    template_id: 1,
    node_id: 1,
    epoch: 4,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 3 * DAY,
    updated_at: NOW_MS - 52 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['华东'],
    labels_missing: [],
  },
  {
    id: 42,
    url: 'https://live.bilibili.com/21548251',
    remark: '影视飓风',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'mp4',
    override: { bili_qn: '10000', segment_time: '00:45:00' },
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: 2,
    node_id: 2,
    epoch: 6,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 5 * DAY,
    updated_at: NOW_MS - 48 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['华东'],
    labels_missing: [],
  },
  {
    id: 43,
    url: 'https://www.douyu.com/12345',
    remark: '水友赛直播间',
    filename_prefix: '{streamer}_{title}',
    // 时段与「直播管理」一样是 ISO 时间的 JSON 字符串
    time_range: JSON.stringify([new Date(NOW_MS - 6 * HOUR).toISOString(), new Date(NOW_MS - 1 * HOUR).toISOString()]),
    format: 'flv',
    override: { douyu_rate: '0', douyu_codec: 'AVC' },
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: [{ mv: '/data/archive/' }],
    opt_args: null,
    excluded_keywords: null,
    template_id: 3,
    node_id: 2,
    epoch: 3,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 6 * DAY,
    updated_at: NOW_MS - 3 * HOUR,
    status: 'monitoring',
    error: null,
    releasing_online: null,
    required_labels: [],
    labels_missing: [],
  },
  {
    id: 44,
    url: 'https://www.huya.com/880001',
    remark: '午夜琴房',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'flv',
    override: { huya_cdn: 'al' },
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: [{ run: 'python3 /opt/biliup/hooks/notify.py' }],
    opt_args: ['-t', '30'],
    excluded_keywords: null,
    template_id: 3,
    node_id: 2,
    epoch: 2,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 4 * DAY,
    updated_at: NOW_MS - 41 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['移动'],
    labels_missing: [],
  },
  {
    id: 45,
    url: 'https://www.twitch.tv/demo_cat',
    remark: '猫猫台',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'flv',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: 2,
    node_id: 3,
    epoch: 5,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 9 * DAY,
    updated_at: NOW_MS - 2 * HOUR,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['海外'],
    labels_missing: [],
  },
  {
    id: 46,
    url: 'https://www.youtube.com/@demo-channel/live',
    remark: '海外观察',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'mp4',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: null,
    node_id: 3,
    epoch: 2,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 7 * DAY,
    updated_at: NOW_MS - 90 * MIN,
    status: 'monitoring',
    error: null,
    releasing_online: null,
    required_labels: ['海外'],
    labels_missing: [],
  },
  {
    id: 47,
    url: 'https://live.bilibili.com/123456',
    remark: '周末电台',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: JSON.stringify([new Date(NOW_MS - 4 * HOUR).toISOString(), new Date(NOW_MS - 2 * HOUR).toISOString()]),
    format: 'flv',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: 3,
    node_id: 1,
    epoch: 3,
    paused: true,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 14 * DAY,
    updated_at: NOW_MS - 25 * HOUR,
    status: 'paused',
    error: null,
    releasing_online: null,
    required_labels: [],
    labels_missing: [],
  },
  {
    id: 48,
    url: 'https://live.bilibili.com/99999',
    remark: '小众音乐人',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'flv',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: null,
    node_id: null,
    epoch: 1,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 2 * DAY,
    updated_at: NOW_MS - 2 * DAY,
    status: 'unassigned',
    error: null,
    releasing_online: null,
    required_labels: [],
    labels_missing: [],
  },
  {
    // 节点标签是分派之后才收紧的：房间不自动挪走，只在列表里标「标签不满足」
    id: 49,
    url: 'https://live.bilibili.com/60123',
    remark: '英雄联盟赛事',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'flv',
    override: { bili_qn: '20000' },
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: [{ run: 'python3 /opt/hooks/lol.py' }],
    opt_args: null,
    excluded_keywords: null,
    template_id: 1,
    node_id: 2,
    epoch: 2,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 11 * DAY,
    updated_at: NOW_MS - 5 * HOUR,
    status: 'monitoring',
    error: null,
    releasing_online: null,
    required_labels: ['海外'],
    labels_missing: [],
  },
  {
    id: 50,
    url: 'https://www.douyu.com/93589',
    remark: '深夜连线',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'flv',
    override: { douyu_rate: '0' },
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: null,
    node_id: 4,
    epoch: 1,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 4 * DAY,
    updated_at: NOW_MS - 47 * MIN,
    status: 'offline',
    error: null,
    releasing_online: null,
    required_labels: ['华东'],
    labels_missing: [],
  },
  {
    // 从离线的 backup-sh-03 迁回「本机」，等它上线确认释放
    id: 51,
    url: 'https://www.twitch.tv/demo_return',
    remark: '海外测试台',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'flv',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: null,
    node_id: 1,
    epoch: 3,
    paused: false,
    releasing_node_id: 4,
    deleted_at: null,
    created_at: NOW_MS - 10 * DAY,
    updated_at: NOW_MS - 35 * MIN,
    status: 'releasing',
    error: null,
    releasing_online: false,
    required_labels: ['海外'],
    labels_missing: [],
  },
  {
    id: 52,
    url: 'https://live.bilibili.com/88888',
    remark: '本地测试台',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'flv',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: null,
    node_id: 1,
    epoch: 1,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 18 * HOUR,
    updated_at: NOW_MS - 18 * HOUR,
    status: 'monitoring',
    error: null,
    releasing_online: null,
    required_labels: [],
    labels_missing: [],
  },
  // ---- 新增的 4 路录制中房间（与 state.ts 里 id 9~12 对应），让节点上的「录制中」计数与概览一致 ----
  {
    id: 53,
    url: 'https://live.bilibili.com/445566',
    remark: '阿神解说',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'flv',
    override: { segment_time: '00:30:00' },
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: 1,
    node_id: 2,
    epoch: 3,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 2 * DAY,
    updated_at: NOW_MS - 37 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['华东'],
    labels_missing: [],
  },
  {
    id: 54,
    url: 'https://www.huya.com/990012',
    remark: '厨房里的老陈',
    filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
    time_range: null,
    format: 'ts',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: [{ run: 'python3 /opt/biliup/hooks/transcode.py' }],
    opt_args: null,
    excluded_keywords: null,
    template_id: 4,
    node_id: 1,
    epoch: 2,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 26 * HOUR,
    updated_at: NOW_MS - 23 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: [],
    labels_missing: [],
  },
  {
    id: 55,
    url: 'https://live.douyin.com/73312299',
    remark: '小满的深夜电台',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'flv',
    override: { douyin_quality: 'origin' } as Record<string, string>,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: null,
    template_id: 3,
    node_id: 2,
    epoch: 4,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 5 * DAY,
    updated_at: NOW_MS - 66 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['移动'],
    labels_missing: [],
  },
  {
    id: 56,
    url: 'https://www.twitch.tv/demo_esports',
    remark: 'ESL 赛事转播',
    filename_prefix: '{streamer}_{title}',
    time_range: null,
    format: 'mp4',
    override: null,
    preprocessor: null,
    segment_processor: null,
    downloaded_processor: null,
    postprocessor: null,
    opt_args: null,
    excluded_keywords: ['广告', '中场休息'],
    template_id: 2,
    node_id: 3,
    epoch: 6,
    paused: false,
    releasing_node_id: null,
    deleted_at: null,
    created_at: NOW_MS - 11 * DAY,
    updated_at: NOW_MS - 9 * MIN,
    status: 'recording',
    error: null,
    releasing_online: null,
    required_labels: ['海外'],
    labels_missing: [],
  },
]

function roomById(id: number): FleetRoom | undefined {
  return rooms.find((room) => room.id === id)
}

/** 房间 → 接口里的 FleetRoom：`labels_missing`、`releasing_online` 按此刻的节点状态算 */
function roomView(room: FleetRoom): FleetRoom {
  const holder = room.node_id === null ? undefined : nodeById(room.node_id)
  const releasing = room.releasing_node_id === null ? undefined : nodeById(room.releasing_node_id)
  return {
    ...room,
    labels_missing: holder ? room.required_labels.filter((label) => !holder.labels.includes(label)) : [],
    releasing_online: room.releasing_node_id === null ? null : (releasing?.online ?? null),
  }
}

/** 按负载挑一台能放这个房间的在线节点（标签必须全带），没有返回 null */
function pickNode(required: string[], exclude?: number): NodeRow | null {
  const candidates = nodes.filter(
    (node) =>
      node.id !== exclude &&
      node.online &&
      !node.removing &&
      required.every((label) => node.labels.includes(label)),
  )
  if (candidates.length === 0) return null
  candidates.sort(
    (a, b) => assignedRooms(a.id) - assignedRooms(b.id) || Number(b.local) - Number(a.local) || a.id - b.id,
  )
  return candidates[0]
}

/** 改派失败时给用户看的原因 */
function unplacedReason(required: string[], exclude: number): string {
  const online = nodes.filter((node) => node.id !== exclude && node.online)
  if (online.length === 0) return '没有其他在线节点可以接手'
  if (required.length === 0) return '其他在线节点的负载都满了'
  return `没有同时带${required.map((label) => `「${label}」`).join('')}的在线节点`
}

// ---------------------------------------------------------------------------
// 投稿模板（控制面上的，节点收到后按 account_mid 换成本机凭据文件）
// ---------------------------------------------------------------------------

const templates: FleetTemplate[] = [
  {
    id: 1,
    template_name: '老番茄-自动投稿',
    title: '{streamer} {title} 直播回放',
    tid: 172,
    tid_v2: 187,
    copyright: 2,
    copyright_source: '转自 https://live.bilibili.com/77330',
    cover_path: null,
    description: '本场直播录播，由 biliup 自动投稿。',
    dynamic: '直播回放来啦 {streamer}',
    dtime: null,
    dolby: 1,
    hires: 0,
    charging_pay: 1,
    no_reprint: 1,
    is_only_self: 0,
    uploader: 'biliup-rs',
    account_mid: 946974,
    tags: ['直播回放', '老番茄', '实况'],
    credits: [{ username: '观众A', uid: 998877 }],
    up_selection_reply: 0,
    up_close_reply: 0,
    up_close_danmu: 0,
    extra_fields: '{"subtitle":"open"}',
    created_at: NOW_MS - 30 * DAY,
    updated_at: NOW_MS - 6 * DAY,
  },
  {
    id: 2,
    template_name: '影视飓风-横屏搬运',
    title: '{streamer} {title}',
    tid: 211,
    tid_v2: null,
    copyright: 1,
    copyright_source: null,
    cover_path: null,
    description: '自制内容，自动投稿。',
    dynamic: '',
    dtime: null,
    dolby: 0,
    hires: 0,
    charging_pay: 0,
    no_reprint: 1,
    is_only_self: 1,
    uploader: 'bili_web',
    account_mid: 12345678,
    tags: ['影视飓风', '4K', '幕后'],
    credits: null,
    up_selection_reply: 0,
    up_close_reply: 0,
    up_close_danmu: 0,
    extra_fields: null,
    created_at: NOW_MS - 24 * DAY,
    updated_at: NOW_MS - 4 * DAY,
  },
  {
    id: 3,
    template_name: '水友赛-隔天投稿',
    title: '深夜水友赛 第 {episode} 期',
    tid: 17,
    tid_v2: null,
    copyright: 2,
    copyright_source: '转自 https://www.douyu.com/12345',
    cover_path: null,
    description: '斗鱼水友赛录播合集。',
    dynamic: '',
    dtime: 28800,
    dolby: 0,
    hires: 0,
    charging_pay: 0,
    no_reprint: 1,
    is_only_self: 0,
    uploader: 'biliup-rs',
    account_mid: 946974,
    tags: ['水友赛', '录播'],
    credits: null,
    up_selection_reply: 1,
    up_close_reply: 0,
    up_close_danmu: 0,
    extra_fields: null,
    created_at: NOW_MS - 16 * DAY,
    updated_at: NOW_MS - 3 * DAY,
  },
]

// ---------------------------------------------------------------------------
// 加入票据
// ---------------------------------------------------------------------------

const tokens: JoinToken[] = [
  {
    id: 'tk_9f2c41',
    created_by: 1,
    created_at: NOW_MS - 6 * MIN,
    expires_at: NOW_MS + 24 * HOUR - 6 * MIN,
    used_at: null,
    used_by_node: null,
    state: 'active',
  },
  {
    id: 'tk_7d81aa',
    created_by: 1,
    created_at: NOW_MS - 3 * DAY,
    expires_at: NOW_MS - 2 * DAY,
    used_at: NOW_MS - 2 * DAY - 4 * HOUR,
    used_by_node: 3,
    state: 'used',
  },
]

let tokenSeq = 0

/** 令牌状态：过期的 active 按 expired 返回，前端按 `state === 'active'` 列可用票据 */
function tokenView(token: JoinToken): JoinToken {
  if (token.state === 'active' && token.expires_at <= nowMs()) {
    return { ...token, state: 'expired' }
  }
  return token
}

// ---------------------------------------------------------------------------
// 告警
// ---------------------------------------------------------------------------

const alerts: FleetAlert[] = [
  {
    id: 1,
    kind: 'node_offline',
    node_id: 4,
    node_name: 'backup-sh-03',
    room_id: null,
    room: null,
    url: null,
    message: 'backup-sh-03 心跳超时 90 秒（最后心跳在 47 分钟前），它上面的房间暂时由本地缓存继续录',
    first_at: NOW_MS - 47 * MIN,
    last_at: NOW_MS - 47 * MIN,
    count: 1,
    resolved_at: null,
  },
  {
    id: 2,
    kind: 'disk_low',
    node_id: 4,
    node_name: 'backup-sh-03',
    room_id: 50,
    room: '深夜连线',
    url: 'https://www.douyu.com/93589',
    message: '录制目录 /mnt/backup 剩余 8%（640 GB），低于节点配置的 min_free_space（800 GB），请清理或迁移',
    first_at: NOW_MS - 9 * HOUR,
    last_at: NOW_MS - 12 * MIN,
    count: 14,
    resolved_at: null,
  },
  {
    id: 3,
    kind: 'recording_error',
    node_id: 3,
    node_name: 'edge-bj-02',
    room_id: 46,
    room: '海外观察',
    url: 'https://www.youtube.com/@demo-channel/live',
    message: '录制异常结束：拉流超时（HTTP 504），已自动重试并在 2 分钟后重新录上',
    first_at: NOW_MS - 2 * HOUR,
    last_at: NOW_MS - 88 * MIN,
    count: 2,
    resolved_at: NOW_MS - 86 * MIN,
  },
]

// ---------------------------------------------------------------------------
// Fleet 分层配置（全局配置 ⊕ 节点覆盖）
// ---------------------------------------------------------------------------

/** 跟机器走的键，与 fleet-config.ts 的 PER_NODE_KEYS 同序（那边是前端白名单的唯一定义） */
const PER_NODE_KEYS = [
  'pool1_size',
  'pool2_size',
  'ffmpeg_path',
  'render_fonts_dir',
  'sync_save_dir',
  'min_free_space',
  'loggers_level',
]

/** 当前全局配置（第 7 版）：每个键都对应「空间配置」全局表单里的一个字段
 *  （ffmpeg_path / render_fonts_dir 这类跟机器走的键只出现在「节点覆盖」里，不放全局） */
const CURRENT_CONFIG: ConfigValues = {
  downloader: 'mesio',
  sync_save_dir: '/data/biliup-sync',
  file_size: 8 * GB,
  segment_time: 3600,
  filtering_threshold: 20,
  filename_prefix: '{streamer}%Y-%m-%dT%H_%M_%S',
  segment_processor_parallel: 2,
  uploader: 'biliup-rs',
  submit_api: 'app',
  lines: 'bldsa',
  threads: 3,
  max_upload_limit: 4,
  delay: 10,
  event_loop_interval: 30,
  pool1_size: 8,
  pool2_size: 4,
  retention_hours: 24,
  min_free_space: 20 * GB,
  preview_transport: 'relay',
  preview_max_minutes: 30,
  use_live_cover: true,
  douyu_cdn: 'hs',
  douyu_force_hs: false,
  douyu_danmaku: true,
  douyu_rate: '0',
  douyu_codec: 'HEVC',
  douyu_disable_interactive_game: false,
  huya_cdn: 'al',
  huya_cdn_fallback: true,
  huya_danmaku: true,
  huya_max_ratio: 0,
  huya_protocol: 'https',
  huya_imgplus: true,
  huya_mobile_api: false,
  douyin_danmaku: true,
  douyin_quality: 'origin',
  douyin_protocol: 'flv',
  douyin_double_screen: false,
  douyin_true_origin: false,
  cc_protocol: 'flv',
  kila_protocol: 'flv',
  bilibili_danmaku: true,
  bilibili_danmaku_detail: false,
  bilibili_danmaku_raw: false,
  bili_protocol: 'https',
  bili_cdn: 'cn-gotcha01',
  bili_liveapi: 'https://api.live.bilibili.com',
  bili_fallback_api: 'https://api.live.bilibili.com',
  bili_cdn_fallback: true,
  bili_hls_transcode_timeout: 20,
  bili_qn: 10000,
  bili_anonymous_origin: false,
  youtube_prefer_vcodec: 'h264',
  youtube_prefer_acodec: 'aac',
  youtube_max_resolution: 1080,
  youtube_max_videosize: 4 * GB,
  youtube_enable_download_live: true,
  youtube_enable_download_playback: false,
  twitch_danmaku: true,
  twitch_disable_ads: true,
  twitcasting_danmaku: true,
  twitcasting_quality: 'highest',
  loggers_level: 'info',
}

/** 历史里每一版比上一版改了哪些键，前端自己算；`note` 是给页面外的人看的中文摘要 */
type HistoryEntry = ConfigVersion & { note: string }

// 从第 3 版起逐版往上叠加，保证相邻两版的差异就是「摘要」里说的那几项
const V6_CONFIG: ConfigValues = { ...CURRENT_CONFIG, douyu_danmaku: false, preview_max_minutes: 15 }
const V5_CONFIG: ConfigValues = { ...V6_CONFIG, file_size: 4 * GB, segment_time: 7200 }
const V4_CONFIG: ConfigValues = { ...V5_CONFIG, pool1_size: 4, threads: 2 }
const V3_CONFIG: ConfigValues = { ...V4_CONFIG, preview_transport: 'direct', downloader: 'stream-gears' }

const configHistory: HistoryEntry[] = [
  {
    version: 7,
    config: { ...CURRENT_CONFIG },
    updated_at: NOW_MS - 3 * HOUR,
    updated_by: 1,
    note: '开启斗鱼弹幕录制，预览单次最长放到 30 分钟',
  },
  {
    version: 6,
    config: { ...V6_CONFIG },
    updated_at: NOW_MS - 29 * HOUR,
    updated_by: 1,
    note: '分段改成 1 小时一段，单文件上限放到 8 GB',
  },
  {
    version: 5,
    config: { ...V5_CONFIG },
    updated_at: NOW_MS - 3 * DAY,
    updated_by: 1,
    note: '下载池调到 8、上传并发调到 3（杭州那台跑满带宽）',
  },
  {
    version: 4,
    config: { ...V4_CONFIG },
    updated_at: NOW_MS - 6 * DAY,
    updated_by: 1,
    note: '预览改走 relay 中转，下载器切到 mesio',
  },
  {
    version: 3,
    config: { ...V3_CONFIG },
    updated_at: NOW_MS - 12 * DAY,
    updated_by: 1,
    note: '首次保存全局配置：下载器 stream-gears、预览直连',
  },
]

const configState: {
  version: number
  saved: boolean
  updated_at: number | null
  updated_by: number | null
  config: ConfigValues
} = {
  version: 7,
  saved: true,
  updated_at: configHistory[0].updated_at,
  updated_by: 1,
  config: { ...CURRENT_CONFIG },
}

/** 每台节点的覆盖：只存与全局不同的项 */
const nodeOverrides: Record<number, ConfigValues> = {
  1: {},
  2: { pool1_size: 6, sync_save_dir: '/data/biliup-sync' },
  3: { ffmpeg_path: '/usr/local/bin/ffmpeg', min_free_space: 200 * GB },
  4: {},
}

function globalConfigPayload(): FleetConfig {
  return {
    version: configState.version,
    saved: configState.saved,
    updated_at: configState.updated_at,
    updated_by: configState.updated_by,
    config: configState.config,
    per_node_keys: PER_NODE_KEYS,
  }
}

function nodeConfigPayload(node: NodeRow): NodeConfig {
  const override = nodeOverrides[node.id] ?? {}
  const delivered: ConfigValues = configState.saved
    ? { ...configState.config, ...override }
    : { ...override }
  return {
    node_id: node.id,
    override,
    delivered,
    global: globalConfigPayload(),
    state: node.config,
  }
}

// ---------------------------------------------------------------------------
// 一主一备（HA）
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS: HaParams = {
  offline_grace: 60,
  standby_upload_delay: 600,
  upload_start_timeout: 1800,
  upload_stall_timeout: 900,
  progress_interval: 60,
  manual_timeout: 86400,
  delete_standby_copy: false,
}

/** 对照用：配对里两台之间的同步情况 */
function pairSync(pair: Pair | null): PairSync {
  const standby = pair ? nodeById(pair.standby_node_id) : undefined
  return {
    min_proto: 5,
    linked: !!standby?.online,
    pending: 0,
    accounts: {
      count: 2,
      changed_at: NOW_MS - 26 * HOUR,
      changed_on: 'controller',
      pending: 0,
    },
  }
}

const ha: {
  pair: Pair | null
  /** 配对生效时：解除后要交还备机的房间与模板 */
  returns: { rooms: number[]; templates: number[] }
  /** 解除配对后还没交还完的行：节点 id → 那些行 */
  handback: Record<string, Returning>
  sessions: SessionRecord[]
} = {
  pair: {
    primary_node_id: 1,
    standby_node_id: 2,
    mode: 1,
    params: { ...DEFAULT_PARAMS },
    leader_node_id: 1,
    created_at: NOW_MS - 2 * DAY,
    updated_at: NOW_MS - 5 * HOUR,
  },
  returns: { rooms: [47], templates: [3] },
  handback: {},
  sessions: [
    {
      session_key: `room41@${NOW_MS - 52 * MIN}`,
      room_id: 41,
      started_at: NOW_MS - 52 * MIN,
      ended_at: null,
      primary_state: 'recording',
      standby_state: 'recording',
      uploader: null,
      bvid: null,
      upload_bytes: 0,
      progress_at: null,
      reason: null,
      updated_at: nowMs() - 5000,
    },
    {
      session_key: `room42@${NOW_MS - 48 * MIN}`,
      room_id: 42,
      started_at: NOW_MS - 48 * MIN,
      ended_at: null,
      primary_state: 'recording',
      standby_state: 'consistent',
      uploader: null,
      bvid: null,
      upload_bytes: 0,
      progress_at: null,
      reason: null,
      updated_at: nowMs() - 8000,
    },
    {
      // 上一场：主机投稿失败，备机这份等人决定 → 「待人工处理」
      session_key: `room41@${NOW_MS - 210 * MIN}`,
      room_id: 41,
      started_at: NOW_MS - 210 * MIN,
      ended_at: NOW_MS - 180 * MIN,
      primary_state: 'failed',
      standby_state: 'manual',
      uploader: null,
      bvid: null,
      upload_bytes: 5_368_709_120,
      progress_at: NOW_MS - 180 * MIN,
      reason: '主机投稿失败：账号未登录，备机这份等你决定投还是放弃',
      updated_at: NOW_MS - 180 * MIN,
    },
    {
      session_key: `room47@${NOW_MS - 26 * HOUR}`,
      room_id: 47,
      started_at: NOW_MS - 26 * HOUR,
      ended_at: NOW_MS - 25 * HOUR,
      primary_state: 'uploaded',
      standby_state: 'done',
      uploader: 'primary',
      bvid: 'BV1xx411c7mD',
      upload_bytes: Math.round(3.2 * GB),
      progress_at: NOW_MS - 25 * HOUR,
      reason: null,
      updated_at: NOW_MS - 25 * HOUR,
    },
  ],
}

/** 备机那台手里的几场（`GET /v1/node/ha`） */
const standbySessions: StandbySession[] = [
  {
    id: 'ss-1',
    key: `room42@${NOW_MS - 48 * MIN}`,
    room: 42,
    url: 'https://live.bilibili.com/21548251',
    remark: '影视飓风',
    kind: 'backup',
    state: 'recording',
    started_at: NOW_MS - 48 * MIN,
    ended_at: null,
    takeover_of: null,
    bvid: null,
    reason: null,
    since: NOW_MS - 48 * MIN,
    collected: false,
    segments: 3,
  },
  {
    id: 'ss-2',
    key: `room44@${NOW_MS - 96 * MIN}`,
    room: 44,
    url: 'https://www.huya.com/880001',
    remark: '午夜琴房',
    kind: 'backup',
    state: 'holding',
    started_at: NOW_MS - 96 * MIN,
    ended_at: NOW_MS - 6 * MIN,
    takeover_of: null,
    bvid: null,
    reason: null,
    since: NOW_MS - 6 * MIN,
    collected: true,
    segments: 12,
  },
  {
    id: 'ss-3',
    key: `room49@${NOW_MS - 150 * MIN}`,
    room: 49,
    url: 'https://live.bilibili.com/60123',
    remark: '英雄联盟赛事',
    kind: 'normal',
    state: 'manual',
    started_at: NOW_MS - 150 * MIN,
    ended_at: NOW_MS - 120 * MIN,
    takeover_of: null,
    bvid: null,
    reason: '主机那份投稿失败（账号未登录），备机这份等你决定',
    since: NOW_MS - 120 * MIN,
    collected: true,
    segments: 6,
  },
]

/** 一台上还没纳入配对的本地直播间与模板（`RowsView`），配对之后「加入配对」用 */
const standbyRows: RowsView = {
  node: 2,
  streamers: [
    { id: 301, name: '午夜琴房', url: 'https://www.huya.com/880001', hooks: true, busy: false, state: 'local', included: false },
    { id: 302, name: '水友赛直播间', url: 'https://www.douyu.com/12345', hooks: false, busy: true, state: 'local', included: false },
  ],
  templates: [
    { id: 11, name: '午夜琴房-纯音频', template: 11, hooks: false, busy: false, state: 'local', included: false },
  ],
}

const primaryRows: RowsView = {
  node: 1,
  streamers: [
    { id: 5, name: '周末电台', url: 'https://live.bilibili.com/123456', hooks: false, busy: false, state: 'local', included: false },
    { id: 7, name: '海外观察', url: 'https://www.youtube.com/@demo-channel/live', hooks: false, busy: false, state: 'local', included: false },
  ],
  templates: [{ id: 4, name: '午夜琴房-纯音频', template: 4, hooks: false, busy: false, state: 'local', included: false }],
}

function leaderSide(pair: Pair): Side {
  if (pair.leader_node_id === null) return 'controller'
  if (localNodeId !== null && pair.leader_node_id === localNodeId) return 'controller'
  return pair.leader_node_id === pair.standby_node_id ? 'node' : 'controller'
}

/** 配对里不纳入的「本机」房间：只由本机录，不参与主备 */
function excludedRooms(): ExcludedRoom[] {
  const room = roomById(52)
  if (!room || room.deleted_at !== null) return []
  return [
    {
      id: room.id,
      url: room.url,
      remark: room.remark,
      reason: '本机没有登记它要用的 B 站账号（mid 12345678），轮不到备机投',
    },
  ]
}

function rowsFor(side: Side, selection: { streamers?: unknown; templates?: unknown } | null): RowsView {
  const base = side === 'controller' ? primaryRows : standbyRows
  const pickedStreamers = numbersOf(selection?.streamers)
  const pickedTemplates = numbersOf(selection?.templates)
  return {
    node: base.node,
    streamers: (base.streamers ?? []).map((row: LocalRow) => ({ ...row, included: pickedStreamers.includes(row.id) })),
    templates: (base.templates ?? []).map((row: LocalRow) => ({ ...row, included: pickedTemplates.includes(row.id) })),
  }
}

/** 备机清单（可选带一个节点 id，让 `?standby=N` 的检查能对上） */
function standbyRowsFor(id: number): RowsView {
  return { ...standbyRows, node: id }
}

function primaryRowsFor(id: number): RowsView {
  return { ...primaryRows, node: id }
}

/** 解除配对：把当初从备机纳入的行列进「待归还」，`online` 是备机此刻在不在线 */
function dissolvePair(online: boolean): { dissolved: boolean; handed: number } {
  const pair = ha.pair
  if (!pair) return { dissolved: false, handed: 0 }
  const roomsBack: Record<string, HandbackEntry> = {}
  for (const id of ha.returns.rooms) {
    if (!roomById(id)) continue
    roomsBack[String(id)] = { stage: 'hold', url: roomById(id)?.url, template: roomById(id)?.template_id ?? undefined, local: 'idle' }
  }
  const templatesBack: Record<string, HandbackEntry> = {}
  for (const id of ha.returns.templates) {
    if (!templates.some((template) => template.id === id)) continue
    templatesBack[String(id)] = { stage: 'hold' }
  }
  const handed = Object.keys(roomsBack).length + Object.keys(templatesBack).length
  if (handed > 0) {
    ha.handback[String(pair.standby_node_id)] = {
      primary: pair.primary_node_id,
      rooms: roomsBack,
      templates: templatesBack,
      online,
    }
  }
  ha.pair = null
  ha.returns = { rooms: [], templates: [] }
  return { dissolved: true, handed }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function bodyOf(ctx: MockCtx): Record<string, any> {
  return ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, any>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 标签规范化：去空白、去重、丢掉空串（与后端一致） */
function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const label = item.trim()
    if (!label || out.includes(label)) continue
    out.push(label)
  }
  return out
}

function numbersOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
}

function haParamsOf(raw: unknown): HaParams {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {}
  const params: HaParams = { ...DEFAULT_PARAMS }
  for (const key of Object.keys(DEFAULT_PARAMS) as (keyof HaParams)[]) {
    if (key === 'delete_standby_copy') {
      if (typeof input.delete_standby_copy === 'boolean') params.delete_standby_copy = input.delete_standby_copy
      continue
    }
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      params[key] = Math.floor(value)
    }
  }
  return params
}

/** 票据里的 relay 是不是内网地址：全是内网时页面会提示「只有局域网内的节点能加入」 */
function isPrivateRelay(relay: string): boolean {
  let host = ''
  try {
    host = new URL(relay).hostname
  } catch {
    return false
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

function unique(list: string[]): string[] {
  const out: string[] = []
  for (const item of list) if (!out.includes(item)) out.push(item)
  return out
}

const ROOM_STATUS_BY_NODE = (node: NodeRow | null, paused: boolean): RoomStatus => {
  if (paused) return 'paused'
  if (!node) return 'unassigned'
  return node.online ? 'syncing' : 'offline'
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const RE_NODE = /^\/v1\/fleet\/nodes\/(\d+)$/
const RE_NODE_LABELS = /^\/v1\/fleet\/nodes\/(\d+)\/labels$/
const RE_NODE_CONFIG = /^\/v1\/fleet\/nodes\/(\d+)\/config$/
const RE_ROOM = /^\/v1\/fleet\/rooms\/(\d+)$/
const RE_ROOM_ACTION = /^\/v1\/fleet\/rooms\/(\d+)\/(assign|force|pause)$/
const RE_TEMPLATE = /^\/v1\/fleet\/templates\/(\d+)$/
const RE_TOKEN = /^\/v1\/fleet\/join-tokens\/([^/]+)$/
const RE_ALERT = /^\/v1\/fleet\/alerts\/(\d+)$/
const RE_HA_SESSION = /^\/v1\/fleet\/ha\/sessions\/([^/]+)\/(standby-upload|drop)$/
const RE_HA_HANDBACK = /^\/v1\/fleet\/ha\/handback\/(rooms|templates)\/(\d+)\/(abandon|force)$/
const RE_NODE_HA_SESSION = /^\/v1\/node\/ha\/sessions\/([^/]+)\/(standby-upload|drop)$/

// ---------------------------------------------------------------------------
// 节点 / 汇总 / 账号 / 本机节点 / 节点配置
// ---------------------------------------------------------------------------

const nodesHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (method === 'GET' && path === '/v1/fleet/nodes') {
    const payload: FleetNodes = {
      now: nowMs(),
      controller: CONTROLLER_NAME,
      controller_version: CONTROLLER_VERSION,
      controller_proto: CONTROLLER_PROTO,
      nodes: nodes.map(nodeView),
      removals,
      local_node: localNodeId,
    }
    return json(payload)
  }

  if (method === 'GET' && path === '/v1/fleet/summary') {
    const online = nodes.filter((node) => node.online)
    const payload: FleetSummary = {
      nodes_total: nodes.length,
      remote_nodes: nodes.filter((node) => !node.local).length,
      nodes_online: online.length,
      recording: online.reduce((sum, node) => sum + recordingRooms(node.id), 0),
      alerts: alerts.length,
      alerts_open: alerts.filter((alert) => alert.resolved_at === null).length,
    }
    return json(payload)
  }

  if (method === 'GET' && path === '/v1/fleet/accounts') {
    const rows: NodeAccount[] = []
    for (const node of nodes) {
      for (const account of node.accounts) {
        rows.push({
          node_id: node.id,
          mid: account.mid,
          uname: account.uname,
          reported_at: node.online ? nowMs() - 4000 : (node.last_seen_at ?? NOW_MS),
        })
      }
    }
    return json(rows)
  }

  // 启用「本机」节点：控制面自己也接收 Fleet 房间
  if (method === 'POST' && path === '/v1/fleet/local-node') {
    if (localNodeId !== null) return json({ node_id: localNodeId })
    const allowHooks = bodyOf(ctx).allow_hooks === true
    const created = nowMs()
    const node: NodeRow = {
      id: nextId(nodes),
      name: 'local',
      endpoint_id: 'local-controller',
      labels: ['华东', '海外'],
      allow_hooks: allowHooks,
      created_at: created,
      last_seen_at: created,
      version: CONTROLLER_VERSION,
      online: true,
      connected_at: created,
      path: null,
      summary: {
        pools: { download: { capacity: 8, occupied: 0 }, upload: { capacity: 4, occupied: 0 } },
        rooms: 0,
        recording: 0,
        cpu: { logical: 16, physical: 8 },
        memory: { used: Math.round(10.4 * GB), total: 32 * GB, limited: false },
        disk: { path: '/data/biliup', total: 2 * 1024 * GB, used: 1024 * GB, available: 1024 * GB },
        interfaces: ['eth0'],
      },
      interval_ms: SAMPLE_INTERVAL_MS,
      proto: CONTROLLER_PROTO,
      tools: { ffmpeg: { available: true, version: '6.1.1' } },
      accounts: [{ mid: 946974, uname: '老番茄' }],
      synced: true,
      config: { sync: 'local', error: null, outdated: false, override_keys: [] },
      removing: false,
      local: true,
    }
    nodes.push(node)
    localNodeId = node.id
    return json({ node_id: node.id }, 201)
  }

  // 节点覆盖：GET 读、PUT 存（条件写，版本对不上 409）
  const configMatch = path.match(RE_NODE_CONFIG)
  if (configMatch) {
    const node = nodeById(Number(configMatch[1]))
    if (!node) return notFound('节点不存在')
    if (method === 'GET') return json(nodeConfigPayload(node))
    if (method === 'PUT') {
      const input = bodyOf(ctx)
      const currentOverride = nodeOverrides[node.id] ?? {}
      const expectedGlobal = input.expected_global_version
      if (typeof expectedGlobal === 'number' && expectedGlobal !== configState.version) {
        return json({ message: '全局配置已被其他管理员更新', current: nodeConfigPayload(node) }, 409)
      }
      if (JSON.stringify(input.expected_override ?? {}) !== JSON.stringify(currentOverride)) {
        return json({ message: '节点覆盖已被其他管理员更新', current: nodeConfigPayload(node) }, 409)
      }
      const override =
        input.override && typeof input.override === 'object' ? (input.override as ConfigValues) : {}
      nodeOverrides[node.id] = override
      node.config = {
        ...node.config,
        override_keys: Object.keys(override),
        sync: node.local ? 'local' : node.online ? 'pending' : node.config.sync,
        error: null,
      }
      return json({ node_id: node.id, override, ignored: [] })
    }
    return undefined
  }

  // 节点标签：去空白、去重
  const labelsMatch = path.match(RE_NODE_LABELS)
  if (labelsMatch && method === 'PUT') {
    const node = nodeById(Number(labelsMatch[1]))
    if (!node) return notFound('节点不存在')
    node.labels = normalizeLabels(bodyOf(ctx).labels)
    return json({ labels: node.labels })
  }

  // 移除节点：`?reassign=auto` 时按负载把它的房间改派给其他在线节点
  const nodeMatch = path.match(RE_NODE)
  if (nodeMatch) {
    const node = nodeById(Number(nodeMatch[1]))
    if (!node) return notFound('节点不存在')
    if (method === 'GET') return json(nodeView(node))
    if (method === 'DELETE') {
      const reassign = ctx.query.get('reassign') === 'auto'
      return json(removeNode(node, reassign))
    }
    return undefined
  }

  return undefined
}

/** 移除节点（「本机」节点是关闭）：房间改派或取消分派，返回 Removal 给页面显示进度 */
function removeNode(node: NodeRow, reassign: boolean): Removal {
  const started = nowMs()
  const released: RemovedRoom[] = []
  for (const room of rooms) {
    if (room.node_id !== node.id || room.deleted_at !== null) continue
    const target = reassign ? pickNode(room.required_labels, node.id) : null
    room.node_id = target ? target.id : null
    room.releasing_node_id = null
    room.releasing_online = null
    room.status = room.paused ? 'paused' : target ? (target.online ? 'syncing' : 'offline') : 'unassigned'
    room.epoch += 1
    room.updated_at = started
    released.push({
      room_id: room.id,
      remark: room.remark,
      node_id: target ? target.id : null,
      unplaced: target ? null : reassign ? unplacedReason(room.required_labels, node.id) : '没有改派，留在未分派',
      release: node.online ? 'released' : 'offline',
    })
  }

  const removal: Removal = {
    node_id: node.id,
    node_name: node.name,
    state: 'done',
    started_at: started,
    deadline: started + 60_000,
    finished_at: started,
    rooms: released,
    reassign,
    local: node.local,
  }
  removals.unshift(removal)

  const index = nodes.indexOf(node)
  if (index >= 0) nodes.splice(index, 1)
  if (localNodeId === node.id) localNodeId = null
  if (ha.pair && (ha.pair.primary_node_id === node.id || ha.pair.standby_node_id === node.id)) {
    dissolvePair(node.online)
  }
  return removal
}

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------

const roomsHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (path === '/v1/fleet/rooms') {
    if (method === 'GET') {
      const payload: FleetRooms = { now: nowMs(), rooms: rooms.map(roomView) }
      return json(payload)
    }
    if (method === 'POST') return createRoom(ctx)
    return undefined
  }

  const actionMatch = path.match(RE_ROOM_ACTION)
  if (actionMatch && method === 'POST') {
    const room = roomById(Number(actionMatch[1]))
    if (!room) return notFound('房间不存在')
    const input = bodyOf(ctx)
    if (actionMatch[2] === 'assign') {
      const targetId = typeof input.node_id === 'number' ? input.node_id : null
      const target = targetId === null ? null : nodeById(targetId)
      if (targetId !== null && !target) return badRequest('目标节点不存在')
      const force = input.force === true
      const holderId = room.releasing_node_id ?? room.node_id
      const holder = holderId === null ? undefined : nodeById(holderId)
      const updated = nowMs()

      if (targetId === holderId) {
        // 已经在这台（或正在迁往这台），不动
        return json(roomView(room))
      }
      room.epoch += 1
      room.updated_at = updated
      if (holder && holder.online && !force && targetId !== null) {
        // 先让上一台停录、确认释放，之后才交给新节点
        room.releasing_node_id = holder.id
        room.releasing_online = holder.online
        room.node_id = targetId
        room.status = 'releasing'
      } else {
        room.releasing_node_id = null
        room.releasing_online = null
        room.node_id = targetId
        room.status = targetId === null ? 'unassigned' : target && target.online ? 'syncing' : 'offline'
      }
      return json(roomView(room))
    }

    if (actionMatch[2] === 'force') {
      // 不等上一台确认释放
      room.releasing_node_id = null
      room.releasing_online = null
      room.status = room.deleted_at !== null ? 'deleting' : ROOM_STATUS_BY_NODE(nodeById(room.node_id ?? -1) ?? null, room.paused)
      room.updated_at = nowMs()
      return json(roomView(room))
    }

    // pause
    room.paused = input.paused === true
    room.status = room.paused
      ? 'paused'
      : room.node_id === null
        ? 'unassigned'
        : nodeById(room.node_id)?.online
          ? 'monitoring'
          : 'offline'
    room.updated_at = nowMs()
    return json(roomView(room))
  }

  const match = path.match(RE_ROOM)
  if (match) {
    const room = roomById(Number(match[1]))
    if (!room) return notFound('房间不存在')
    if (method === 'PUT') return updateRoom(room, bodyOf(ctx))
    if (method === 'DELETE') {
      const force = ctx.query.get('force') === 'true' || ctx.query.get('force') === '1'
      return deleteRoom(room, force)
    }
    return undefined
  }

  return undefined
}

function createRoom(ctx: MockCtx): Response {
  const input = bodyOf(ctx)
  const url = str(input.url)
  if (!url) return badRequest('请先填写直播间地址')
  const required = normalizeLabels(input.required_labels)
  const autoNode = input.auto_node === true
  const requestedId = typeof input.node_id === 'number' ? input.node_id : null
  let target: NodeRow | null = null
  if (autoNode) {
    target = pickNode(required)
  } else if (requestedId !== null) {
    target = nodeById(requestedId) ?? null
    if (!target) return badRequest('目标节点不存在')
  }

  const created = nowMs()
  const paused = input.paused === true
  const room: FleetRoom = {
    id: nextId(rooms),
    url,
    remark: str(input.remark) || url,
    filename_prefix: input.filename_prefix ?? null,
    time_range: input.time_range ?? null,
    format: input.format ?? null,
    override: input.override ?? null,
    preprocessor: input.preprocessor ?? null,
    segment_processor: input.segment_processor ?? null,
    downloaded_processor: input.downloaded_processor ?? null,
    postprocessor: input.postprocessor ?? null,
    opt_args: input.opt_args ?? null,
    excluded_keywords: input.excluded_keywords ?? null,
    template_id: typeof input.template_id === 'number' ? input.template_id : null,
    node_id: target ? target.id : null,
    epoch: 1,
    paused,
    releasing_node_id: null,
    deleted_at: null,
    created_at: created,
    updated_at: created,
    status: paused ? 'paused' : ROOM_STATUS_BY_NODE(target, false),
    error: null,
    releasing_online: null,
    required_labels: required,
    labels_missing: [],
  }
  rooms.push(room)
  return json(roomView(room), 201)
}

function updateRoom(room: FleetRoom, input: Record<string, any>): Response {
  const specKeys = [
    'url',
    'remark',
    'filename_prefix',
    'time_range',
    'format',
    'override',
    'preprocessor',
    'segment_processor',
    'downloaded_processor',
    'postprocessor',
    'opt_args',
    'excluded_keywords',
  ] as const
  for (const key of specKeys) {
    if (key in input) {
      // 表单清空给 null，接口里一律存 null
      ;(room as any)[key] = input[key] ?? null
    }
  }
  if ('template_id' in input) {
    room.template_id = typeof input.template_id === 'number' ? input.template_id : null
  }
  // 不带 required_labels 表示保持原样
  if ('required_labels' in input) room.required_labels = normalizeLabels(input.required_labels)
  if (!room.url) return badRequest('请先填写直播间地址')
  room.remark = room.remark || room.url
  room.epoch += 1
  room.updated_at = nowMs()
  return json(roomView(room))
}

function deleteRoom(room: FleetRoom, force: boolean): Response {
  const holder = room.node_id === null ? undefined : nodeById(room.node_id)
  // 没分派、节点离线、或者明确要求强制：当场删掉
  if (force || !holder || !holder.online) {
    const index = rooms.indexOf(room)
    if (index >= 0) rooms.splice(index, 1)
    return noContent()
  }
  // 在线节点：先标记删除，等它停录确认释放（页面显示「删除中」，可强制删除）
  room.deleted_at = nowMs()
  room.releasing_node_id = room.node_id
  room.releasing_online = holder.online
  room.node_id = null
  room.status = 'deleting'
  room.updated_at = nowMs()
  return json(roomView(room))
}

// ---------------------------------------------------------------------------
// 投稿模板
// ---------------------------------------------------------------------------

const templatesHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (path === '/v1/fleet/templates') {
    if (method === 'GET') return json(templates)
    if (method === 'POST') {
      const input = bodyOf(ctx)
      const name = str(input.template_name)
      if (!name) return badRequest('请填写模板名称')
      const created = nowMs()
      const template: FleetTemplate = {
        id: nextId(templates),
        template_name: name,
        title: input.title ?? null,
        tid: typeof input.tid === 'number' ? input.tid : null,
        tid_v2: typeof input.tid_v2 === 'number' ? input.tid_v2 : null,
        copyright: typeof input.copyright === 'number' ? input.copyright : null,
        copyright_source: input.copyright_source ?? null,
        cover_path: input.cover_path ?? null,
        description: input.description ?? null,
        dynamic: input.dynamic ?? null,
        dtime: typeof input.dtime === 'number' ? input.dtime : null,
        dolby: typeof input.dolby === 'number' ? input.dolby : null,
        hires: typeof input.hires === 'number' ? input.hires : null,
        charging_pay: typeof input.charging_pay === 'number' ? input.charging_pay : null,
        no_reprint: typeof input.no_reprint === 'number' ? input.no_reprint : null,
        is_only_self: typeof input.is_only_self === 'number' ? input.is_only_self : null,
        uploader: input.uploader ?? null,
        account_mid: typeof input.account_mid === 'number' ? input.account_mid : null,
        tags: Array.isArray(input.tags) ? (input.tags as string[]).filter((tag) => typeof tag === 'string') : [],
        credits: Array.isArray(input.credits) ? input.credits : null,
        up_selection_reply: typeof input.up_selection_reply === 'number' ? input.up_selection_reply : null,
        up_close_reply: typeof input.up_close_reply === 'number' ? input.up_close_reply : null,
        up_close_danmu: typeof input.up_close_danmu === 'number' ? input.up_close_danmu : null,
        extra_fields: input.extra_fields ?? null,
        created_at: created,
        updated_at: created,
      }
      templates.push(template)
      return json(template, 201)
    }
    return undefined
  }

  const match = path.match(RE_TEMPLATE)
  if (!match) return undefined
  const index = templates.findIndex((template) => template.id === Number(match[1]))
  if (index < 0) return notFound('模板不存在')

  if (method === 'PUT') {
    const input = bodyOf(ctx)
    const current = templates[index]
    const updated: FleetTemplate = {
      ...current,
      template_name: str(input.template_name) || current.template_name,
      title: input.title ?? null,
      tid: typeof input.tid === 'number' ? input.tid : null,
      tid_v2: typeof input.tid_v2 === 'number' ? input.tid_v2 : null,
      copyright: typeof input.copyright === 'number' ? input.copyright : null,
      copyright_source: input.copyright_source ?? null,
      cover_path: input.cover_path ?? null,
      description: input.description ?? null,
      dynamic: input.dynamic ?? null,
      dtime: typeof input.dtime === 'number' ? input.dtime : null,
      dolby: typeof input.dolby === 'number' ? input.dolby : null,
      hires: typeof input.hires === 'number' ? input.hires : null,
      charging_pay: typeof input.charging_pay === 'number' ? input.charging_pay : null,
      no_reprint: typeof input.no_reprint === 'number' ? input.no_reprint : null,
      is_only_self: typeof input.is_only_self === 'number' ? input.is_only_self : null,
      uploader: input.uploader ?? null,
      account_mid: typeof input.account_mid === 'number' ? input.account_mid : null,
      tags: Array.isArray(input.tags) ? (input.tags as string[]).filter((tag) => typeof tag === 'string') : [],
      credits: Array.isArray(input.credits) ? input.credits : null,
      up_selection_reply: typeof input.up_selection_reply === 'number' ? input.up_selection_reply : null,
      up_close_reply: typeof input.up_close_reply === 'number' ? input.up_close_reply : null,
      up_close_danmu: typeof input.up_close_danmu === 'number' ? input.up_close_danmu : null,
      extra_fields: input.extra_fields ?? null,
      updated_at: nowMs(),
    }
    templates[index] = updated
    return json(updated)
  }

  if (method === 'DELETE') {
    const used = rooms.filter((room) => room.template_id === templates[index].id && room.deleted_at === null).length
    if (used > 0) return json({ message: `还有 ${used} 个房间在用这个模板，先改掉它们的模板` }, 409)
    templates.splice(index, 1)
    return noContent()
  }

  return undefined
}

// ---------------------------------------------------------------------------
// 加入票据
// ---------------------------------------------------------------------------

const tokensHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (path === '/v1/fleet/join-tokens') {
    if (method === 'GET') {
      const payload: JoinTokens = { now: nowMs(), tokens: tokens.map(tokenView) }
      return json(payload)
    }
    if (method === 'POST') return issueTicket(ctx)
    return undefined
  }

  const match = path.match(RE_TOKEN)
  if (match && method === 'DELETE') {
    const id = decodeURIComponent(match[1])
    const index = tokens.findIndex((token) => token.id === id)
    if (index < 0) return notFound('票据不存在或已经用掉')
    tokens.splice(index, 1)
    return noContent()
  }

  return undefined
}

function issueTicket(ctx: MockCtx): Response {
  const input = bodyOf(ctx)
  const extra = Array.isArray(input.extra_relays)
    ? (input.extra_relays as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const created = nowMs()
  const expires = created + 24 * HOUR
  tokenSeq += 1
  const id = `tk_${created.toString(36)}${tokenSeq.toString(36)}`
  const relays = unique(['http://192.168.1.10:27888', ...extra.map((relay) => relay.trim())])
  const ticket = `eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.${id}.${created.toString(36)}`
  const controllerUrl = 'http://192.168.1.10:8080'
  const payload: IssuedTicket = {
    id,
    created_at: created,
    expires_at: expires,
    ticket,
    command: `biliup node join --controller ${controllerUrl} --ticket ${ticket}`,
    docker_command: `docker exec -it <容器名> biliup node join --controller ${controllerUrl} --ticket ${ticket}`,
    docker_env: `BILIUP_TICKET=${ticket}`,
    relays,
    private_only: relays.every(isPrivateRelay),
    relay_port: 27888,
  }
  tokens.unshift({
    id,
    created_by: 1,
    created_at: created,
    expires_at: expires,
    used_at: null,
    used_by_node: null,
    state: 'active',
  })
  return json(payload, 201)
}

// ---------------------------------------------------------------------------
// 告警
// ---------------------------------------------------------------------------

const alertsHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (path === '/v1/fleet/alerts') {
    if (method === 'GET') {
      const payload: FleetAlerts = {
        now: nowMs(),
        alerts,
        capacity: ALERT_CAPACITY,
        events_since: EVENTS_SINCE,
      }
      return json(payload)
    }
    // 「全部知道了」
    if (method === 'DELETE') {
      const cleared = alerts.length
      alerts.splice(0, alerts.length)
      return json({ cleared })
    }
    return undefined
  }

  const match = path.match(RE_ALERT)
  if (match && method === 'DELETE') {
    const index = alerts.findIndex((alert) => alert.id === Number(match[1]))
    if (index < 0) return notFound('告警不存在（可能已经清掉了）')
    alerts.splice(index, 1)
    return noContent()
  }

  return undefined
}

// ---------------------------------------------------------------------------
// 分层配置：全局配置 + 历史版本
// ---------------------------------------------------------------------------

const configHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (path === '/v1/fleet/configuration') {
    if (method === 'GET') return json(globalConfigPayload())
    if (method === 'PUT') {
      const input = bodyOf(ctx)
      const expected = typeof input.expected_version === 'number' ? input.expected_version : configState.version
      if (expected !== configState.version) {
        return json({ message: '配置已被其他管理员更新，请刷新后重试', current: globalConfigPayload() }, 409)
      }
      const next: ConfigValues =
        input.config && typeof input.config === 'object' ? (input.config as ConfigValues) : {}
      const changed = JSON.stringify(next) !== JSON.stringify(configState.config)
      if (changed) {
        const savedAt = nowMs()
        configState.version += 1
        configState.config = next
        configState.saved = true
        configState.updated_at = savedAt
        configState.updated_by = 1
        configHistory.unshift({
          version: configState.version,
          config: { ...next },
          updated_at: savedAt,
          updated_by: 1,
          note: '在演示站保存的全局配置',
        })
        if (configHistory.length > CONFIG_KEEP) configHistory.pop()
        // 在线节点开始收新配置
        for (const node of nodes) {
          if (node.online && !node.local) node.config = { ...node.config, sync: 'pending', error: null }
        }
      }
      const payload: FleetConfig = { ...globalConfigPayload(), changed, ignored: [] }
      return json(payload)
    }
    return undefined
  }

  if (method === 'GET' && path === '/v1/fleet/configuration/history') {
    const payload: ConfigHistory = { keep: CONFIG_KEEP, versions: configHistory }
    return json(payload)
  }

  return undefined
}

// ---------------------------------------------------------------------------
// 一主一备（HA）：控制面侧 + 配对节点侧
// ---------------------------------------------------------------------------

const haHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  // --- 控制面侧 ---
  if (path === '/v1/fleet/ha') {
    if (method === 'GET') return json(fleetHaPayload())
    if (method === 'PUT') {
      const input = bodyOf(ctx)
      const standbyId = typeof input.standby === 'number' ? input.standby : (ha.pair?.standby_node_id ?? null)
      if (standbyId === null) return badRequest('请先选择一台备机')
      const standbyNode = nodeById(standbyId)
      if (!standbyNode || standbyNode.local) return badRequest('备机不存在或不能是「本机」')
      if (!standbyNode.online) return badRequest('备机不在线：等它连上再来配对')
      const mode: HaMode = input.mode === 2 ? 2 : 1
      const existing = ha.pair
      const created = nowMs()
      const pair: Pair = {
        primary_node_id: localNodeId ?? existing?.primary_node_id ?? 1,
        standby_node_id: standbyNode.id,
        mode,
        params: haParamsOf(input.params),
        leader_node_id: existing?.leader_node_id ?? (localNodeId ?? 1),
        created_at: existing?.created_at ?? created,
        updated_at: created,
      }
      ha.pair = pair
      if (!existing) ha.returns = { rooms: [47], templates: [3] }
      const adopt = input.adopt && typeof input.adopt === 'object' ? (input.adopt as Record<string, unknown>) : null
      return json({ pair, adoption: rowsFor('node', adopt) })
    }
    if (method === 'DELETE') {
      const result = dissolvePair(nodeById(ha.pair?.standby_node_id ?? -1)?.online ?? false)
      return json({ dissolved: result.dissolved })
    }
    return undefined
  }

  if (path === '/v1/fleet/ha/candidates' && method === 'GET') {
    const requested = Number(ctx.query.get('standby'))
    const standbyId = Number.isInteger(requested) && requested > 0 ? requested : (ha.pair?.standby_node_id ?? null)
    const payload: Candidates = {
      paired: ha.pair !== null,
      standby: standbyId === null ? null : standbyRowsFor(standbyId),
      primary: localNodeId === null ? null : primaryRowsFor(localNodeId),
    }
    return json(payload)
  }

  if (path === '/v1/fleet/ha/join' && method === 'POST') {
    const input = bodyOf(ctx)
    const side: Side = input.side === 'node' ? 'node' : 'controller'
    return json(rowsFor(side, input))
  }

  if (path === '/v1/fleet/ha/role' && method === 'POST') {
    if (!ha.pair) return badRequest('还没有配对')
    const input = bodyOf(ctx)
    ha.pair.leader_node_id =
      input.primary === 'node' ? ha.pair.standby_node_id : (localNodeId ?? ha.pair.primary_node_id)
    ha.pair.updated_at = nowMs()
    return json({ leader: input.primary === 'node' ? 'node' : 'controller' })
  }

  const sessionMatch = path.match(RE_HA_SESSION)
  if (sessionMatch && method === 'POST') {
    const key = decodeURIComponent(sessionMatch[1])
    const session = ha.sessions.find((row) => row.session_key === key)
    if (!session) return notFound('没有这一场')
    if (sessionMatch[2] === 'drop') {
      session.standby_state = 'dropped'
      session.reason = '管理员在控制面上放弃了备机这一份'
    } else {
      session.standby_state = 'uploading'
      session.uploader = 'standby'
      session.progress_at = nowMs()
      session.reason = null
    }
    session.updated_at = nowMs()
    return json({})
  }

  const handbackMatch = path.match(RE_HA_HANDBACK)
  if (handbackMatch && method === 'POST') {
    const [, kind, id, action] = handbackMatch
    const nodeKey = Object.keys(ha.handback).find((key) => {
      const returning = ha.handback[key]
      const bag = kind === 'rooms' ? returning.rooms : returning.templates
      return !!bag && id in bag
    })
    if (!nodeKey) return notFound('这一行已经交还了')
    const returning = ha.handback[nodeKey]
    if (kind === 'rooms') {
      const bag = returning.rooms ?? {}
      if (action === 'force') bag[id] = { ...(bag[id] ?? { stage: 'hold' }), stage: 'released', force: true, since: nowMs() }
      else delete bag[id]
      returning.rooms = bag
    } else {
      const bag = returning.templates ?? {}
      delete bag[id]
      returning.templates = bag
    }
    if (!Object.keys(returning.rooms ?? {}).length && !Object.keys(returning.templates ?? {}).length) {
      delete ha.handback[nodeKey]
    }
    return json({})
  }

  // --- 配对节点侧（控制面自己也会以节点身份被问，这里给它一份备机视角） ---
  if (path === '/v1/node/ha') {
    if (method === 'GET') return json(nodeHaPayload())
    if (method === 'PUT') {
      if (!ha.pair) return badRequest('还没有配对')
      const input = bodyOf(ctx)
      ha.pair.mode = input.mode === 2 ? 2 : ha.pair.mode
      if (input.params) ha.pair.params = haParamsOf(input.params)
      ha.pair.updated_at = nowMs()
      return json({})
    }
    return undefined
  }

  if (path === '/v1/node/ha/candidates' && method === 'GET') {
    const nodeId = ha.pair?.standby_node_id ?? 2
    return json({
      ...standbyRowsFor(nodeId),
      paired: ha.pair !== null,
      standby: standbyRowsFor(nodeId),
      primary: primaryRowsFor(localNodeId ?? 1),
    })
  }

  if (path === '/v1/node/ha/join' && method === 'POST') {
    const input = bodyOf(ctx)
    // 节点侧只能把自己那台的行加进配对
    const view = rowsFor('node', input)
    return json({ ...view, node: ha.pair?.standby_node_id ?? view.node })
  }

  if (path === '/v1/node/ha/role' && method === 'POST') {
    if (!ha.pair) return badRequest('还没有配对')
    const input = bodyOf(ctx)
    ha.pair.leader_node_id =
      input.primary === 'node' ? ha.pair.standby_node_id : (localNodeId ?? ha.pair.primary_node_id)
    ha.pair.updated_at = nowMs()
    return json({})
  }

  const nodeSessionMatch = path.match(RE_NODE_HA_SESSION)
  if (nodeSessionMatch && method === 'POST') {
    const key = decodeURIComponent(nodeSessionMatch[1])
    const session = standbySessions.find((row) => row.key === key)
    if (!session) return notFound('没有这一场')
    if (nodeSessionMatch[2] === 'drop') {
      session.state = 'dropped'
      session.reason = '管理员放弃了这一份'
    } else {
      session.state = 'uploading'
      session.reason = null
      session.since = nowMs()
    }
    return json({})
  }

  return undefined
}

function fleetHaPayload(): FleetHa {
  const pair = ha.pair
  if (!pair) {
    const payload: FleetHa = {
      pair: null,
      active: false,
      local_node: localNodeId,
      leader: null,
      local_role: null,
      busy: null,
      standby: null,
      min_proto: 5,
      sync: { min_proto: 5, linked: false, pending: 0 },
      excluded: [],
      sessions: [],
      local_standby: null,
      handback: ha.handback,
    }
    return payload
  }
  const standbyNode = nodeById(pair.standby_node_id)
  const payload: FleetHa = {
    pair,
    active: true,
    local_node: localNodeId,
    leader: leaderSide(pair),
    local_role: 'primary',
    busy: null,
    standby: standbyNode
      ? {
          id: standbyNode.id,
          online: standbyNode.online,
          proto: standbyNode.proto,
          linked: standbyNode.online,
          reported: standbyNode.online,
        }
      : null,
    min_proto: 5,
    sync: pairSync(pair),
    excluded: excludedRooms(),
    sessions: ha.sessions,
    local_standby: null,
    handback: ha.handback,
    returns: ha.returns,
  }
  return payload
}

function nodeHaPayload(): NodeHa {
  const pair = ha.pair
  const params: HaParams = pair ? { ...pair.params } : { ...DEFAULT_PARAMS }
  const standby: StandbyView = {
    role: 'standby',
    leader: pair ? leaderSide(pair) : 'controller',
    mode: pair ? pair.mode : 1,
    params,
    primary: pair ? pair.primary_node_id : (localNodeId ?? 1),
    rooms: rooms.filter((room) => room.node_id === 2 && room.deleted_at === null).map((room) => room.id),
    linked: pair !== null,
    primary_offline: false,
    sessions: standbySessions,
  }
  return { ...standby, sync: pairSync(pair) }
}

// ---------------------------------------------------------------------------
// 被移出机群后待恢复的直播间（本机作为节点时才有内容；演示站里保持「没有」）
// ---------------------------------------------------------------------------

const revokedHandler: MockHandler = (ctx) => {
  const { method, path } = ctx

  if (path === '/v1/node/revoked') {
    if (method === 'GET') {
      return json({ controller: CONTROLLER_NAME, revoked_at: null, streamers: [], local: false })
    }
    // 「知道了」：只关提示，直播间保持暂停
    if (method === 'DELETE') return noContent()
    return undefined
  }

  if (path === '/v1/node/revoked/resume' && method === 'POST') {
    return json({ resumed: [] })
  }

  return undefined
}

// ---------------------------------------------------------------------------
// 导出：路由链按这个顺序依次询问，谁先认出 method+path 就谁处理
// ---------------------------------------------------------------------------

export const fleetHandlers: MockHandler[] = [
  nodesHandler,
  roomsHandler,
  templatesHandler,
  tokensHandler,
  alertsHandler,
  configHandler,
  haHandler,
  revokedHandler,
]

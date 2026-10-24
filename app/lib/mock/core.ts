// ============================================================================
// Mock：核心接口（当前用户 / 服务状态 / 登录登出）
// ============================================================================

import type { MockCtx, MockHandler } from './types'
import { json, ok, notFound } from './util'
import { db, NOW_SEC } from './state'

/** 演示站固定以「超级管理员 + 全部权限点」身份运行，界面上所有入口都可见 */
export const ALL_PERMISSIONS = [
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

export const ME = {
  id: 1,
  username: 'demo',
  role: 'admin',
  permissions: ALL_PERMISSIONS,
  auth_enabled: true,
  // 本机提供 Fleet 控制面能力 → 任务平台里出现「节点管理」
  fleet_controller: true,
}

export function statusPayload() {
  return {
    version: 'v1.3.4',
    downloader: 'mesio',
    uploader: 'biliup-rs',
    config_path: '/opt/biliup/config.toml',
    data_dir: '/opt/biliup/data',
    download_semaphore: db.streamers.filter((s) => s.status === 'Working').length,
    update_semaphore: db.streamers.filter((s) => s.upload_status === 'Working').length,
    uptime_sec: 97_320,
    started_at: NOW_SEC - 97_320,
    rooms: db.streamers.map((s) => ({
      id: s.id,
      url: s.url,
      remark: s.remark,
      status: s.status,
      upload_status: s.upload_status ?? '',
      session_id: s.session_id ?? null,
      filename: s.filename,
      platform: s.url.includes('douyu') ? 'douyu' : s.url.includes('huya') ? 'huya' : 'bilibili',
    })),
  }
}

export const coreHandlers: MockHandler[] = [
  // 当前用户与权限点
  (ctx) => (ctx.method === 'GET' && ctx.path === '/v1/me' ? json(ME) : undefined),

  // 退出登录：演示站只清本地标记，页面自己跳登录页
  (ctx) => (ctx.method === 'POST' && ctx.path === '/v1/logout' ? json({ success: true }) : undefined),

  // 服务状态（布局、任务平台、更新日志页都会拉）
  (ctx) => (ctx.method === 'GET' && ctx.path === '/v1/status' ? json(statusPayload()) : undefined),

  // 登录页用它探测「已初始化 / 需要注册」，返回 200 即登录模式
  (ctx) =>
    ctx.method === 'GET' && ctx.path === '/v1/users/biliup'
      ? json({ id: 1, username: 'biliup', name: 'biliup' })
      : undefined,

  // 登录 / 注册 / 改密码：演示站任意账号密码都通过
  (ctx) => {
    if (ctx.method !== 'POST') return undefined
    if (ctx.path === '/v1/users/login') return ok({ success: true, token: 'demo-token', user: ME })
    if (ctx.path === '/v1/users/register') return ok({ success: true, id: 1 })
    if (ctx.path === '/v1/me/password') return ok({ success: true })
    return undefined
  },

  // 版本信息（页脚 / 更新日志）
  (ctx) =>
    ctx.method === 'GET' && ctx.path === '/v1/version'
      ? json({ version: 'v1.3.4', commit: 'demo' })
      : undefined,
]

/**
 * 兜底：所有模块都没接住的 `/v1` 请求返回 404。
 * 前端 SWR 会走 error 分支（页面显示空态），而不是拿到空对象后崩在 `.map()` 上。
 */
export const fallbackHandler: MockHandler = (ctx: MockCtx) => {
  if (ctx.path.startsWith('/v1/') || ctx.path === '/v1') {
    return notFound(`mock 未实现：${ctx.method} ${ctx.path}`)
  }
  return undefined
}

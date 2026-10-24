'use client'

// ============================================================================
// 演示站登录态（纯前端假登录）
// ----------------------------------------------------------------------------
// 真实 biliup 的登录态在服务端（HttpOnly Cookie + /v1/me）。演示站没有后端，
// 这里用 localStorage 一个标记位模拟：登录页写入，主布局读它做守卫，退出时清掉。
// 任何账号密码都能登录，登录接口本身由 mock 层无条件返回成功。
// ============================================================================

const KEY = 'biliup_demo_login'

export function markSignedIn(username = 'demo') {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ username, at: Date.now() }))
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

export function isSignedIn(): boolean {
  try {
    return !!window.localStorage.getItem(KEY)
  } catch {
    return false
  }
}

export function signOut() {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* 同上 */
  }
}

'use client'

// ============================================================================
// 静态导出专用的导航适配层
// ----------------------------------------------------------------------------
// 演示站是 `output: 'export'` 的纯静态站，没有 Node 服务器提供 RSC 软导航，
// 因此这里把上游用到的 `next/link` 与 `useRouter()` 换成「整页跳转」实现，
// 并统一补上 GitHub Pages 子路径（basePath）前缀。
//
// 改动只影响导航方式，页面内部的 `usePathname()` / `useSearchParams()` 等
// 仍直接来自 `next/navigation`（这里已原样 re-export）。
// ============================================================================

import React from 'react'
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useRouter as useNextRouter } from 'next/navigation'

/** 构建期注入的部署前缀：根域名部署为空串，github.io/repo 部署为 `/repo` */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')

/** 给站内绝对路径补上 basePath；外部链接、锚点、data: 原样返回 */
export function withBase(href: string): string {
  if (!href) return BASE_PATH || '/'
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href
  const path = href.startsWith('/') ? href : `/${href}`
  return `${BASE_PATH}${path}`
}

/** 整页跳转（替代 router.push / router.replace） */
export function navigate(href: string, replace = false) {
  const url = withBase(href)
  if (replace) window.location.replace(url)
  else window.location.assign(url)
}

/** 当前路径（去掉 basePath），用于替代 usePathname 的原始值 */
export function currentPath(): string {
  const p = window.location.pathname || '/'
  if (BASE_PATH && p.startsWith(BASE_PATH)) return p.slice(BASE_PATH.length) || '/'
  return p
}

// 原样透传 next/navigation 的其它能力（usePathname / useSearchParams / ...）
export * from 'next/navigation'

/**
 * `next/navigation` 的 useRouter 兼容层：push/replace 变为整页跳转。
 * 静态站下软导航拿不到 RSC payload，点击会「静默无反应」，这里统一走浏览器导航。
 */
export function useRouter() {
  // 调用一次上游 hook，保持 React hook 调用顺序一致（避免 lint / hooks 规则报错）
  const router = useNextRouter()
  return React.useMemo(
    () => ({
      push: (href: string, _opts?: unknown) => navigate(href),
      replace: (href: string, _opts?: unknown) => navigate(href, true),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => window.location.reload(),
      prefetch: () => {},
      ...pickBase(router),
    }),
    [router]
  )
}

/** 保留 Biliup 可能用到的其它字段（同时不覆盖上面已定义的整页跳转语义） */
function pickBase(router: object) {
  const { push: _p, replace: _r, back: _b, forward: _f, refresh: _rf, prefetch: _pf, ...rest } = router as Record<
    string,
    unknown
  >
  return rest
}

export function redirect(href: string, _type?: unknown): never {
  navigate(href, true)
  // 静态站里不会有后续代码执行，这里只是满足 next/navigation.redirect 的类型
  throw new Error(`redirect:${href}`)
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  children?: ReactNode
  /** 上游惯用的关闭预取开关，静态站下无意义，仅接受 */
  prefetch?: boolean
  replace?: boolean
  scroll?: boolean
  shallow?: boolean
  locale?: string | false
}

/**
 * `next/link` 的替代品：渲染真正的 `<a>`，普通左键点击时整页跳转。
 * 中键 / Ctrl+点击 / 外部链接 / 新窗口等交给浏览器默认行为。
 */
export default function Link({ href, children, prefetch, replace, scroll, shallow, locale, onClick, ...rest }: LinkProps) {
  void prefetch
  void scroll
  void shallow
  void locale

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (rest.target && rest.target !== '_self') return
    if (rest.download) return
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return
    event.preventDefault()
    navigate(href, replace)
  }

  return (
    <a {...rest} href={withBase(href)} onClick={handleClick}>
      {children}
    </a>
  )
}

'use client'
import './bg-global.css'
import { useGlobalBackgroundInit } from '../lib/useGlobalBackground'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Image from 'next/image'
import useSWR from 'swr'
import { fetcher } from '../lib/api-streamer'
import ThemeButton from '../ui/ThemeButton'
import { useSystemTheme, useTheme } from '../lib/utils'
import { useIsMobile } from '../lib/useIsMobile'
import getConfig from 'next/config'
import { MOCK_ENABLED } from '../lib/mock'
import Watermark from './components/Watermark'
import styles from './layout.module.scss'

/* ============ 导航信息架构:5 组 8 项(更新日志移至版本号) ============ */

function Ic({ d, extra }: { d: string; extra?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
      {extra ? <path d={extra} /> : null}
    </svg>
  )
}

const NAV_GROUPS: { title: string; items: { href: string; label: string; icon: ReactNode }[] }[] = [
  {
    title: '总览',
    items: [
      {
        href: '/',
        label: '控制台',
        icon: <Ic d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />,
      },
    ],
  },
  {
    title: '录制',
    items: [
      {
        href: '/streamers',
        label: '直播管理',
        icon: <Ic d="M3 6h13v12H3zM16 9.5l5-2.5v10l-5-2.5" />,
      },
      {
        href: '/history',
        label: '历史记录',
        icon: <Ic d="M4 6h16M4 12h16M4 18h10" extra="M18 15v4m0 0l-2-2m2 2l2-2" />,
      },
      {
        href: '/job',
        label: '直播历史',
        icon: <Ic d="M12 7v5l3 2" extra="M12 21a9 9 0 110-18 9 9 0 010 18z" />,
      },
    ],
  },
  {
    title: '投稿',
    items: [
      {
        href: '/upload-manager',
        label: '投稿管理',
        icon: <Ic d="M12 16V4m0 0L8 8m4-4l4 4" extra="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />,
      },
    ],
  },
  {
    title: '设置',
    items: [
      {
        href: '/dashboard',
        label: '空间配置',
        icon: <Ic d="M12 15a3 3 0 100-6 3 3 0 000 6z" extra="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.2a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.2a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.2a1.7 1.7 0 001 1.5h0a1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9v0a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.2a1.7 1.7 0 00-1.5 1z" />,
      },
    ],
  },
  {
    title: '系统',
    items: [
      {
        href: '/logviewer',
        label: '实时日志',
        icon: <Ic d="M4 5h16M4 12h16M4 19h10" extra="M18 15l3 3-3 3" />,
      },
      {
        href: '/status',
        label: '任务平台',
        icon: <Ic d="M4 4h16v16H4z" extra="M4 9h16M9 4v5" />,
      },
    ],
  },
]

/* 服务状态:布局级轻量轮询,所有页面共享 */
const SIDER_KEY = 'biliup_sider_collapsed'

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mode, setMode] = useState<any>('auto')

  // ---- 演示站:登录守卫 ----
  // basePath 在 GitHub Pages 子路径部署时非空(如 /repo),本地为空。
  // 用它拼接硬跳转地址,保证登录页/退出在任意部署形态下都跳对。
  const basePath = getConfig()?.basePath ?? ''
  // 未携带模拟会话令牌(biliup_token)时重定向到登录页。
  // 必须用 window.location.replace 硬跳转(router.replace 在 output:'export' 下会死循环)。
  // 初始必须为 null:SSR 预渲染与 hydration 首次渲染一致,否则 hydration mismatch。
  const [authed, setAuthed] = useState<boolean | null>(null)
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('biliup_token') : null
    if (!token) {
      const onLogin = window.location.pathname.replace(/\/+$/, '').endsWith('/login')
      if (!onLogin) {
        window.location.replace(`${basePath}/login/`)
      }
    } else {
      setAuthed(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLogout = () => {
    localStorage.removeItem('biliup_token')
    window.location.replace(`${basePath}/login/`)
  }

  useGlobalBackgroundInit()

  // 折叠偏好持久化
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDER_KEY) === '1')
    } catch {
      /* ignore */
    }
  }, [])
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDER_KEY, c ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !c
    })
  }

  // 主题
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('mode') : null
    if (saved) setMode(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const systemTheme = useSystemTheme()
  useTheme(mode, systemTheme)
  const isDark = mode === 'dark' || (mode === 'auto' && systemTheme === 'dark')

  // 服务状态指示(离线时变红,不影响页面)
  const { data: status } = useSWR('/v1/status', fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: false,
  })
  const online = status !== undefined
  const version = (status as { version?: string } | undefined)?.version

  const navCollapsed = !isMobile && collapsed

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/')

  // 登录守卫:未认证不渲染(跳转交给 useEffect)
  if (authed !== true) return null

  return (
    <div className={styles.app}>
      {/* 移动端:汉堡按钮 + 遮罩 */}
      {isMobile && (
        <button
          className={styles.burger}
          onClick={() => setMobileNavOpen(true)}
          aria-label="打开导航"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      )}
      {isMobile && mobileNavOpen && (
        <div className={styles.overlay} onClick={() => setMobileNavOpen(false)} />
      )}

      <aside
        className={`${styles.sider} ${navCollapsed ? styles.collapsed : ''} ${
          isMobile ? styles.siderMobile : ''
        } ${mobileNavOpen ? styles.open : ''}`}
      >
        {/* 品牌区 */}
        <div className={styles.brand}>
          <Link
            href="/"
            onClick={() => isMobile && setMobileNavOpen(false)}
            aria-label="回到控制台"
          >
            <Image
              src="/logo.svg"
              alt="biliup"
              width={30}
              height={30}
              style={{ width: 30, height: 30, objectFit: 'contain' }}
              unoptimized
            />
          </Link>
          {!navCollapsed && (
            <span className={styles.brandText}>
              <Link
                href="/"
                className={styles.brandName}
                onClick={() => isMobile && setMobileNavOpen(false)}
              >
                biliup
              </Link>
              <Link href="/changelog" className={styles.brandVer} title="更新日志">
                v{version ?? '—'}
              </Link>
            </span>
          )}
        </div>

        {/* 导航 */}
        <nav className={styles.nav}>
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className={styles.group}>
              {!navCollapsed && <div className={styles.groupTitle}>{group.title}</div>}
              {group.items.map((item) => {
                const active = isActive(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.item} ${active ? styles.itemActive : ''}`}
                    title={navCollapsed ? item.label : undefined}
                    onClick={() => isMobile && setMobileNavOpen(false)}
                  >
                    <span className={styles.itemIcon}>{item.icon}</span>
                    {!navCollapsed && <span className={styles.itemText}>{item.label}</span>}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        {/* 底部:服务状态 + 工具 */}
        <div className={styles.foot}>
          {!navCollapsed && (
            <div className={styles.statusRow}>
              <span className={`${styles.statusDot} ${online ? styles.online : styles.offline}`} />
              <span className={styles.statusText}>{online ? '服务运行中' : '服务未连接'}</span>
            </div>
          )}
          <div className={styles.footBtns}>
            {MOCK_ENABLED && (
              <button
                className={styles.footBtn}
                onClick={handleLogout}
                aria-label="退出登录"
                title="退出登录(演示站)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                  <path d="M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            )}
            <ThemeButton mode={mode} setMode={setMode} systemTheme={systemTheme} />
            {!isMobile && (
              <button
                className={styles.footBtn}
                onClick={toggleCollapsed}
                aria-label={navCollapsed ? '展开侧栏' : '收起侧栏'}
                title={navCollapsed ? '展开侧栏' : '收起侧栏'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {navCollapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
                </svg>
              </button>
            )}
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        {MOCK_ENABLED && (
          <div className={styles.demoBanner}>
            演示站 · 当前展示的是模拟数据,实时日志推送与历史视频回放为离线不可用功能
          </div>
        )}
        {children}
        <Watermark color={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'} />
      </main>
    </div>
  )
}

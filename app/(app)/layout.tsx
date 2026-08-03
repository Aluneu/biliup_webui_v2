'use client'
import styles from './page.module.css'
import './bg-global.css'
import { useGlobalBackgroundInit } from '../lib/useGlobalBackground'
import { useCallback, useMemo, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import getConfig from 'next/config'
import { Button, Nav } from '@douyinfe/semi-ui'
import { OnSelectedData } from '@douyinfe/semi-ui/lib/es/navigation'
import { Layout as SeLayout } from '@douyinfe/semi-ui/lib/es/layout'
import {
  IconCloudStroked,
  IconCustomerSupport,
  IconDoubleChevronLeft,
  IconDoubleChevronRight,
  IconStar,
  IconVideoListStroked,
  IconHome,
  IconSetting,
  IconHistory,
  IconBook,
  IconMenu,
  IconExit,
} from '@douyinfe/semi-icons'
import ThemeButton from '../ui/ThemeButton'
import { useSystemTheme, useTheme } from '../lib/utils'
import { useIsMobile } from '../lib/useIsMobile'
import { MOCK_ENABLED } from '../lib/mock'
import Watermark from './components/Watermark'

/**
 * 导航项强调色 —— 统一收口到一处，避免各页面各自硬编码颜色。
 * 仅保留少量语义色，符合"设计语言"而非"随意配色"。
 */
const NAV_ACCENT: Record<string, string> = {
  home: '#ffaa00',
  manager: '#5ac262',
  'upload-manager': '#885bd2',
  dashboard: '#6b6c75',
  changelog: 'rgb(var(--semi-cyan-4))',
  job: 'rgb(250 102 76)',
  logViewer: 'rgb(var(--semi-blue-4))',
  status: 'rgba(var(--semi-lime-2), 1)',
}

function navIcon(accent: string, icon: ReactNode) {
  return (
    <div
      style={{
        backgroundColor: accent,
        borderRadius: 'var(--semi-border-radius-medium)',
        color: 'var(--semi-color-bg-0)',
        display: 'flex',
        padding: '4px',
      }}
    >
      {icon}
    </div>
  )
}

/**
 * 侧边栏导航映射。
 * 注意：本项目是 `output:'export'` 静态导出，Semi 的 Nav 会拦截 `<Link>` 的点击事件，
 * 且 next/link 的客户端路由在此形态下不可靠（点击不跳转）。因此统一在 onSelect 里用
 * window.location.href 做「硬跳转」，配合 basePath 保证本地与 GitHub Pages 子路径都正确。
 */
const ROUTE_MAP: Record<string, string> = {
  home: '/',
  history: '/history',
  dashboard: '/dashboard',
  changelog: '/changelog',
  streamers: '/streamers',
  'upload-manager': '/upload-manager',
  job: '/job',
  status: '/status',
  logViewer: '/logviewer',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { Sider } = SeLayout
  const pathname = usePathname()
  // basePath 在 GitHub Pages 子路径部署时非空（如 /repo），本地为空。
  // 用它拼接硬跳转地址，保证登录页/退出在任意部署形态下都跳对。
  const basePath = getConfig()?.basePath ?? ''

  // ---- 演示站：强制登录守卫 ----
  // 未携带模拟会话令牌（biliup_token）时，重定向到登录页，避免内容被直接浏览。
  // 注意：必须用 window.location.replace 硬跳转，不能用 router.replace。
  // 原因：本项目是 output:'export' + trailingSlash:true，router.replace('/login')
  // 会被 Next 客户端路由反复规范化成 /login/ 又绕回，形成跳转死循环（表现为登录页无限刷新）。
  // 初始必须为 null，保证 SSR 预渲染与客户端 hydration 首次渲染一致。
  // 否则服务端渲染 null、客户端却直接读 localStorage 变成 true/false，
  // 会触发 React #418/#423 hydration mismatch（表现为页面卡死、点页面无反应）。
  // 真实鉴权状态完全交给下面的 useEffect 在客户端挂载后决定。
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

  let initOpenKeys: any = []
  if (pathname.slice(1) === 'streamers' || pathname.slice(1) === 'history') {
    initOpenKeys = ['manager']
  }

  const [openKeys, setOpenKeys] = useState(initOpenKeys)
  const [selectedKeys, setSelectedKeys] = useState<any>([pathname.slice(1)])
  useGlobalBackgroundInit()

  const isMobile = useIsMobile()
  const [isCollapsed, setIsCollapsed] = useState(isMobile)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mode, setMode] = useState<any>('auto')
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('mode') : null
    if (saved) setMode(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const systemTheme = useSystemTheme()
  useTheme(mode, systemTheme)
  const isDark = mode === 'dark' || (mode === 'auto' && systemTheme === 'dark')
  const navCollapsed = isMobile ? false : isCollapsed
  let navStyle = navCollapsed ? { height: '100%', overflow: 'visible' } : { height: '100%' }

  // 兼容 PC 切移动端
  useEffect(() => {
    if (isMobile) {
      setIsCollapsed(true)
    }
  }, [isMobile])

  const items = useMemo(
    () =>
      [
        {
          itemKey: 'home',
          text: '主页',
          icon: navIcon(NAV_ACCENT.home, <IconHome size="small" />),
        },
        {
          itemKey: 'manager',
          text: '录播管理',
          items: [
            { itemKey: 'streamers', text: '直播管理' },
            { itemKey: 'history', text: '历史记录' },
          ],
          icon: navIcon(NAV_ACCENT.manager, <IconVideoListStroked size="small" />),
        },
        {
          itemKey: 'upload-manager',
          text: '投稿管理',
          icon: navIcon(NAV_ACCENT['upload-manager'], <IconCloudStroked size="small" />),
        },
        {
          itemKey: 'dashboard',
          text: '空间配置',
          icon: navIcon(NAV_ACCENT.dashboard, <IconStar size="small" />),
        },
        {
          itemKey: 'job',
          text: '直播历史',
          icon: navIcon(NAV_ACCENT.job, <IconHistory size="small" />),
        },
        {
          itemKey: 'logViewer',
          text: '实时日志',
          icon: navIcon(NAV_ACCENT.logViewer, <IconCustomerSupport size="small" />),
        },
        {
          itemKey: 'status',
          text: '任务平台',
          icon: navIcon(NAV_ACCENT.status, <IconSetting size="small" />),
        },
        {
          itemKey: 'changelog',
          text: '更新日志',
          icon: navIcon(NAV_ACCENT.changelog, <IconBook size="small" />),
        },
      ].map((value: any) => {
        value.text = (
          <div
            style={{
              color:
                selectedKeys.some((key: string) => value.itemKey === key) ||
                (selectedKeys.some((key: string) =>
                  openKeys.some((o: string | number) => isSub(key, o))
                ) &&
                  openKeys.some((key: any) => value.itemKey === key))
                  ? 'var(--semi-color-text-0)'
                  : 'var(--semi-color-text-2)',
              fontWeight: 600,
            }}
          >
            {value.text}
          </div>
        )
        return value
      }),
    [openKeys, selectedKeys]
  )
  const renderWrapper = useCallback(({ itemElement, isSubNav, isInSubNav, props }: any) => {
    if (!ROUTE_MAP[props.itemKey]) {
      return itemElement
    }
    // 静态导出下 next/link 客户端导航不可靠（点击不跳转），改用原生 <a> + onClick 硬跳转。
    // 原生锚点点击在任何情况下都会触发浏览器导航，配合 basePath 保证本地与 GitHub Pages 子路径都正确。
    const href = `${basePath}${ROUTE_MAP[props.itemKey]}`
    const target = href.endsWith('/') ? href : `${href}/`
    return (
      <a
        href={target}
        onClick={(e) => {
          e.preventDefault()
          window.location.href = target
        }}
        style={{
          textDecoration: 'none',
          fontWeight: '600 !important',
          color: 'inherit',
        }}
      >
        {itemElement}
      </a>
    )
  }, [basePath])

  const onSelect = (data: OnSelectedData) => {
    setSelectedKeys([...data.selectedKeys])
    if (isMobile) setMobileNavOpen(false)
  }
  const onOpenChange = (data: any) => {
    setOpenKeys([...data.openKeys])
  }
  const onCollapseChange = useCallback(() => {
    setIsCollapsed(!isCollapsed)
  }, [isCollapsed])
  if (authed !== true) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--semi-color-text-2)',
          fontSize: 14,
        }}
      >
        加载中…
      </div>
    )
  }

  return (
    <SeLayout className="components-layout-demo semi-light-scrollbar">
          {isMobile && (
            <Button
              type="tertiary"
              theme="borderless"
              icon={<IconMenu />}
              onClick={() => setMobileNavOpen(true)}
              style={{
                position: 'fixed',
                top: 12,
                left: 12,
                zIndex: 1001,
                backgroundColor: 'var(--semi-color-bg-0)',
                boxShadow: 'var(--semi-shadow-elevated)',
              }}
            />
          )}
          {isMobile && mobileNavOpen && (
            <div
              onClick={() => setMobileNavOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0,0,0,0.35)',
                zIndex: 999,
              }}
            />
          )}
          <Sider
            style={
              isMobile
                ? {
                    display: mobileNavOpen ? 'flex' : 'none',
                    position: 'fixed',
                    left: 0,
                    top: 0,
                    height: '100vh',
                    zIndex: 1000,
                  }
                : {}
            }
          >
            <Nav
              style={navStyle}
              openKeys={openKeys}
              selectedKeys={selectedKeys}
              isCollapsed={navCollapsed}
              renderWrapper={renderWrapper}
              items={items}
              onOpenChange={onOpenChange}
              onSelect={onSelect}
            >
              <Nav.Header
                logo={
                  <a href={`${basePath}/`} style={{ display: 'flex', alignItems: 'center' }}>
                    <img
                      src={`${basePath}/logo.svg`}
                      alt="biliup"
                      height={navCollapsed ? 36 : 90}
                      width={navCollapsed ? 36 : 140}
                      style={{
                        width: navCollapsed ? 36 : 140,
                        height: navCollapsed ? 36 : 90,
                        objectFit: 'contain',
                      }}
                    />
                  </a>
                }
                style={
                  navCollapsed
                    ? { flexDirection: 'column', padding: '16px 0 12px', gap: '8px' }
                    : { justifyContent: 'center', position: 'relative', padding: '8px 0' }
                }
              >
                <div
                  style={{
                    position: navCollapsed ? undefined : 'absolute',
                    right: navCollapsed ? undefined : 8,
                    top: navCollapsed ? undefined : 16,
                    transform: navCollapsed ? undefined : 'translateY(0)',
                    flexGrow: navCollapsed ? 1 : undefined,
                    display: isMobile ? 'none' : 'flex',
                    flexDirection: 'row-reverse',
                    zIndex: 2,
                  }}
                >
                  <Button
                    onClick={onCollapseChange}
                    type="tertiary"
                    className={styles.shadow}
                    theme="borderless"
                    icon={isCollapsed ? <IconDoubleChevronRight /> : <IconDoubleChevronLeft />}
                  />
                </div>
              </Nav.Header>
              <Nav.Footer collapseButton={false}>
                <ThemeButton mode={mode} setMode={setMode} systemTheme={systemTheme} />
              </Nav.Footer>
            </Nav>
          </Sider>
          <SeLayout
            style={{
              height: '100vh',
              boxSizing: 'border-box',
              ...(isMobile ? { paddingTop: 56 } : {}),
            }}
          >
            {MOCK_ENABLED && (
              <div
                style={{
                  backgroundColor: 'var(--semi-color-warning-light-default, #fff7e8)',
                  color: 'var(--semi-color-warning, #d25f00)',
                  fontSize: 13,
                  lineHeight: '32px',
                  textAlign: 'center',
                  padding: '0 12px',
                  borderBottom: '1px solid var(--semi-color-border)',
                }}
              >
                演示站 · 当前展示的是模拟数据，实时日志推送与历史视频回放为离线不可用功能
              </div>
            )}
            {MOCK_ENABLED && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  padding: '6px 16px',
                  borderBottom: '1px solid var(--semi-color-border)',
                }}
              >
                <Button size="small" theme="borderless" icon={<IconExit />} onClick={handleLogout}>
                  退出登录
                </Button>
              </div>
            )}
            <Watermark color={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'} />
            {children}
          </SeLayout>
        </SeLayout>
  )
}

function isSub(key1: string, key2: string | number) {
  const routerMap: any = {
    manager: ['streamers', 'history'],
  }
  return routerMap[key2]?.includes(key1)
}

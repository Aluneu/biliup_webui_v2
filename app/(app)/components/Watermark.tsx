'use client'

import { useMemo } from 'react'

/**
 * 半透明平铺水印 —— 防止演示站截图/页面被直接盗用冒用。
 * 覆盖整个可视区域，但不拦截任何交互（pointer-events: none）。
 */
export default function Watermark({
  text = 'biliup 演示站 DEMO',
  color = 'rgba(0,0,0,0.06)',
}: {
  text?: string
  color?: string
}) {
  const backgroundImage = useMemo(() => {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='280' height='200'>` +
      `<text x='0' y='100' transform='rotate(-24 140 100)' ` +
      `font-size='16' font-weight='600' font-family='sans-serif' fill='${color}'>` +
      `${text}</text></svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  }, [text, color])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        backgroundImage,
        backgroundRepeat: 'repeat',
        backgroundSize: '280px 200px',
        pointerEvents: 'none',
        zIndex: 900,
      }}
    />
  )
}

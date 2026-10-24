/** @type {import('next').NextConfig} */
const nextConfig = {
    // reactStrictMode: true,
    // 纯静态导出：产物在 out/，不依赖任何 Node 服务器（GitHub Pages 直接托管）。
    output: 'export',
    // 演示站永远使用 mock 假数据。这里直接兜底，避免依赖 .env 文件是否被 Next 正确注入
    // （实测 Next 的 loadEnvConfig 有时不会把 NEXT_PUBLIC_MOCK 传给 webpack DefinePlugin，
    // 导致它被替换成 void 0、MOCK_ENABLED 变成 false、整个 mock 模块被 tree-shake，
    // 页面静默无数据且 Console 无报错）。trim 防御空格/CRLF。
    env: {
        NEXT_PUBLIC_MOCK: (process.env.NEXT_PUBLIC_MOCK ?? 'true').trim(),
        // 静态站内的站内跳转要用到同一个前缀（见 app/lib/nav.tsx）
        NEXT_PUBLIC_BASE_PATH: process.env.BASE_PATH || '',
    },
    // GitHub Pages 项目站点部署在子路径（user.github.io/repo/），
    // 必须用 basePath 给所有内置资源（/_next/...）加前缀，否则 CSS/JS 全 404。
    // 本地开发 / 部署到 user 主页（根域名 / 自定义域名）时保持为空即可。
    basePath: process.env.BASE_PATH || '',
    assetPrefix: process.env.BASE_PATH || '',
    // 让每个路由生成 /path/index.html 目录形式，GitHub Pages 访问 /path 能自动 301 到 /path/
    trailingSlash: true,
    images: {
        // 静态站无法用 Next 图片优化
        unoptimized: true
    },
    // Next 16.3 起 `next dev` 会在仓库根目录自动生成 AGENTS.md / CLAUDE.md,这里关掉以保持工作树干净
    agentRules: false,
    // Keep the development indicator clear of the sidebar's expand button.
    devIndicators: { position: 'bottom-right' },
}

module.exports = nextConfig

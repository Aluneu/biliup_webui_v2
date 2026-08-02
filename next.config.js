/** @type {import('next').NextConfig} */
const nextConfig = {
    // reactStrictMode: true,
    output: 'export',
    // GitHub Pages 项目站点部署在子路径（user.github.io/repo/），
    // 必须用 basePath 给所有内置资源（/_next/...）加前缀，否则 CSS/JS 全 404。
    // 本地开发 / 部署到 user 主页（根域名）时保持为空即可。
    basePath: process.env.BASE_PATH || '',
    assetPrefix: process.env.BASE_PATH || '',
    // 让每个路由生成 /path/index.html 目录形式，GitHub Pages 访问 /path 能自动 301 到 /path/
    trailingSlash: true,
    images: {
        unoptimized: true
    },
}

module.exports = nextConfig

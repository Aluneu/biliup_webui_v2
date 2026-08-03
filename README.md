# biliup WebUI（演示站 · Mock 版）

> 把 [biliup](https://github.com/ForgQi/biliup) 的前端抽离出来的**纯前端演示站**：用内置的假数据（mock）完整还原产品形态，方便对外展示，**不需要任何后端**。

- 部署地址：`https://Aluneu.github.io/biliup_webui_v2/`（GitHub Pages，自动部署）
- 登录方式：**输入任意密码即可登录**（演示站，无真实鉴权）

---

## 1. 技术栈

| 维度 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 14（App Router） | 仅用**静态导出**（`output: 'export'`），不依赖 Node 服务器 |
| UI 组件库 | Semi Design（`@douyinfe/semi-ui`） | 与原项目一致 |
| 语言 | TypeScript / JSX | 登录页等少数文件为 `.jsx` |
| 数据请求 | SWR + 原生 `fetch` | 真实请求被 mock 层在浏览器端拦截 |
| 播放器 | ArtPlayer / mpegts.js | 离线环境下视频回放不可用（见 §6） |
| 部署 | GitHub Pages（官方 Actions） | 推 `main` 分支自动构建并发布 |

---

## 2. 文件架构

```
biliup_webui_v2/
├── app/                          # Next.js App Router 源码（核心）
│   ├── layout.tsx                # 根布局：仅 <html>/<body> + 主题色脚本（SSR 安全，无水合错乱）
│   ├── globals.css               # 全局样式
│   ├── (app)/                    # 路由组：已登录主界面（带侧边栏 + 登录守卫）
│   │   ├── layout.tsx            # ★ 主布局：侧边栏 Nav、ROUTE_MAP 硬跳转、登录守卫、水印
│   │   ├── page.tsx              # 首页（直播卡片网格）
│   │   ├── dashboard/            # 空间配置
│   │   ├── streamers/            # 直播管理（含历史/子项）
│   │   ├── history/              # 历史记录
│   │   ├── logviewer/            # 实时日志
│   │   ├── status/               # 状态总览
│   │   ├── job/                  # 任务平台
│   │   ├── changelog/            # 更新日志
│   │   ├── upload-manager/       # 投稿管理（含 add/ 新建、edit/ 编辑）
│   │   └── components/           # 页面级组件：Watermark / PageHeader / SectionTitle / BackgroundSetter
│   ├── (auth)/                   # 路由组：登录（独立于主布局，不受登录守卫包裹）
│   │   └── login/page.jsx        # ★ 纯假登录页：任意密码写入 localStorage 即进
│   ├── lib/                      # 逻辑层
│   │   ├── mock.ts               # ★ Mock 数据层（见 §3）
│   │   ├── api-streamer.ts       # ★ 入口：加载时安装 fetch 拦截（见 §3）
│   │   ├── use-streamers.ts      # 直播列表 SWR hook（依赖 mock 接口）
│   │   ├── useGlobalBackground.ts# 全局背景设置
│   │   ├── useIsMobile.ts        # 移动端判断
│   │   ├── status.tsx            # 状态类型/展示
│   │   └── utils/index.tsx       # 通用工具
│   └── ui/                       # 可复用组件
│       ├── Player.tsx            # 播放器
│       ├── TemplateModal.tsx     # 投稿模板弹窗
│       ├── OverrideModal.tsx     # 覆盖确认弹窗
│       ├── UserList.tsx          # 用户列表
│       ├── AvatarCard/           # 头像卡片
│       ├── StreamerActions/      # 直播操作（PauseButton 等）
│       ├── plugins/              # 各平台上传插件（bilibili/douyin/huya/...）
│       └── ...
├── public/                       # 静态资源：logo.svg / favicon / config 样例 / 占位图 noface.jpg
├── .github/workflows/deploy.yml  # ★ GitHub Pages 自动部署流水线（见 §5）
├── next.config.js                # ★ 静态导出 + basePath/assetPrefix + trailingSlash（见 §4、§5）
├── package.json                  # 脚本：dev / build / start / lint
├── tsconfig.json
└── .gitignore                    # 忽略 node_modules / .next / out
```

> **带 ★ 的文件是理解本项目最关键的文件**，改导航、改数据、改部署都要先看它们。

---

## 3. Mock 数据层（核心）

整个演示站**没有后端**。所有 `/v1/*`、`/bili/*` 请求都在浏览器端被拦截并返回假数据。

- **入口**：`app/lib/api-streamer.ts` 在模块加载时执行 `if (MOCK_ENABLED) installMockFetch()`。
- **实现**：`app/lib/mock.ts` 的 `installMockFetch()` 通过 `window.fetch = ...` 重写全局 fetch，把同源请求导入内部的 `route()` 路由分发器。
- **数据**：`mock.ts` 顶部维护一组**内存态**假数据（`streamers` / `users` / `videos` / `configuration` 等）。`POST/PUT/DELETE` 会真实改写内存数组，所以「新建投稿 / 删除 / 暂停」等交互在演示站里是「看起来真在跑」的。
- **MOCK_ENABLED 写死为 `true`**：这是刻意设计。本项目实测 Next 对环境变量 `NEXT_PUBLIC_MOCK` 的注入不稳定（会被 webpack 算成假值），导致整段 mock 被 tree-shake、页面静默无数据且 Console 无报错。**不要**改回用环境变量开关。
- **`/bili/proxy`**：返回 1×1 占位 PNG（离线 / 部署环境无法拉取外链图片，避免用户列表/头像卡死）。
- **外部链接**（GitHub 更新日志、`/bili/space/myinfo` 等）：直接放行走真实网络。

### 如何新增/修改假数据
直接编辑 `app/lib/mock.ts`：
1. 在顶部内存数组里增删条目；
2. 若新增接口路径，在 `route()` 里按现有 `if (pathname === '/xxx') return jsonResponse(...)` 的写法补分支即可。

---

## 4. 静态导出下的导航（重要坑）

本项目是 `output: 'export'` 纯静态站。**`next/link` + Semi `Nav` 的组合在点击时会失效**（Semi 拦截了 `<Link>` 的点击只更新高亮、不跳转；而纯静态形态下 `next/link` 的客户端软跳转也不触发）。

**解决方案（已在代码中实现，请勿回退）**：所有导航统一用**原生 `<a>` + `onClick` 硬跳转 + `window.location.href`**：

- 侧边栏：`app/(app)/layout.tsx` 的 `ROUTE_MAP`（菜单 key → 路径）+ `renderWrapper` 渲染原生 `<a>`，点击走浏览器整页导航，并拼上 `basePath`。
- 首页「直播管理 →」、投稿管理「新建 / 编辑」、OverrideModal 的返回链接：一律 `window.location.href = \`${basePath}/xxx/\``。
- 登录守卫 / 退出的跳转也用 `window.location.replace(...)`，避免静态站里 `router.replace` 的尾斜杠规范化死循环。

> **经验**：验证「页面能不能打开」必须**真机点击侧边栏/链接**，只用 `goto`/直输 URL 会绕开坏掉的客户端导航，误判为正常。

---

## 5. 构建与部署（GitHub Pages）

流水线：`.github/workflows/deploy.yml`（官方 `actions/deploy-pages@v4`，非第三方 action）。

**自动触发**：推送到 `main`（或 `master`）即自动构建并发布；也可在 Actions 页手动 `workflow_dispatch`。

**BASE_PATH 自动推导**（无需手动改）：
- 仓库是普通项目站（如本仓库 `biliup_webui_v2`）→ `BASE_PATH=/biliup_webui_v2`，站点在 `https://Aluneu.github.io/biliup_webui_v2/`。
- 若仓库本身是 `<user>.github.io`（user 主页，根域名）→ `BASE_PATH` 留空。
- 推导逻辑在 deploy.yml 的 build 步骤里用 `github.repository` 解析，对 push 和手动触发都稳定。

**关键配置**（`next.config.js`）：
- `output: 'export'` → 构建产物输出到 `out/`
- `basePath` / `assetPrefix` = `process.env.BASE_PATH`（CI 注入）
- `trailingSlash: true` → 每个路由生成 `/path/index.html`，Pages 访问 `/path` 自动 301 到 `/path/`
- `images.unoptimized: true` → 关闭 Next 图片优化（静态站无法用）

**首次部署后必做一步**（在 GitHub 仓库里）：
> Settings → Pages → Source 选 **GitHub Actions**（不是 gh-pages 分支！官方 `deploy-pages` 走 Actions 环境）。

`.nojekyll` 由 CI 在 build 后 `touch out/.nojekyll` 自动生成，无需手动处理。

---

## 6. 本地开发

```bash
npm install       # 或 npm ci（已锁定 lockfile）
npm run dev       # 默认 http://localhost:3000（本地 BASE_PATH 为空）
```

- 本地 `next dev` 不设 `BASE_PATH`，所有资源走根路径，无需子路径前缀。
- 构建产物预览（模拟静态导出）：`npm run build` 后产物在 `out/`，可用任意静态服务器打开（如 `npx serve out`）。
- ⚠️ **`.next` 是 dev 与 build 共用目录**：不要在 `npm run dev` 运行时执行 `npm run build`（反之亦然），否则会互相破坏导致 500 白屏。需要 build 时先停掉 dev。

### 已知限制（离线 / 演示特性）
- **实时日志（logviewer）**：依赖 WebSocket 实时推送，静态离线环境无法连接，页面会显示连接失败——属预期。
- **历史视频回放**：依赖真实视频流，演示站下播放器会优雅报错，页面不崩。
- **外部头像/封面**：通过 `/bili/proxy` 返回占位图，保证列表始终有数据。
- **登录**：纯前端假登录，任意密码即可，token 存入 `localStorage.biliup_token`。

---

## 7. 给后续开发者的更新指南

| 你想做的事 | 改哪里 |
|---|---|
| 加一个页面 | 在 `app/(app)/` 下建目录 + `page.tsx`；在 `layout.tsx` 的 `ROUTE_MAP` 加菜单项与路径 |
| 改侧边栏菜单 | `app/(app)/layout.tsx` 的 `ROUTE_MAP` 与 `<Nav>` 的 `items` |
| 改假数据 / 加接口 | `app/lib/mock.ts`（内存数组 + `route()` 分支） |
| 改 UI 组件 | `app/ui/` 与 `app/(app)/components/` |
| 改全局样式 / 主题 | `app/globals.css`、`app/(app)/bg-global.css` |
| 改登录逻辑 | `app/(auth)/login/page.jsx`（注意保留写 token 的逻辑，否则进不去主界面） |
| 改部署路径 / 仓库名 | 无需改代码，CI 按 GitHub 仓库名自动推导 `BASE_PATH` |
| 改构建配置 | `next.config.js`（谨慎，影响静态导出与资源前缀） |

**必须遵守的红线**：
1. `MOCK_ENABLED` 保持 `true`（写死），不要用环境变量控制。
2. 导航跳转一律用原生 `<a>` + `window.location.href`（带 `basePath`），不要回到 `next/link` / `router.push`。
3. 任何依赖浏览器信息（localStorage、`window`）的状态，**只能放进 `useEffect`**，绝不在 `useState` 初始值或首 render 里读——否则静态导出会 hydration mismatch（React #418/#423，整页白屏）。
4. 推 `main` 即自动部署，部署前先在本地 `npm run build` 确认通过。

---

## 8. 常见问题

- **页面全白屏 / Console 报 React #418/#423**：基本是 hydration mismatch（在首 render 读了 window/localStorage）。检查 `useState` 初始值。
- **推上去后 CSS/JS 全 404**：本地忘了设 `BASE_PATH`，或没走 CI。CI 已自动推导，正常情况下不会出现。
- **访问站点 404**：GitHub Pages 的 Source 没选「GitHub Actions」；或仓库名与预期 BASE_PATH 不符。
- **改了代码推上去没变化**：GitHub Actions 构建可能还没跑完，去仓库 Actions 页看状态；浏览器也可能缓存旧 JS，硬刷（Ctrl+Shift+R）。

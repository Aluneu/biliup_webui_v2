# biliup WebUI（演示站 · Mock 版）

> 把 [biliup](https://github.com/biliup/biliup)（Rust 版）的前端整站抽出来做的**纯静态演示站**：
> 用浏览器内的 mock 层还原全部接口与页面形态，**不需要任何后端**。

- 对应上游版本：**biliup v1.3.4**（2026-10-23 的 `master`）
- 部署地址：`https://dome.reccloud.icu/`（GitHub Pages 自定义域名，推 `main` 自动部署）
- 仓库：`https://github.com/Aluneu/biliup_webui_v2`
- 登录方式：**输入任意账号密码即可登录**（纯前端假登录，见 §5）

---

## 1. 这是什么 / 和上游什么关系

上游 biliup 的 WebUI 是 `app/` 目录下的 Next.js App Router 应用，由 Rust 服务端
（`crates/biliup-cli/src/server`）提供 `/v1/*` REST 接口、`/v1/ws/*` WebSocket 与
`/v1/danmaku` SSE。本项目：

1. **原样保留上游 `app/` 的全部页面与组件**（包括剪辑台、回放、压制任务、上传队列、
   B站稿件、用户管理、多机节点、Fleet/HA 等 v1.3.x 新板块）；
2. 增加一层 `app/lib/mock/`，在浏览器里 patch `fetch` / `WebSocket` / `EventSource`，
   用内存里的假数据回答所有请求；
3. 把「客户端软导航」换成整页跳转（静态导出没有 RSC 服务端，见 §6），并补上
   GitHub Pages 的 `basePath` 前缀；
4. 用 localStorage 一个标记位替代真实登录会话。

所以：**页面代码与上游保持一致，演示站只多了一个 mock 层 + 一个静态化适配层**。
上游更新后按 §8 的步骤同步即可。

---

## 2. 技术栈

| 维度 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 16（App Router，Turbopack） | `output: 'export'` 纯静态导出，产物在 `out/` |
| UI | Semi Design 2.104（`@douyinfe/semi-ui` / `semi-icons`） | 与上游一致 |
| 语言 | TypeScript 6 / TSX（登录页为 `.jsx`） | `strict: true` |
| 数据 | SWR 2.5 + 原生 `fetch` | 请求被 mock 层拦截 |
| 播放器 | ArtPlayer + mpegts.js + hls.js + jassub（ASS 字幕） | 演示站无真实流，播放器会优雅报错 |
| 图表 | uPlot（写盘速率）、react-json-tree（原始 JSON） | |
| 部署 | GitHub Pages（官方 Pages Actions） | 推 `main` 自动构建发布 |

---

## 3. 目录结构

```
biliup_webui_v2/
├── app/
│   ├── layout.tsx                  # 根布局：主题脚本 + react19-adapter
│   ├── globals.css
│   ├── (app)/                      # 已登录主界面（侧栏 + 登录守卫）
│   │   ├── layout.tsx              # ★ 侧栏导航（5 组 11 项）、权限过滤、登录守卫、演示角标
│   │   ├── page.tsx                # 概览（KPI + 直播卡片 + 活动时间线）
│   │   ├── streamers/              # 直播管理（列表 / 分页 / 批量暂停）
│   │   │   └── editor/             # 直播间新增·编辑（含画面遮挡编辑器）
│   │   ├── live/                   # 直播预览（多路同屏）
│   │   ├── workbench/              # 剪辑台（场次 / 文件 两个 Tab）
│   │   ├── replay/                 # 场次回看（时间轴 / 弹幕 / 标记 / 切片导出）
│   │   ├── renders/                # 压制任务
│   │   ├── upload-manager/         # 投稿管理（模板 CRUD / add / edit）
│   │   ├── upload-queue/           # 上传队列
│   │   ├── archives/               # B站稿件
│   │   ├── dashboard/              # 空间配置（+ secrets 本机密钥）
│   │   ├── users/                  # 用户管理（角色 / 权限点）
│   │   ├── status/                 # 任务平台（原始状态 JSON + 节点入口）
│   │   ├── nodes/                  # 多机节点：房间分派 / 模板 / 配置 / HA
│   │   ├── logviewer/              # 实时日志（WebSocket）
│   │   └── changelog/              # 更新日志（实时拉 GitHub raw）
│   ├── (auth)/login/page.jsx       # 假登录页
│   ├── lib/
│   │   ├── api-streamer.ts         # ★ 统一 fetch 封装 + mock 安装入口
│   │   ├── nav.tsx                 # ★ 静态导出导航适配（Link / useRouter / basePath）
│   │   ├── demo-auth.ts            # ★ 假登录态（localStorage）
│   │   ├── mock/                   # ★ Mock 数据层（见 §4）
│   │   └── …                       # 上游原有 hooks（use-me / use-dashboard / sessions / …）
│   └── ui/                         # 上游原有组件（Player / PublishDrawer / plugins / …）
├── public/                         # logo / config.toml / config.yaml / 占位图
├── scripts/
│   ├── prepare-jassub.mjs          # 构建前把 jassub 的 wasm/worker 复制到 public/jassub
│   ├── preview-server.mjs          # 本地预览 out/ 的极简静态服务器
│   └── shots.ps1                   # 无头 Edge 逐页截图（自检用）
├── .github/workflows/deploy.yml    # GitHub Pages 自动部署
└── next.config.js                  # ★ 静态导出 + basePath + NEXT_PUBLIC_MOCK 兜底
```

> ★ = 改演示站行为前必须先看的文件。

---

## 4. Mock 数据层

### 4.1 安装与拦截

- **入口**：`app/lib/api-streamer.ts` 在模块加载时 `if (MOCK_ENABLED) installMockFetch()`。
  该模块被几乎所有页面引用，因此第一个请求发出前拦截器已就位。
- **拦截**：`app/lib/mock/index.ts` 重写 `window.fetch`，只接管 `/v1/*`、`/bili/*`、
  `/static/*`；**其它同源请求放行走真实网络**（Next 的 RSC 导航 payload 也在其中，
  拦了会导致导航静默失效）。
- **实时通道**：`app/lib/mock/sockets.ts` 替换 `window.WebSocket` 与 `window.EventSource`：
  - `/v1/ws/logs` → 每 0.9 s 推一行假日志（首屏先灌 12 行）
  - `/v1/ws/live-rates?session=` → 每秒推一帧 `[{id, bytes_per_sec, ts}]`
  - `/v1/danmaku?ids=1,2` → 每 1.4 s 推一条弹幕 / 礼物 / SC 事件
- **兜底**：未实现的接口返回 404（前端 SWR 走 error 分支显示空态），
  单个 handler 抛错只 `console.warn` 并继续问下一个处理器，不会白屏。

### 4.2 模块划分

| 文件 | 负责的接口 |
|---|---|
| `mock/state.ts` | 共享内存实体：**30 个直播间**（8 路录制中，覆盖 8 个平台）、4 个投稿模板、3 个 Cookie、6 个录播文件、开播信息 |
| `mock/core.ts` | `/v1/me`、`/v1/status`、`/v1/logout`、登录/注册/改密码、兜底 404 |
| `mock/streamers.ts` | `/v1/streamers`（CRUD / 分页 / 暂停）、`/v1/overview`、`/v1/activity-events`、`/v1/streamer-info*` |
| `mock/live.ts` | `/v1/streamers/{id}/live`、`live-url`、`cover`、`avatar`、`mosaic-frame`、`/v1/live-rates` |
| `mock/sessions.ts` | 场次、分段、标记、切片、合并候选、自动切片与建议、回看关键帧/缩略图 |
| `mock/renders.ts` | 压制任务、渲染资产、编码器、合成配方、弹幕预览 |
| `mock/uploads.ts` | 投稿模板 CRUD、`/v1/uploads`、发布任务、上传队列、`/v1/videos`、B站稿件、文件定位 |
| `mock/fleet.ts` | 多机节点、房间分派、节点模板、Fleet 配置与历史、告警、加入令牌、HA 配对 |
| `mock/config.ts` | `/v1/configuration`、斗鱼 Cookie 校验/续期、B站扫码登录、Cookie 文件、`/bili/*`、`/v1/web-users` |
| `mock/stats.ts` | `/v1/system-stats`（CPU / 内存 / 磁盘 / 网络，2 秒一个采样点，曲线是活的） |
| `mock/image.ts` | 封面 / 头像 / 缩略图的**内联 SVG**（data URI），见下方「图片为什么不能用 mock 接口」 |
| `mock/sockets.ts` | WebSocket（日志、写盘速率）与 EventSource（弹幕）的假实现 |
| `mock/mosaic-frame-data.ts` | 画面遮挡编辑器用的静态截帧（JPEG base64，由 `scripts/gen-mosaic-frame.py` 生成） |
| `mock/util.ts` | `json/ok/noContent/notFound/badRequest/text/jpeg` + SVG 封面/头像生成 |

**数据是有状态的**：`POST/PUT/DELETE` 会真的改内存数组，所以「新建直播间 / 暂停 /
删除 / 新建切片 / 取消压制任务」在演示站里是「看起来真在跑」的，刷新页面后复位。

### 4.3 图片为什么不能用 mock 接口

`window.fetch` 只拦截脚本发起的请求，**`<img src="/v1/...">` 是浏览器直接加载的**，
不会经过 mock 层，会打到静态服务器上变成破图。所以凡是图片地址，都在生成 URL 的
那一层（`liveImageUrl` / `thumbUrl` / `coverUrl` / `assetUrl`）在 `MOCK_ENABLED`
时直接返回 `data:image/svg+xml,...`（`mock/image.ts` 生成）。

> 新增需要显示图片的接口时，记得同样走这条路，别指望 mock 路由能返回图片。
> 例外：`mosaic-frame` 是 `fetch` 取回后转 Blob 的，所以由 `mock/live.ts` 返回真 JPEG。

### 4.4 如何加一个接口

1. 找到所属模块（或新建 `mock/xxx.ts`，并在 `mock/index.ts` 的路由链里按顺序引入）；
2. 写一个 `MockHandler`：`(ctx) => ctx.method === 'GET' && ctx.path === '/v1/xxx' ? json(data) : undefined`；
3. 路径参数用正则取：`ctx.path.match(/^\/v1\/streamers\/(\d+)$/)`；
4. 列表数据尽量从 `mock/state.ts` 的 `db` 取，保证跨页面一致。

---

## 5. 登录（纯前端）

- `app/(auth)/login/page.jsx`：任意账号密码 → 调 `/v1/users/login`（mock 无条件 200）
  → `markSignedIn()` 写 `localStorage.biliup_demo_login` → 跳首页。
- `app/(app)/layout.tsx`：进入主界面时若无该标记，整页 `replace` 到 `/login`；
  侧栏「退出登录」清标记后回登录页。
- 快捷入口：URL 加 `?__login=1` 会自动写入登录标记（截图 / 分享链接用）。
- `/v1/me` 恒返回 `admin` + 全部 15 个权限点，所以所有菜单与按钮都可见；
  想看权限过滤效果，把 `mock/core.ts` 里的 `permissions` 数组删几项即可。

---

## 6. 静态导出下的导航（重要坑）

本项目是 `output: 'export'` 纯静态站：没有 Node 服务端，`next/link` 的软导航拿不到
RSC payload，点击会「只改地址栏不换内容」。处理方式：

- `app/lib/nav.tsx` 导出同名 `Link` 与 `useRouter`，内部用
  `<a href>` + `window.location.assign/replace` 做**整页跳转**，并统一补 `basePath`；
- 上游所有 `import Link from 'next/link'` / `useRouter from 'next/navigation'` 已改为
  从 `@/app/lib/nav` 引入（`usePathname` / `useSearchParams` 仍是 next/navigation）；
- `api-streamer.ts` 的 401 跳登录、`layout.tsx` 的退出、登录页跳转都用 `withBase()`。

> **红线**：不要再引入 `next/link` 或 `router.push` 做站内跳转；不要改成软导航。
> 验证「页面能不能打开」必须真机点侧栏，不能只输 URL。

### basePath

- 自定义域名 / 根域名部署：`BASE_PATH` 留空（默认）；
- `user.github.io/repo` 子路径部署：手动触发 workflow，把 `base_path` 填 `/repo`。

`next.config.js` 把它同时注入 `basePath` / `assetPrefix` / `NEXT_PUBLIC_BASE_PATH`。

---

## 7. 构建、预览与部署

```bash
npm install          # 或 npm ci
npm run dev          # http://localhost:3000（本地 BASE_PATH 为空）
npm run build        # 产物在 out/（prebuild 会自动跑 prepare:jassub）
node scripts/preview-server.mjs 8899   # 预览 out/，http://127.0.0.1:8899
pwsh -File scripts/shots.ps1           # 无头 Edge 逐页截图到 shots/（需要本机有 Edge）
```

**部署**：`.github/workflows/deploy.yml`，推 `main` 自动构建并发布；
首次需在仓库 Settings → Pages → Source 选 **GitHub Actions**。
`.nojekyll` 由 CI 在 build 后自动生成。

> ⚠️ `.next` 是 dev 与 build 共用目录：不要在 `npm run dev` 运行时执行 `npm run build`。

---

## 8. 同步上游更新

```bash
# 1) 拉上游最新 app/ 与 public/ 覆盖
curl -L https://codeload.github.com/biliup/biliup/tar.gz/refs/heads/master -o /tmp/biliup.tgz
mkdir -p /tmp/biliup-master && tar -xzf /tmp/biliup.tgz -C /tmp/biliup-master --strip-components=1
rsync -a /tmp/biliup-master/app/ app/
rsync -a /tmp/biliup-master/public/ public/

# 2) 恢复演示站适配（每次同步都得重做）
#    a. mock 层：app/lib/mock/ 与 app/lib/nav.tsx、demo-auth.ts 不受上游覆盖影响，
#       若被覆盖则从 git 恢复：git checkout -- app/lib/mock app/lib/nav.tsx app/lib/demo-auth.ts
#    b. 导航适配：跑 python scripts/demo-nav-transform.py
#       （把新出现的 next/link、useRouter 改到 '@/app/lib/nav'）
#    c. 登录守卫 / 演示角标 / 登录页「任意密码」提示：参考 git diff 手改
#    d. api-streamer.ts 顶部恢复 installMockFetch() 调用与 withBase 跳转
```

同步后务必 `npm run build` + `pwsh -File scripts/shots.ps1` 逐页看一遍：新页面通常会调用
新接口，`mock/` 里没实现的会返回 404，页面显示空态（不会崩）。

---

## 9. 已知限制（演示站特性）

| 现象 | 原因 |
|---|---|
| 播放器报错 / 黑屏 | 没有真实 FLV/HLS 流，`/v1/streamers/{id}/live`、`/v1/sessions/{id}/media` 故意返回 404/415 |
| 缩略图、关键帧是占位图 | 没有真实视频，服务端生成的是 SVG 占位图 |
| 刷新页面后数据复位 | 假数据只在内存里，没有持久化 |
| 更新日志页可能空白 | 它直接拉 `raw.githubusercontent.com`，离线环境取不到（有 localStorage 缓存兜底） |
| 前端日志 / 弹幕内容是假的 | 由 `mock/sockets.ts` 定时生成 |
| 图片都是 SVG 占位 | `/bili/proxy` 返回 1×1 PNG，封面/头像由 `mock/util.ts` 生成 |

---

## 10. 常见问题

- **白屏 + Console 报 React #418/#423**：hydration mismatch，通常是首 render 读了
  `window`/`localStorage`。把这类读取放进 `useEffect`。
- **推上去 CSS/JS 全 404**：`BASE_PATH` 与访问域名不匹配（见 §6）。
- **点了侧栏没反应**：说明某处又用回 `next/link` 软导航了（见 §6）。
- **页面有数据但一看就是空的**：对应接口在 `mock/` 里没实现，Console 会有
  `[mock] mock 未实现：GET /v1/...`（404 响应）。
- **`npm run build` 报 jassub 相关错误**：先单独跑 `npm run prepare:jassub`。

---

## 11. 本次更新（对齐上游 v1.3.4）

上一版演示站停留在 1.2.x 的界面（概览 / 直播管理 / 投稿管理 / 空间配置 / 实时日志 /
任务平台）。这次把上游 `master`（v1.3.4）的前端整体搬了过来，并补齐了 mock：

| 板块 | 变化 |
|---|---|
| 导航 | 改为上游的 5 组导航（总览 / 录制 / 投稿 / 设置 / 系统），按权限点过滤 |
| 概览 | KPI + Fleet 摘要 + 系统状态曲线（CPU/内存/磁盘/网络）+ 直播卡片 + 活动时间线 |
| 直播管理 | 网格/列表双视图、平台筛选、搜索、分页、批量暂停、状态标签 |
| 直播间编辑 | 新增独立编辑页：处理流程画布、下载/分段/后处理、画面遮挡编辑器、覆写项 |
| 直播预览 | 新增：多路同屏监视、写盘速率曲线、实时弹幕、标记与快捷切片 |
| 剪辑台 | 新增：场次列表（自动切片状态、合并）、录音文件、实时监控、场次续接合并建议 |
| 回放 / 剪辑 | 新增：时间轴、关键帧跳转、标记、切片入出点、弹幕轨、压制配方 |
| 压制任务 | 新增：GPU/编码器卡片、任务队列（进度/速度/剩余）、取消与重试 |
| 投稿 | 投稿管理改为模板网格 + 账号抽屉；新增上传队列、B站稿件两个页面 |
| 空间配置 | 补齐 v1.3.x 配置项：斗鱼 Cookie/LTP0/自动续期、画面遮挡、渲染字体、预览传输方式等 |
| 用户管理 | 新增：角色与权限点矩阵、改密、禁用、强制下线 |
| 任务平台 | 新增：多机节点（房间分派/节点模板/配置下发/告警/加入令牌）、一主一备（HA） |
| 实时日志 | 改为 WebSocket 推送（演示站由 `mock/sockets.ts` 定时生成） |

mock 层从 1 个 `mock.ts`（约 500 行）拆成 12 个模块（约 9.4k 行），覆盖上游前端实际
调用的 **80 余条接口路径**（含方法与别名约 170 个组合）；`/v1/me` 恒返回超级管理员 +
全部 15 个权限点，所以所有页面与按钮都可见。

自检记录：`tsc --noEmit` 通过；`next build` 26 条路由全部静态导出成功；
`scripts/shots.ps1` 用无头 Edge 逐页截图（`shots/`），Console 里除了「没有真实视频流」
导致的播放器重试（预期）之外没有 JS 异常。

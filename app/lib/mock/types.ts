// ============================================================================
// Mock 层：请求上下文与处理器类型
// ----------------------------------------------------------------------------
// 每个业务模块（streamers / sessions / renders / uploads / fleet / config …）
// 导出一个 `MockHandler[]`，由 `mock/index.ts` 顺序询问；返回 `undefined`
// 表示「不是我的路由」，交给下一个处理器。
// ============================================================================

export interface MockCtx {
  /** 大写，如 GET / PUT */
  method: string
  /** 去掉 basePath 的路径，如 /v1/streamers/12/pause */
  path: string
  query: URLSearchParams
  /** 已解析的 JSON body（非 JSON 则为原始字符串／null） */
  body: any
  /** 原始请求头，图片上传等需要看 Content-Type */
  headers: Headers
  url: URL
}

export type MockHandler = (ctx: MockCtx) => Response | undefined

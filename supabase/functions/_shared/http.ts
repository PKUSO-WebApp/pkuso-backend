/**
 * Edge Function 的响应组装：`json()` 与 CORS 头。
 *
 * ## CORS 有**三份**常量，这不是手滑 —— 它是现状的忠实搬运
 *
 * | 常量 | 谁在用 | 与别处的差别 |
 * | --- | --- | --- |
 * | `CORS_HEADERS` | 大多数函数 | `Access-Control-Allow-Headers` 里**没有** `x-pkuso-diag` |
 * | `CORS_HEADERS_WITH_DIAG` | 登录链路上的那几个 | 多放行 `x-pkuso-diag`（H5 端会走预检） |
 * | `CORS_ORIGIN_ONLY` | `wechat-content-check` 的 JSON 响应 | 只有 origin，没有 allow-headers |
 *
 * ⚠️ **别顺手统一它们。** 两个方向都是行为变更：
 * - `CORS_HEADERS` → `CORS_HEADERS_WITH_DIAG`：等于给那些函数放行一个新的请求头
 *   （看着更一致，实际是**扩大**了面）；
 * - 反过来：H5 端带 `x-pkuso-diag` 的请求会被浏览器拦在预检（见 `diag.ts` 的
 *   `CORS_ALLOW_HEADERS`，那边记着「漏了的表现是 H5 端被预检拦下、小程序端却正常」）。
 *
 * 真要统一，那是一次**行为变更**，该有自己的理由与真机验证，不该藏在重构里。
 * 三份的存在由 `http.test.ts` 钉住 —— 谁把它们合并了，那里会红。
 *
 * ## 还有一批响应**完全不带 CORS**
 *
 * 「这个函数的 JSON 响应带不带 CORS」在现网也不是一致的：有几个函数只有
 * `Content-Type`（它们的 OPTIONS 分支却又放行了 CORS —— 这是既存的不一致，
 * 本模块不替它们做决定）。调用点靠**第三个参数**区分：
 *
 * ```ts
 * json(body, 400)                        // 只有 Content-Type（现状）
 * json(body, 400, CORS_HEADERS)          // + 完整 CORS（现状）
 * json(body, 400, CORS_ORIGIN_ONLY)      // + 只有 origin（wechat-content-check 的现状）
 * ```
 *
 * ## 为什么 `json()` 的签名是 `(body, status = 200)`
 *
 * 本仓原先有 `(body, status)` 与 `(status, body)` 两种相反的顺序（后者更常见），
 * 读调用点时得先回定义处数参数 —— 那是纯粹自找的认知负担。统一成 body 在前、
 * status 带默认值：`json({ error: 'method not allowed' })` 这种最常见的形态最短。
 * 改调用点的顺序**不动行为**（都是同一个 `new Response`）。
 */

import { CORS_ALLOW_HEADERS } from './diag.ts'

/**
 * 只放行来源，不声明可用的请求头。
 *
 * 现状里只有 `wechat-content-check` 的 JSON 响应用它。⚠️ 它与另外两份**不是**同一个
 * 响应头集合（少一个 `Access-Control-Allow-Headers`），别拿它当「精简版」随手替换。
 */
export const CORS_ORIGIN_ONLY: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
}

/**
 * 多数函数的 CORS 头。
 *
 * ⚠️ `Access-Control-Allow-Headers` 里**没有** `x-pkuso-diag` —— 与
 * `CORS_HEADERS_WITH_DIAG` 的差别就在这里，不是笔误。
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * 登录链路上那几个函数用的 CORS 头：比 `CORS_HEADERS` 多放行一个 `x-pkuso-diag`。
 *
 * 为什么是这几个函数：它们的调用方里有 H5（会走预检），而客户端要带对账用的 diag 头
 * （见 `diag.ts`）。放行头由 `CORS_ALLOW_HEADERS` 单点定义，免得加头时漏改其中一处。
 */
export const CORS_HEADERS_WITH_DIAG: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
}

/**
 * JSON 响应。**只**管报文与响应头 —— 状态码的语义、什么时候用哪个状态码，是各函数
 * 自己的事（那是业务判断，不是共用的东西）。
 *
 * `extraHeaders` 展开在前、`Content-Type` 在后：调用方塞不进一个假的 `Content-Type`
 * 去把报文类型改掉（同 `diag.ts` 里「固定字段在后」的理由）。
 */
export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extraHeaders, 'Content-Type': 'application/json' },
  })
}

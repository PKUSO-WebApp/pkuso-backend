/**
 * **只给测试用**：带 CORS 的响应应当长什么样（没有任何 Edge Function import 它，
 * 所以不会进部署产物）。
 *
 * ## 值是**手写**的，不从 `http.ts` 的常量 derive
 *
 * 引用实现就成了自比：常量被改坏时断言照样绿（本仓「两个入参的长度上界」那条用例
 * 记着同一条理由）。分工是：`http.test.ts` 逐字钉住**那三份常量的取值**，
 * 这里钉住**某个函数的某个响应实际带哪几个头**。
 *
 * ## 判据是**完整的头集合**，不是「有没有某个头」
 *
 * 多一个、少一个都要红，因为两个方向都出事：
 * - 多一个 → 放行了本不该放行的头（CORS 上「更一致」那个方向是**扩大**攻击面）；
 * - 少一个 → 浏览器读不到响应体（调用方是浏览器里的 pkuso-web）。
 *
 * ## 为什么值得单独抽出来
 *
 * 一次**真实漏过**的缺陷正是「少了一个头」：成功路径的 `json(...)` 少写第三个参数，
 * 状态码与报文**一字不变**，只是响应少了全部 CORS 头 —— 而当时全仓的断言都在比
 * 状态码与报文，改动落在的维度恰好是**响应头**，于是套件全绿、一路走到评审。
 * 后果不是「慢一点」：预检会过、请求**真的发出去**、DeepSeek 的额度**真的烧掉**，
 * 然后浏览器把响应挡住，前端只看到一句「LLM 请求失败」。
 */

import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'

/**
 * 带 CORS 的 JSON 响应：三个头，一个都不能少。
 * ⚠️ allow-headers 里**没有** `x-pkuso-diag` —— 这是现状（只有登录链路那三个函数带它），
 * 别当成笔误「修」掉；要动它是一次行为变更。
 */
export const CORS_JSON_HEADERS: Record<string, string> = {
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-origin': '*',
  'content-type': 'application/json',
}

/** OPTIONS 预检：只有 CORS 两个头（**没有** content-type —— 预检没有报文）。 */
export const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-origin': '*',
}

/**
 * 断言一个响应的**完整响应头集合**与逐个取值。
 *
 * 名字里带上用例名（`name`），失败时报出是**哪一个响应点**少了头 —— 这条信息的价值
 * 与「到底少了哪个头」相当：响应点很多，只说「少了一个头」等于没说。
 */
export function assertResponseHeaders(
  res: Response,
  expected: Record<string, string>,
  name: string,
): void {
  // Headers 迭代本就是字典序（Fetch 规范），这里再 sort 一次只是免得依赖那一层
  assertEquals(
    [...res.headers.keys()].sort(),
    Object.keys(expected).sort(),
    `${name}：响应头**集合**`,
  )
  for (const [k, v] of Object.entries(expected)) {
    assertEquals(res.headers.get(k), v, `${name}：${k}`)
  }
}

import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { CORS_HEADERS, CORS_HEADERS_WITH_DIAG, CORS_ORIGIN_ONLY, json } from './http.ts'

/**
 * 跑法：`deno test supabase/functions/_shared/`
 *
 * ## 这个文件守的是什么
 *
 * 本仓的 CORS **不是一份**，而是三份（外加「完全没有 CORS」的一种）—— 那是历史漂移，
 * 不是设计（见 `http.ts` 的说明）。把这三份钉在这里，是为了拦住**顺手统一**：
 * 两个方向都是行为变更，而且其中一个方向在本地根本看不见 ——
 * `CORS_HEADERS` 换成 `CORS_HEADERS_WITH_DIAG` 是**多放行一个请求头**（扩大了面），
 * 反过来则是 H5 端带 `x-pkuso-diag` 的请求被浏览器拦在预检（小程序端不预检，测不出来）。
 *
 * ⚠️ 这里断言的是**当前的取值**，不是「应该是什么」。哪天真的要统一，那是另一次
 * 行为变更：改这里的三份常量与这条注释，并在 PR 里说清凭什么。
 */

Deno.test('json()：默认 200，且只有 Content-Type（那批响应本来就不带 CORS）', async () => {
  const res = json({ error: 'x' })
  assertEquals(res.status, 200)
  // 只有这一个头 —— 补上 CORS 会让「不该跨域的响应」变得可跨域读
  assertEquals([...res.headers.keys()], ['content-type'])
  assertEquals(res.headers.get('content-type'), 'application/json')
  assertEquals(await res.text(), JSON.stringify({ error: 'x' }))
})

Deno.test('json()：状态码是第二个参数；报文里没有多余的空格或换行', async () => {
  const res = json({ error: 'method not allowed' }, 405)
  assertEquals(res.status, 405)
  assertEquals(await res.text(), '{"error":"method not allowed"}')
})

Deno.test('json()：第三份参数是响应头，`Content-Type` 在后（调用方覆盖不掉它）', async () => {
  const res = json({ ok: true }, 200, { 'Content-Type': 'text/html', ...CORS_HEADERS })
  assertEquals(res.headers.get('content-type'), 'application/json')
  assertEquals(res.headers.get('access-control-allow-origin'), '*')
  assertEquals(res.headers.get('access-control-allow-headers'), CORS_HEADERS['Access-Control-Allow-Headers'])
})

Deno.test('CORS_ORIGIN_ONLY 只有 origin —— 与另两份**不是**同一个响应头集合', () => {
  assertEquals(Object.keys(CORS_ORIGIN_ONLY), ['Access-Control-Allow-Origin'])
  assertEquals(CORS_ORIGIN_ONLY['Access-Control-Allow-Origin'], '*')
  // 反向自检：另两份确实比它多一个头（否则上面那条断言会因「三份都一样」而空转）
  assertEquals('Access-Control-Allow-Headers' in CORS_HEADERS, true)
  assertEquals('Access-Control-Allow-Headers' in CORS_HEADERS_WITH_DIAG, true)
})

Deno.test('CORS_HEADERS_WITH_DIAG 比 CORS_HEADERS 只多放行 x-pkuso-diag', () => {
  const base = CORS_HEADERS['Access-Control-Allow-Headers']
  const withDiag = CORS_HEADERS_WITH_DIAG['Access-Control-Allow-Headers']
  assertEquals(CORS_HEADERS['Access-Control-Allow-Origin'], CORS_HEADERS_WITH_DIAG['Access-Control-Allow-Origin'])
  // 前缀逐字相同 —— 拦「两份被改成不同写法」这种漂移；差别必须恰好是那一个头
  assertEquals(withDiag.startsWith(base), true)
  assertEquals(withDiag.slice(base.length), ', x-pkuso-diag')
  // ⚠️ 哪一份给哪些函数是**现状**，别拿这条断言当成「应该带着它」
  assertEquals(base.includes('x-pkuso-diag'), false)
})

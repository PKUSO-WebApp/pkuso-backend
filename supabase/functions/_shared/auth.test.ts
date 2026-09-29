import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { requireUser } from './auth.ts'

/**
 * 跑法：`deno test --allow-env supabase/functions/_shared/`
 *
 * ## 这个文件守的是什么
 *
 * 「**网关不验签，函数就得自己验**」这条前提。本仓库的 CI 用 `--no-verify-jwt` 部署，
 * 所以 `config.toml` 里 `verify_jwt = true` 是死配置 —— 2026-09-29 实测 prod 上
 * 12 个函数实际全是 `false`。
 *
 * 同一天查出 `ocr-analyze` / `llm-analyze` / `segment-parts` 三个函数体内**一行鉴权都没有**，
 * 于是持有公开 publishable key 的任何人可以直接调它们烧 API 额度。
 *
 * 所以这个文件里最要紧的一条是：**无效 token 必须被拒**。前面的 `send-verification-code`
 * 就是因为只做 base64 解码 payload、不验签名，让伪造 payload 能冒充任意 user。
 */

const CORS = { 'Access-Control-Allow-Origin': '*' }

/** 桩掉 fetch：只应答 auth 端点，其余一律报错（免得掩盖意外出网） */
function stubFetch(handler: (url: string) => Response) {
  const seen: string[] = []
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    return Promise.resolve(handler(url))
  }) as typeof fetch
  return seen
}

const reqWith = (auth?: string) =>
  new Request('http://x/', {
    method: 'POST',
    ...(auth ? { headers: { Authorization: auth } } : {}),
  })

Deno.env.set('SUPABASE_URL', 'https://test.supabase.co')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-key')

Deno.test('缺 Authorization 头 → 401，且**不会**去打 auth 服务', async () => {
  const seen = stubFetch(() => new Response('{}', { status: 200 }))
  const r = await requireUser(reqWith(), CORS)

  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.response.status, 401)
  // 没带头就不该出网 —— 少一次无谓往返，也让「没带凭据」与「凭据无效」在日志里可分辨
  assertEquals(seen.length, 0)
})

Deno.test('token 无效（auth 服务返回 401）→ 401', async () => {
  stubFetch(() => new Response(JSON.stringify({ message: 'invalid JWT' }), { status: 401 }))
  const r = await requireUser(reqWith('Bearer forged-token'), CORS)

  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.response.status, 401)
})

Deno.test('token 有效 → ok，并带出 userId', async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify({ id: 'user-42', email: 'a@b.c' }), {
        status: 200,
      }),
  )
  const r = await requireUser(reqWith('Bearer good-token'), CORS)

  assertEquals(r.ok, true)
  if (r.ok) {
    assertEquals(r.userId, 'user-42')
    assertEquals(r.email, 'a@b.c')
  }
})

Deno.test('auth 服务返回 200 但没有 user 字段 → 仍然 401（不能因为「没报错」就放行）', async () => {
  stubFetch(() => new Response(JSON.stringify({}), { status: 200 }))
  const r = await requireUser(reqWith('Bearer weird-token'), CORS)

  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.response.status, 401)
})

Deno.test('自身 env 缺 → 500（与 401 分开：那是我们的问题，不是调用方的）', async () => {
  const url = Deno.env.get('SUPABASE_URL')
  Deno.env.delete('SUPABASE_URL')
  try {
    const r = await requireUser(reqWith('Bearer any'), CORS)
    assertEquals(r.ok, false)
    if (!r.ok) assertEquals(r.response.status, 500)
  } finally {
    if (url) Deno.env.set('SUPABASE_URL', url)
  }
})

Deno.test('失败响应**带 CORS 头**（否则浏览器侧只看得到 CORS 报错，看不到 401）', async () => {
  stubFetch(() => new Response('{}', { status: 200 }))
  const r = await requireUser(reqWith(), CORS)

  assertEquals(r.ok, false)
  if (!r.ok) {
    assertEquals(r.response.headers.get('Access-Control-Allow-Origin'), '*')
    assertStringIncludes(await r.response.text(), 'error')
  }
})

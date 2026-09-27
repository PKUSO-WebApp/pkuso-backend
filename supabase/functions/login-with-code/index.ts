// 验证码登录 Edge Function
//
// 流程：接收 email + code → 查找 verification_codes 记录 → 校验 → 轮换密码 → password grant 换 session
// 用途：登录页「邮箱+验证码」登录方式，未登录用户可调用
//
// 安全设计：
// - verify_jwt=false：面向未登录用户
// - 仅校验 purpose='login' 的验证码
// - 旧码杀死：校验成功后标记所有同 purpose 旧码为 used

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CORS_ALLOW_HEADERS, createLogger } from '../_shared/diag.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// 上游 token 交换必须显式超时：对端挂起时函数会一直占着执行槽到 wall-clock 上限，
// 而客户端早已放弃等待——表现为「用户卡在登录中，服务端却查不到任何失败记录」。
// 与 wechat-auth 同一个常量、同一个理由（那边实测 1.7–4.4s 的跨境往返，8s 留足余量）。
const UPSTREAM_TIMEOUT_MS = 8000

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  // 结构化日志（见 _shared/diag.ts）：**本函数此前一条日志都没有**——「验证码登录」
  // 失败时服务端完全无声，只能靠客户端那句泛化文案猜。现在每个出口都留痕，
  // 并与客户端那条记录用 diag 对上。
  const { log } = createLogger('login-with-code', req)
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
      },
    })
  }
  if (req.method !== 'POST') {
    log('fail', { step: 'method', status: 405, error: 'method not allowed' })
    return json(405, { error: 'method not allowed' })
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    log('fail', { step: 'config', status: 500, error: 'server misconfigured' })
    return json(500, { error: 'server misconfigured' })
  }

  let email = ''
  let code = ''
  try {
    const body = (await req.json()) as Record<string, unknown>
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    code = typeof body.code === 'string' ? body.code.trim() : ''
  } catch {
    log('fail', { step: 'parse_body', status: 400, error: 'invalid json body' })
    return json(400, { error: 'invalid json body' })
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    log('fail', { step: 'parse_body', status: 400, error: 'invalid email' })
    return json(400, { error: 'invalid email' })
  }
  if (!code || code.length !== 6) {
    log('fail', { step: 'parse_body', status: 400, error: 'invalid code' })
    return json(400, { error: 'invalid code' })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 1. 查找邮箱对应的用户
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (profileError || !profile) {
    // 不暴露用户是否存在（响应两可，日志里分开记——否则「邮箱打错了」和「库挂了」
    // 在事后看是同一条记录）
    log('fail', {
      step: 'profile_lookup',
      status: 401,
      error: profileError ? 'profile lookup failed' : 'no such user',
      detail: profileError?.message,
    })
    return json(401, { error: 'invalid credentials' })
  }

  const userId = profile.id

  // 2. 查找匹配的验证码（仅 purpose='login'，未使用，未过期）
  const { data: codeRecord, error: codeError } = await supabase
    .from('verification_codes')
    .select('id')
    .eq('user_id', userId)
    .eq('code', code)
    .eq('purpose', 'login')
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (codeError || !codeRecord) {
    // 五种原因回同一句话：没这个码 / 已用过 / 过期 / 不是 login 用途 / 查询本身失败。
    // 区分它们要另查一次，但「用户说验证码没错却登不上」时这行就是唯一的线索，
    // 至少把「查询失败」与「查到了但没匹配上」分开。
    log('fail', {
      step: 'verify_code',
      status: 401,
      error: codeError ? 'code lookup failed' : 'invalid or expired code',
      detail: codeError?.message,
    })
    return json(401, { error: 'invalid or expired code' })
  }

  // 3. 标记验证码为已使用 + 杀死该用户所有 login 旧码
  await supabase
    .from('verification_codes')
    .update({ used: true })
    .eq('user_id', userId)
    .eq('purpose', 'login')
    .eq('used', false)

  // 4. 轮换随机密码 → password grant 换 session
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const newPassword = crypto.randomUUID().replace(/-/g, '')
  const { error: pwdError } = await admin.auth.admin.updateUserById(userId, { password: newPassword })
  if (pwdError) {
    log('fail', { step: 'rotate_password', status: 500, error: 'update password failed', detail: pwdError.message })
    return json(500, { error: 'update password failed' })
  }
  log('step', { step: 'rotate_password' })

  let tokenRes: Response
  try {
    tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ email, password: newPassword }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    // 与下面的 !tokenRes.ok 分开：这一支是**根本没拿到应答**（连接失败/被 8s 掐断），
    // 那一支是拿到了非 2xx。两者的修法不同，混在一起就白记了。
    log('fail', {
      step: 'token_exchange',
      status: 502,
      error: 'token exchange unreachable',
      detail: err instanceof Error ? err.message : String(err),
    })
    return json(502, { error: 'token exchange failed' })
  }
  if (!tokenRes.ok) {
    // 同一账号并发登录时两次轮换密码会互相覆盖，先到的那次必然 invalid_credentials。
    // 记下 HTTP 状态与响应体才能把它与「真的凭据错误」「限流 429」分开。
    const body = await tokenRes.text().catch(() => '')
    log('fail', {
      step: 'token_exchange',
      status: 502,
      error: 'token exchange failed',
      http_status: tokenRes.status,
      detail: body.slice(0, 200),
    })
    return json(502, { error: 'token exchange failed' })
  }
  const token = (await tokenRes.json()) as { access_token?: string; refresh_token?: string }
  if (!token.access_token || !token.refresh_token) {
    log('fail', { step: 'token_exchange', status: 502, error: 'token payload missing tokens' })
    return json(502, { error: 'token exchange failed' })
  }

  log('ok', { step: 'session_issued' })
  return json(200, {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  })
})

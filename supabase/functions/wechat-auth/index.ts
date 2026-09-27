// 微信登录桥接 Edge Function（Supabase 无 signInWithWechat 的替代方案，
// 规划 §6 / docs/wechat-miniprogram-migration-status.md §3.2）。
//
// 流程：wx.login code → jscode2session 换 openid → profiles.wechat_openid
// 查已有账号（无则 admin API 创建：合成邮箱 wechat_<openid>@placeholder.local，
// handle_new_user 触发器自动建 profile）→ 每次登录 admin 轮换随机密码 →
// /auth/v1/token?grant_type=password 换 session → 返回 access/refresh token。
//
// 安全设计：
// - verify_jwt=false：小程序未登录态调用，本函数以 code 换会话本身就是认证；
//   微信 code 单次有效且 5 分钟过期，服务端经 jscode2session 校验归属。
// - 密码仅服务端瞬时生成（crypto.randomUUID），用户永远不知；每次登录轮换。
// - 合成邮箱域名不可收信，邮箱路径无法登录该账号。
// - 密钥（WECHAT_APP_ID/WECHAT_APP_SECRET）经 supabase secrets 注入，不入库。

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const WECHAT_APP_ID = Deno.env.get('WECHAT_APP_ID') ?? ''
const WECHAT_APP_SECRET = Deno.env.get('WECHAT_APP_SECRET') ?? ''

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// 上游调用（微信 code2session、token 交换）必须显式超时：两者都没有默认上限，
// 对端挂起时函数会一直占着执行槽到 wall-clock 上限，而客户端早已放弃等待——
// 表现为「用户点了没反应，服务端却查不到任何失败记录」。8s 覆盖实测 1.7–4.4s 的跨境往返。
const UPSTREAM_TIMEOUT_MS = 8000

Deno.serve(async (req) => {
  const startedAt = Date.now()
  // 结构化日志：Supabase 把函数 stdout 收进 function_logs。排查「少数人登录失败」
  // 要靠它区分「请求没到达服务端」（只有客户端侧有痕迹）与「到达后在某一跳失败」——
  // 后者记录失败分支、累计耗时与微信原始 errcode。ms 为相对本次请求起点的累计耗时，
  // 因此逐条读出即得各步耗时，无需额外的分步计时。
  const log = (event: string, detail: Record<string, unknown> = {}): void => {
    console.log(JSON.stringify({ fn: 'wechat-auth', event, ms: Date.now() - startedAt, ...detail }))
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }
  if (req.method !== 'POST') {
    log('fail', { step: 'method', status: 405, error: 'method not allowed' })
    return json(405, { error: 'method not allowed' })
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    log('fail', { step: 'config', status: 500, error: 'server misconfigured' })
    return json(500, { error: 'server misconfigured' })
  }

  let code = ''
  let mode: 'login' | 'register' = 'login'
  try {
    const body = (await req.json()) as { code?: unknown; mode?: unknown }
    code = typeof body.code === 'string' ? body.code.trim() : ''
    if (body.mode === 'register') mode = 'register'
  } catch {
    log('fail', { step: 'parse_body', status: 400, error: 'invalid json body' })
    return json(400, { error: 'invalid json body' })
  }
  if (!code) {
    log('fail', { step: 'parse_body', status: 400, error: 'missing code', mode })
    return json(400, { error: 'missing code' })
  }

  // 1. code2session：code 换 openid
  const wxUrl =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APP_ID}` +
    `&secret=${WECHAT_APP_SECRET}&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`
  let wxData: { openid?: string; errcode?: number; errmsg?: string } = {}
  try {
    const wxRes = await fetch(wxUrl, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    wxData = (await wxRes.json()) as typeof wxData
  } catch (err) {
    log('fail', {
      step: 'code2session',
      status: 502,
      error: 'wechat api unreachable',
      detail: err instanceof Error ? err.message : String(err),
      mode,
    })
    return json(502, { error: 'wechat api unreachable' })
  }
  if (!wxData.openid) {
    // 微信侧错误码：40029 code 无效/已被使用，45011 频率限制，40226 高风险用户被拦截，
    // -1 系统繁忙。三者都返回给客户端同一文案，靠这里的 errcode 区分。
    log('fail', {
      step: 'code2session',
      status: 401,
      error: 'wechat code2session failed',
      wx_errcode: wxData.errcode ?? null,
      wx_errmsg: wxData.errmsg ?? null,
      mode,
    })
    return json(401, {
      error: 'wechat code2session failed',
      detail: wxData.errmsg ?? String(wxData.errcode ?? ''),
    })
  }
  const openid = wxData.openid
  log('step', { step: 'code2session', mode, openid8: openid.slice(0, 8) })

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 2. 按 openid 找/建账号
  let userId: string
  let email: string
  let isNew = false
  const { data: existing, error: lookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('wechat_openid', openid)
    .maybeSingle()

  if (lookupError) {
    log('fail', {
      step: 'profile_lookup',
      status: 500,
      error: 'profile lookup failed',
      detail: lookupError.message,
    })
    return json(500, { error: 'profile lookup failed' })
  }

  if (existing) {
    userId = existing.id
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId)
    if (userError || !userData.user?.email) {
      log('fail', {
        step: 'get_user',
        status: 500,
        error: 'get user failed',
        detail: userError?.message ?? 'user has no email',
      })
      return json(500, { error: 'get user failed' })
    }
    email = userData.user.email

    // mode="login" 且邮箱为合成邮箱（用户未完成注册）→ 返回 user_not_found
    if (mode === 'login' && email.endsWith('@placeholder.local')) {
      log('ok', { step: 'lookup', result: 'user_not_found', reason: 'placeholder_email', mode })
      return json(200, { error: 'user_not_found' })
    }
  } else {
    // mode="login" 且用户不存在 → 返回 user_not_found（由前端弹窗引导注册）
    if (mode === 'login') {
      log('ok', { step: 'lookup', result: 'user_not_found', reason: 'no_openid_match', mode })
      return json(200, { error: 'user_not_found' })
    }

    isNew = true
    email = `wechat_${openid}@placeholder.local`

    // createUser 可能因 email_exists 而 throw（SDK 对 422 直接抛异常），
    // 需要 try-catch 包裹：捕获后按 email 查找已有 auth user 并补写 openid 映射。
    let createdUserId: string | null = null
    try {
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        password: crypto.randomUUID().replace(/-/g, ''),
        user_metadata: { wechat_openid: openid },
      })
      if (createError || !created.user) {
        log('fail', {
          step: 'create_user',
          status: 500,
          error: 'create user failed',
          detail: createError?.message ?? '',
        })
        return json(500, { error: 'create user failed', detail: createError?.message ?? '' })
      }
      createdUserId = created.user.id
      // profile 由 handle_new_user 触发器自动创建，此处补写 openid 映射
      await admin.from('profiles').update({ wechat_openid: openid }).eq('id', createdUserId)
    } catch (createErr) {
      const msg = createErr instanceof Error ? createErr.message : String(createErr)
      if (!msg.includes('email_exists')) {
        log('fail', { step: 'create_user', status: 500, error: 'create user threw', detail: msg })
        return json(500, { error: 'create user failed', detail: msg })
      }
      // email 已存在：按合成邮箱查找已有 auth user
      const { data: existingUsers } = await admin.auth.admin.listUsers({ filter: `email eq ${email}` })
      const existingUser = existingUsers?.users?.[0]
      if (!existingUser) {
        log('fail', {
          step: 'create_user',
          status: 500,
          error: 'email_exists but user not found',
          detail: msg,
        })
        return json(500, { error: 'email_exists but user not found', detail: msg })
      }
      createdUserId = existingUser.id
      // 补写 openid 映射（profile 可能已存在但缺 wechat_openid）
      await admin.from('profiles').update({ wechat_openid: openid }).eq('id', createdUserId)
    }

    userId = createdUserId
  }

  // 3. 轮换随机密码（仅本次登录使用，用户永远不知）
  const password = crypto.randomUUID().replace(/-/g, '')
  const { error: pwdError } = await admin.auth.admin.updateUserById(userId, { password })
  if (pwdError) {
    log('fail', {
      step: 'rotate_password',
      status: 500,
      error: 'update password failed',
      detail: pwdError.message,
    })
    return json(500, { error: 'update password failed' })
  }
  log('step', { step: 'rotate_password', isNew })

  // 4. password grant 换 session
  let tokenRes: Response
  try {
    tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    log('fail', {
      step: 'token_exchange',
      status: 502,
      error: 'token exchange unreachable',
      detail: err instanceof Error ? err.message : String(err),
    })
    return json(502, { error: 'token exchange failed' })
  }
  if (!tokenRes.ok) {
    // 同一账号并发登录时，两次 rotate_password 会互相覆盖对方的随机密码，
    // 先到的那次 password grant 必然 invalid_credentials。记下 HTTP 状态与响应体，
    // 才能把它与「真的凭据错误」「限流 429」区分开——此前这一层完全无日志。
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

  log('ok', { mode, isNew })
  return json(200, {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    // 新注册用户标记：客户端据此提示「账号已创建，等待管理员审核」
    is_new: isNew,
  })
})

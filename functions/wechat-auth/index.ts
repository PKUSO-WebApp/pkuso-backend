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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    return json(500, { error: 'server misconfigured' })
  }

  let code = ''
  try {
    const body = (await req.json()) as { code?: unknown }
    code = typeof body.code === 'string' ? body.code.trim() : ''
  } catch {
    return json(400, { error: 'invalid json body' })
  }
  if (!code) return json(400, { error: 'missing code' })

  // 1. code2session：code 换 openid
  const wxUrl =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APP_ID}` +
    `&secret=${WECHAT_APP_SECRET}&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`
  let wxData: { openid?: string; errcode?: number; errmsg?: string } = {}
  try {
    const wxRes = await fetch(wxUrl)
    wxData = (await wxRes.json()) as typeof wxData
  } catch {
    return json(502, { error: 'wechat api unreachable' })
  }
  if (!wxData.openid) {
    return json(401, {
      error: 'wechat code2session failed',
      detail: wxData.errmsg ?? String(wxData.errcode ?? ''),
    })
  }
  const openid = wxData.openid

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
    return json(500, { error: 'profile lookup failed' })
  }

  if (existing) {
    userId = existing.id
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId)
    if (userError || !userData.user?.email) {
      return json(500, { error: 'get user failed' })
    }
    email = userData.user.email
  } else {
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
        return json(500, { error: 'create user failed', detail: createError?.message ?? '' })
      }
      createdUserId = created.user.id
      // profile 由 handle_new_user 触发器自动创建，此处补写 openid 映射
      await admin.from('profiles').update({ wechat_openid: openid }).eq('id', createdUserId)
    } catch (createErr) {
      const msg = createErr instanceof Error ? createErr.message : String(createErr)
      if (!msg.includes('email_exists')) {
        return json(500, { error: 'create user failed', detail: msg })
      }
      // email 已存在：按合成邮箱查找已有 auth user
      const { data: existingUsers } = await admin.auth.admin.listUsers({ filter: `email eq ${email}` })
      const existingUser = existingUsers?.users?.[0]
      if (!existingUser) {
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
    return json(500, { error: 'update password failed' })
  }

  // 4. password grant 换 session
  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ email, password }),
  })
  if (!tokenRes.ok) {
    return json(502, { error: 'token exchange failed' })
  }
  const token = (await tokenRes.json()) as { access_token?: string; refresh_token?: string }
  if (!token.access_token || !token.refresh_token) {
    return json(502, { error: 'token exchange failed' })
  }

  return json(200, {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    // 新注册用户标记：客户端据此提示「账号已创建，等待管理员审核」
    is_new: isNew,
  })
})

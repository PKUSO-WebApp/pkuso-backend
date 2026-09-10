// 微信注册 Edge Function
//
// 流程：微信 code → jscode2session 换 openid → 创建 auth user + profile → session token
// 用途：注册页面，用户填写资料后通过微信授权绑定创建账号
//
// 安全设计：
// - verify_jwt=false：注册阶段未登录
// - 微信 code 一次性有效（5 分钟过期），服务端经 jscode2session 校验归属
// - 密码仅服务端瞬时生成（crypto.randomUUID），用户永远不知
// - 合成邮箱域名不可收信
// - wechat_openid 唯一约束防止重复绑定

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
  let fullName = ''
  let email = ''
  let instrument = ''
  let college = ''
  let joinDate = ''

  try {
    const body = (await req.json()) as Record<string, unknown>
    code = typeof body.code === 'string' ? body.code.trim() : ''
    fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    instrument = typeof body.instrument === 'string' ? body.instrument.trim() : ''
    college = typeof body.college === 'string' ? body.college.trim() : ''
    joinDate = typeof body.join_date === 'string' ? body.join_date.trim() : ''
  } catch {
    return json(400, { error: 'invalid json body' })
  }

  if (!code) return json(400, { error: 'missing code' })
  if (!fullName) return json(400, { error: 'missing full_name' })
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'invalid email' })
  if (!instrument) return json(400, { error: 'missing instrument' })
  if (!college) return json(400, { error: 'missing college' })
  if (!joinDate) return json(400, { error: 'missing join_date' })

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

  // 2. 检查 openid 是否已绑定
  const { data: existingProfile, error: lookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('wechat_openid', openid)
    .maybeSingle()

  if (lookupError) {
    return json(500, { error: 'profile lookup failed' })
  }
  if (existingProfile) {
    return json(409, { error: 'wechat_already_bound' })
  }

  // 3. 创建 auth user
  const syntheticEmail = `wechat_${openid}@placeholder.local`
  const password = crypto.randomUUID().replace(/-/g, '')

  let userId: string
  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      email_confirm: true,
      password,
      user_metadata: { wechat_openid: openid },
    })
    if (createError || !created.user) {
      // email_exists: 合成邮箱冲突（极低概率），补写 openid
      const msg = createError?.message ?? ''
      if (msg.includes('email_exists')) {
        const { data: existingUsers } = await admin.auth.admin.listUsers({
          filter: `email eq ${syntheticEmail}`,
        })
        const existingUser = existingUsers?.users?.[0]
        if (existingUser) {
          userId = existingUser.id
          await admin.from('profiles').update({ wechat_openid: openid }).eq('id', userId)
        } else {
          return json(500, { error: 'email_exists but user not found' })
        }
      } else {
        return json(500, { error: 'create user failed', detail: msg })
      }
    } else {
      userId = created.user.id
      // profile 由 handle_new_user 触发器自动创建，此处更新完整信息
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json(500, { error: 'create user failed', detail: msg })
  }

  // 4. 更新 profile 完整信息
  const { error: profileUpdateError } = await admin
    .from('profiles')
    .update({
      full_name: fullName,
      email,
      instrument,
      college,
      join_date: joinDate,
      wechat_openid: openid,
    })
    .eq('id', userId)

  if (profileUpdateError) {
    console.error('[register-with-wechat] profile update error', profileUpdateError)
    return json(500, { error: 'profile update failed' })
  }

  // 5. 同步 auth 邮箱（让用户也可以用邮箱登录）
  const { error: authEmailError } = await admin.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  })
  if (authEmailError) {
    console.error('[register-with-wechat] auth email update error', authEmailError)
    const msg = authEmailError.message ?? ''
    if (msg.includes('email_exists') || msg.includes('already registered') || msg.includes('already in use')) {
      return json(409, { error: 'email_already_registered' })
    }
    return json(500, { error: 'auth email update failed', detail: msg })
  }

  // 6. 轮换随机密码 → password grant 换 session
  const newPassword = crypto.randomUUID().replace(/-/g, '')
  const { error: pwdError } = await admin.auth.admin.updateUserById(userId, { password: newPassword })
  if (pwdError) {
    return json(500, { error: 'update password failed' })
  }

  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ email, password: newPassword }),
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
  })
})

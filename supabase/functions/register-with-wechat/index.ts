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

import { adminClient, readServiceEnv } from '../_shared/client.ts'
import { CORS_HEADERS, json } from '../_shared/http.ts'

const WECHAT_APP_ID = Deno.env.get('WECHAT_APP_ID') ?? ''
const WECHAT_APP_SECRET = Deno.env.get('WECHAT_APP_SECRET') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const env = readServiceEnv()
  if (!env || !WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    return json({ error: 'server misconfigured' }, 500)
  }

  let code = ''
  let fullName = ''
  let email = ''
  let instrument = ''
  let college = ''
  let joinDate = ''
  let isInOrchestra: boolean | null = null

  try {
    const body = (await req.json()) as Record<string, unknown>
    code = typeof body.code === 'string' ? body.code.trim() : ''
    fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    instrument = typeof body.instrument === 'string' ? body.instrument.trim() : ''
    college = typeof body.college === 'string' ? body.college.trim() : ''
    joinDate = typeof body.join_date === 'string' ? body.join_date.trim() : ''
    if (typeof body.is_in_orchestra === 'boolean') {
      isInOrchestra = body.is_in_orchestra
    }
  } catch {
    return json({ error: 'invalid json body' }, 400)
  }

  if (!code) return json({ error: 'missing code' }, 400)
  if (!fullName) return json({ error: 'missing full_name' }, 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid email' }, 400)
  if (!instrument) return json({ error: 'missing instrument' }, 400)
  if (!college) return json({ error: 'missing college' }, 400)
  if (!joinDate) return json({ error: 'missing join_date' }, 400)

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
    return json({ error: 'wechat api unreachable' }, 502)
  }
  if (!wxData.openid) {
    return json({
      error: 'wechat code2session failed',
      detail: wxData.errmsg ?? String(wxData.errcode ?? ''),
    }, 401)
  }
  const openid = wxData.openid

  const admin = adminClient(env)

  // 2. 检查 openid 是否已绑定
  const { data: existingProfile, error: lookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('wechat_openid', openid)
    .maybeSingle()

  if (lookupError) {
    return json({ error: 'profile lookup failed' }, 500)
  }
  if (existingProfile) {
    return json({ error: 'wechat_already_bound' }, 409)
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
          return json({ error: 'email_exists but user not found' }, 500)
        }
      } else {
        return json({ error: 'create user failed', detail: msg }, 500)
      }
    } else {
      userId = created.user.id
      // profile 由 handle_new_user 触发器自动创建，此处更新完整信息
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json({ error: 'create user failed', detail: msg }, 500)
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
      is_in_orchestra: isInOrchestra,
    })
    .eq('id', userId)

  if (profileUpdateError) {
    console.error('[register-with-wechat] profile update error', profileUpdateError)
    return json({ error: 'profile update failed' }, 500)
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
      return json({ error: 'email_already_registered' }, 409)
    }
    return json({ error: 'auth email update failed', detail: msg }, 500)
  }

  // 6. 轮换随机密码 → password grant 换 session
  const newPassword = crypto.randomUUID().replace(/-/g, '')
  const { error: pwdError } = await admin.auth.admin.updateUserById(userId, { password: newPassword })
  if (pwdError) {
    return json({ error: 'update password failed' }, 500)
  }

  const tokenRes = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
    },
    body: JSON.stringify({ email, password: newPassword }),
  })
  if (!tokenRes.ok) {
    return json({ error: 'token exchange failed' }, 502)
  }
  const token = (await tokenRes.json()) as { access_token?: string; refresh_token?: string }
  if (!token.access_token || !token.refresh_token) {
    return json({ error: 'token exchange failed' }, 502)
  }

  return json({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  })
})

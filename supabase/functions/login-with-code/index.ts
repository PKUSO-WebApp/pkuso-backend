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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(500, { error: 'server misconfigured' })
  }

  let email = ''
  let code = ''
  try {
    const body = (await req.json()) as Record<string, unknown>
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    code = typeof body.code === 'string' ? body.code.trim() : ''
  } catch {
    return json(400, { error: 'invalid json body' })
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'invalid email' })
  }
  if (!code || code.length !== 6) {
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
    // 不暴露用户是否存在
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

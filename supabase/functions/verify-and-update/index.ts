// 验证码校验 + 执行操作 Edge Function
//
// 流程：JWT 认证 → 校验验证码（匹配 + 未过期 + 未使用）→ 标记 used → 执行操作
// 用途：password_change（修改密码）/ email_change（换绑邮箱 + 同步 profiles.email）
//
// 安全设计：
// - verify_jwt=true：仅登录用户可调用
// - 每次校验消耗最新 alive 码，防止重放
// - 密码修改用 admin API，不依赖用户当前密码（已在前端通过验证码确认身份）
//
// ** 所有响应统一 200，错误码放 body.error（兼容微信小程序 functions.invoke）**

import { readServiceEnv, serviceClient } from '../_shared/client.ts'
import { CORS_HEADERS, json } from '../_shared/http.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' })

  const env = readServiceEnv()
  if (!env) {
    return json({ error: 'server misconfigured' })
  }

  // JWT 认证
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing authorization header' })

  const supabase = serviceClient(env)

  // 从 JWT 获取 user_id
  const token = authHeader.replace('Bearer ', '')
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token)
  if (authError || !user) return json({ error: 'invalid token' })

  const userId = user.id
  const body = (await req.json().catch(() => null)) as {
    purpose?: string
    code?: string
    new_password?: string
    new_email?: string
  } | null

  if (!body?.purpose || !['password_change', 'email_change'].includes(body.purpose)) {
    return json({ error: 'invalid purpose' })
  }
  if (!body.code || body.code.length !== 6) {
    return json({ error: 'invalid code format' })
  }

  const purpose = body.purpose as 'password_change' | 'email_change'

  // 查询该用户最新的 alive 同 purpose 码
  const { data: codeRow, error: queryError } = await supabase
    .from('verification_codes')
    .select('id, code, expires_at')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (queryError || !codeRow) {
    return json({ error: 'no valid code found' })
  }

  // 检查过期
  const expiresAt = new Date(codeRow.expires_at).getTime()
  if (Date.now() > expiresAt) {
    await supabase.from('verification_codes').update({ used: true }).eq('id', codeRow.id)
    return json({ error: 'code expired' })
  }

  // 校验码是否匹配
  if (codeRow.code !== body.code.trim()) {
    return json({ error: 'code mismatch' })
  }

  // 标记码为 used
  await supabase.from('verification_codes').update({ used: true }).eq('id', codeRow.id)

  // 执行操作
  if (purpose === 'password_change') {
    if (!body.new_password || body.new_password.trim().length < 6) {
      return json({ error: 'password too short' })
    }
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      password: body.new_password.trim(),
    })
    if (updateError) {
      console.error('[verify-and-update] password update error', updateError)
      return json({ error: 'failed to update password' })
    }
    return json({ success: true })
  }

  // email_change
  if (!body.new_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.new_email.trim())) {
    return json({ error: 'invalid new email' })
  }
  const newEmail = body.new_email.trim()

  // 检查新邮箱是否已被其他用户占用（查 auth.users）
  const { data: emailCheck } = await supabase.rpc(
    'check_email_taken' as never,
    {
      p_email: newEmail,
      p_exclude_user_id: userId,
    } as never
  )

  if (emailCheck === true) {
    return json({ error: 'email_taken' })
  }

  // 更新 auth.users.email
  const { error: updateEmailError } = await supabase.auth.admin.updateUserById(userId, {
    email: newEmail,
  })
  if (updateEmailError) {
    const msg = updateEmailError.message ?? ''
    if (msg.includes('already') || msg.includes('duplicate') || msg.includes('unique')) {
      return json({ error: 'email_taken' })
    }
    console.error('[verify-and-update] email update error', updateEmailError)
    return json({ error: 'failed to update email' })
  }

  // 同步 profiles.email
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ email: newEmail })
    .eq('id', userId)

  if (profileError) {
    console.error('[verify-and-update] profile sync error', profileError)
  }

  return json({ success: true })
})

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
//
// 实现放在 handler.ts、index.ts 只负责 serve()：入口文件顶层会真的绑端口，
// 一被测试 import 就炸，于是它成了整个目录里唯一不能被覆盖的地方（见
// `../entry-guard.test.ts`）。先例：`delete-storage-file` / `ocr-analyze` / `llm-analyze`。

import {
  describeLookupFailure,
  findUnfinishedWechatAuthUser,
  syntheticEmailFor,
} from '../_shared/admin-users.ts'
import { adminClient, readServiceEnv } from '../_shared/client.ts'
import { CORS_HEADERS, json } from '../_shared/http.ts'

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // env 在**请求处理里**读，不在模块顶层：测试是先 import、后 `Deno.env.set` 的
  // （ES import 会被提升到模块体之前），模块顶层读到的是空。理由与
  // `_shared/client.ts` 顶部那段相同。
  const wechatAppId = Deno.env.get('WECHAT_APP_ID') ?? ''
  const wechatAppSecret = Deno.env.get('WECHAT_APP_SECRET') ?? ''

  const env = readServiceEnv()
  if (!env || !wechatAppId || !wechatAppSecret) {
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
  // 与 `profiles_join_date_check` 同一条判据（DB 只接受 `YYYY春` / `YYYY秋`）。
  // 格式错必须在这里回 400：再往后走，它会在**第 4 步**（auth user 已经建好之后）
  // 被约束拒掉 —— 那正是孤儿账号的来源（2026-10-10 那次）。
  if (!/^\d{4}(春|秋)$/.test(joinDate)) return json({ error: 'invalid join_date' }, 400)

  // 1. code2session：code 换 openid
  const wxUrl =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${wechatAppId}` +
    `&secret=${wechatAppSecret}&js_code=${encodeURIComponent(code)}` +
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
  const syntheticEmail = syntheticEmailFor(openid)
  const password = crypto.randomUUID().replace(/-/g, '')

  let userId: string | null = null
  let createFailure: string | null = null
  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      email_confirm: true,
      password,
      user_metadata: { wechat_openid: openid },
    })
    if (created?.user) {
      userId = created.user.id
      // profile 由 handle_new_user 触发器自动创建，此处更新完整信息
    } else {
      createFailure = createError?.message ?? ''
    }
  } catch (err) {
    createFailure = err instanceof Error ? err.message : String(err)
  }

  if (!userId) {
    // ⚠️ 建号失败时**不解读错误文案**（原来的 `msg.includes('email_exists')` 恒为假，
    // 因为机器码在 `error.code` 里，人话在 `error.message` 里），而是回到事实本身：
    // **用户表里到底有没有这个 openid 的未完成账号**。查不到就照原样回 500。
    //
    // 还有一层好处：`createUser` 在「服务端建好了、应答丢了」时也会报失败，
    // 而那种情况正是留下的孤儿账号的来源 —— 按事实查能把它救回来，按文案判不能。
    //
    // 查人判据（为什么不会把 A 认成 B）见 `_shared/admin-users.ts` 顶部：
    // 合成邮箱 + `user_metadata.wechat_openid` 两个条件同时成立才算命中，
    // 一个都不匹配 / 匹配到多个 / 没翻完 —— 一律不认。
    const lookup = await findUnfinishedWechatAuthUser(admin, openid)
    if (lookup.status !== 'found') {
      const detail = createFailure || describeLookupFailure(lookup)
      // ⚠️ openid 记**完整值**，与 `wechat-auth` 那条日志一致（#103）：这条日志就是给
      // 「这两次失败是不是同一个人」用的，截短之后认不了人 —— 截断方案已作废，别再改回去。
      console.error('[register-with-wechat] create user failed', {
        openid,
        create: createFailure,
        lookup: lookup.status,
        detail: describeLookupFailure(lookup),
      })
      return json({ error: 'create user failed', detail }, 500)
    }
    userId = lookup.user.id
    await admin.from('profiles').update({ wechat_openid: openid }).eq('id', userId)
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
}

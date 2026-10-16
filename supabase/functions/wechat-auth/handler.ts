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
//
// 实现放在 handler.ts、index.ts 只负责 serve()：入口文件顶层会真的绑端口，
// 一被测试 import 就炸（见 `../entry-guard.test.ts`）。

import {
  describeLookupFailure,
  findUnfinishedWechatAuthUser,
  syntheticEmailFor,
} from '../_shared/admin-users.ts'
import { adminClient, readServiceEnv } from '../_shared/client.ts'
import { createLogger } from '../_shared/diag.ts'
import { CORS_HEADERS_WITH_DIAG, json } from '../_shared/http.ts'
import { UPSTREAM_TIMEOUT_MS } from '../_shared/timeout.ts'

export async function handler(req: Request): Promise<Response> {
  // 结构化日志：Supabase 把函数 stdout 收进 function_logs。排查「少数人登录失败」
  // 要靠它区分「请求没到达服务端」（只有客户端侧有痕迹）与「到达后在某一跳失败」——
  // 后者记录失败分支、累计耗时与微信原始 errcode。ms 为相对本次请求起点的累计耗时，
  // 因此逐条读出即得各步耗时，无需额外的分步计时。
  // diag 来自客户端请求头，是与客户端那条失败记录对账的唯一凭据（见 _shared/diag.ts）。
  const { log } = createLogger('wechat-auth', req)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS_WITH_DIAG })
  }
  if (req.method !== 'POST') {
    log('fail', { step: 'method', status: 405, error: 'method not allowed' })
    return json({ error: 'method not allowed' }, 405)
  }

  // env 在**请求处理里**读，不在模块顶层：测试是先 import、后 `Deno.env.set` 的
  // （ES import 会被提升到模块体之前），模块顶层读到的是空。理由与
  // `_shared/client.ts` 顶部那段相同。
  const wechatAppId = Deno.env.get('WECHAT_APP_ID') ?? ''
  const wechatAppSecret = Deno.env.get('WECHAT_APP_SECRET') ?? ''

  const env = readServiceEnv()
  if (!env || !wechatAppId || !wechatAppSecret) {
    log('fail', { step: 'config', status: 500, error: 'server misconfigured' })
    return json({ error: 'server misconfigured' }, 500)
  }

  let code = ''
  let mode: 'login' | 'register' = 'login'
  try {
    const body = (await req.json()) as { code?: unknown; mode?: unknown }
    code = typeof body.code === 'string' ? body.code.trim() : ''
    if (body.mode === 'register') mode = 'register'
  } catch {
    log('fail', { step: 'parse_body', status: 400, error: 'invalid json body' })
    return json({ error: 'invalid json body' }, 400)
  }
  if (!code) {
    log('fail', { step: 'parse_body', status: 400, error: 'missing code', mode })
    return json({ error: 'missing code' }, 400)
  }

  // 1. code2session：code 换 openid
  const wxUrl =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${wechatAppId}` +
    `&secret=${wechatAppSecret}&js_code=${encodeURIComponent(code)}` +
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
    return json({ error: 'wechat api unreachable' }, 502)
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
    return json({
      error: 'wechat code2session failed',
      detail: wxData.errmsg ?? String(wxData.errcode ?? ''),
    }, 401)
  }
  const openid = wxData.openid
  // ⚠️ 记**完整** openid，字段名也照实叫 `openid` —— 别再改回截断（旧名 `openid8`）。
  // 这条日志存在的唯一目的是排查登录失败，而排查里绕不开「这两次失败是不是同一个人」：
  // 同一 appid 签发的 openid 共享一段前缀，截短之后的短串区分不了人 —— 按它归组会把
  // 两个人拼成一个人的故事，而那正是排查时最想拿到的那个判断。完整值是**有意的取舍**：
  // 它因此会落进日志流（受项目访问控制与保留期约束），换来日志里有一个真能认人的字段。
  // 反过来说别的地方也别松口：**会话令牌不进日志**（成功路径只记 mode / isNew）。
  //
  // 本函数**认人**也从来不看日志：从下面起一律按 openid 的**完整值**查
  // `profiles.wechat_openid`（#77 之后连查人的那条路也不再用截断或前缀）。
  log('step', { step: 'code2session', mode, openid })

  const admin = adminClient(env)

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
    return json({ error: 'profile lookup failed' }, 500)
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
      return json({ error: 'get user failed' }, 500)
    }
    email = userData.user.email

    // mode="login" 且邮箱为合成邮箱（用户未完成注册）→ 返回 user_not_found
    if (mode === 'login' && email.endsWith('@placeholder.local')) {
      log('ok', { step: 'lookup', result: 'user_not_found', reason: 'placeholder_email', mode })
      return json({ error: 'user_not_found' }, 200)
    }
  } else {
    // mode="login" 且用户不存在 → 返回 user_not_found（由前端弹窗引导注册）
    if (mode === 'login') {
      log('ok', { step: 'lookup', result: 'user_not_found', reason: 'no_openid_match', mode })
      return json({ error: 'user_not_found' }, 200)
    }

    isNew = true
    email = syntheticEmailFor(openid)

    // 建号可能因为「同一个 openid 上次建到一半留下的 auth 账号」而失败。失败时
    // **不解读错误文案**，而是回到事实本身：用户表里到底有没有这个 openid 的未完成账号。
    //
    // 以前这里是 `listUsers({ filter: 'email eq …' })` + `users[0]` —— 而 `filter`
    // 在 SDK 里压根没被读（见 `_shared/admin-users.ts` 顶部），拿到的是**第一页第一人**，
    // 于是会把一个陌生人的 id 当作「这个 openid 的账号」继续走：写 profiles、
    // 轮换他的密码、把**他的会话**发出去（pkuso-backend#77）。
    // 查人判据（合成邮箱 + 精确 metadata）见 `_shared/admin-users.ts`。
    let createdUserId: string | null = null
    let createFailure: string | null = null
    try {
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        password: crypto.randomUUID().replace(/-/g, ''),
        user_metadata: { wechat_openid: openid },
      })
      if (created?.user) {
        createdUserId = created.user.id
      } else {
        // ⚠️ `createUser` 命中 `AuthError`（含重复邮箱）时是 **return 而不是 throw**
        // （`catch { if (isAuthError(error)) return {data:{user:null}, error} }`），
        // 所以错误走的是这一支，不是下面的 catch —— 以前那层 catch 里的
        // `msg.includes('email_exists')` 因此永远进不去。
        createFailure = createError?.message ?? ''
      }
    } catch (createErr) {
      createFailure = createErr instanceof Error ? createErr.message : String(createErr)
    }

    if (!createdUserId) {
      const lookup = await findUnfinishedWechatAuthUser(admin, openid)
      if (lookup.status !== 'found') {
        log('fail', {
          step: 'create_user',
          status: 500,
          error: 'create user failed',
          detail: createFailure || describeLookupFailure(lookup),
          lookup: lookup.status,
          mode,
        })
        return json({ error: 'create user failed', detail: createFailure ?? '' }, 500)
      }
      createdUserId = lookup.user.id
    }

    // profile 由 handle_new_user 触发器自动创建，此处补写 openid 映射
    // （profile 可能已存在但缺 wechat_openid）
    await admin.from('profiles').update({ wechat_openid: openid }).eq('id', createdUserId)

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
    return json({ error: 'update password failed' }, 500)
  }
  log('step', { step: 'rotate_password', isNew })

  // 4. password grant 换 session
  let tokenRes: Response
  try {
    tokenRes = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
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
    return json({ error: 'token exchange failed' }, 502)
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
    return json({ error: 'token exchange failed' }, 502)
  }
  const token = (await tokenRes.json()) as { access_token?: string; refresh_token?: string }
  if (!token.access_token || !token.refresh_token) {
    log('fail', { step: 'token_exchange', status: 502, error: 'token payload missing tokens' })
    return json({ error: 'token exchange failed' }, 502)
  }

  log('ok', { mode, isNew })
  return json({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    // 新注册用户标记：客户端据此提示「账号已创建，等待管理员审核」
    is_new: isNew,
  })
}

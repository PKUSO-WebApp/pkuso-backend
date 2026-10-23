import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { handler } from './handler.ts'

/**
 * 跑法：`deno test --allow-env supabase/functions/register-with-wechat/`
 *
 * ## 这个文件守的是什么
 *
 * 注册链路上「auth 账号已经存在（合成邮箱占用）」那一支。改之前它是：
 *
 * ```ts
 * if (msg.includes('email_exists')) {                       // ← 恒假（机器码在 error.code 里）
 *   const { data } = await listUsers({ filter: `email eq …` })  // ← filter 不会被转发
 *   userId = data?.users?.[0].id                             // ← 拿的是「第一页第一人」
 * }
 * ```
 *
 * 两处错叠在一起，**后果不是「查不到」而是「认错人」**：那个陌生人的 id 会被当作
 * 「这个 openid 的账号」继续走完剩下的四步 —— 把调用者的资料写进他的 profile、
 * 改掉他的 auth 邮箱、轮换他的密码、**把换来的会话发给调用者**（pkuso-backend#77）。
 *
 * 所以这里的断言不是「返回 200 了」，而是**「碰到的到底是谁的 id」**：
 * 每个用例都把旁观者排在管理员列表的最前面，然后断言所有的写入与换汇都只指向
 * 真正该认的那个人。把实现换回 `users[0]`，第 2 条用例必红。
 */

const OPENID = 'o12bmxTcAAAA'
const SYNTHETIC = `wechat_${OPENID}@placeholder.local`
const USER_EMAIL = 'zhangsan@example.com'

const TARGET_ID = '22222222-2222-2222-2222-222222222222'
const BYSTANDER_ID = '11111111-1111-1111-1111-111111111111'
/** 真·新建时的 id（createUser 成功那条路） */
const FRESH_ID = '33333333-3333-3333-3333-333333333333'

type StubUser = {
  id: string
  email: string | null
  user_metadata: Record<string, unknown> | null
}

let recorded: Array<{ method: string; url: string; body: string }> = []
/** `profiles?select=id&wechat_openid=eq.<openid>` 的作答 */
let profileRows: Array<{ id: string }> = []
/** `sections?select=name,kind` 的作答（注册时校验声部用） */
let sectionRows: Array<{ name: string; kind: string }> = []
/** `POST /auth/v1/admin/users` 是否失败（模拟「合成邮箱已存在」） */
let createUserFails = false
/** 管理员列表的分页作答 */
let adminPages: StubUser[][] = []
/** 换 session 是否成功 */
let tokenOk = true

/** 旁观者：一个与本次注册毫不相干的正常账号。它排在列表第 1 位。 */
const bystander: StubUser = {
  id: BYSTANDER_ID,
  email: 'someone@example.com',
  user_metadata: { full_name: '无关的人' },
}

/** 该认的那个：上一轮注册建了 auth 账号、没走完留下的。 */
const target: StubUser = {
  id: TARGET_ID,
  email: SYNTHETIC.toLowerCase(),
  user_metadata: { wechat_openid: OPENID },
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? 'GET').toUpperCase()
  recorded.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' })

  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  // 微信 code2session
  if (url.includes('api.weixin.qq.com')) return Promise.resolve(jsonRes({ openid: OPENID }))

  // 管理员 API：单个用户（PUT 改邮箱 / 改密码）
  if (/\/auth\/v1\/admin\/users\/[0-9a-f-]{36}/.test(url)) {
    return Promise.resolve(jsonRes({ id: url.split('/').pop() }))
  }
  // 管理员 API：建号
  if (url.includes('/auth/v1/admin/users') && method === 'POST') {
    if (createUserFails) {
      // 形状照抄 GoTrue 的 adminUserCreate（422 + error_code）
      return Promise.resolve(
        jsonRes({
          code: 422,
          error_code: 'email_exists',
          msg: 'A user with this email address has already been registered',
        }, 422),
      )
    }
    return Promise.resolve(jsonRes({ id: FRESH_ID, email: SYNTHETIC }))
  }
  // 管理员 API：列表
  if (url.includes('/auth/v1/admin/users')) {
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    return Promise.resolve(jsonRes({ users: adminPages[page - 1] ?? [], aud: 'authenticated' }))
  }
  // PostgREST sections（注册时校验声部）
  if (url.includes('/rest/v1/sections')) return Promise.resolve(jsonRes(sectionRows))
  // PostgREST profiles
  if (url.includes('/rest/v1/profiles')) {
    if (method === 'PATCH') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(jsonRes(profileRows))
  }
  // password grant
  if (url.includes('/auth/v1/token')) {
    return Promise.resolve(
      tokenOk
        ? jsonRes({ access_token: 'AT', refresh_token: 'RT' })
        : jsonRes({ error: 'invalid_grant' }, 400),
    )
  }

  throw new Error(`这个测试没桩到的请求：${method} ${url}`)
}) as typeof fetch

Deno.env.set('SUPABASE_URL', 'https://test.supabase.co')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'TEST_SERVICE_KEY')
Deno.env.set('WECHAT_APP_ID', 'WX_APP_ID')
Deno.env.set('WECHAT_APP_SECRET', 'WX_APP_SECRET')

const reset = () => {
  recorded = []
  profileRows = []
  // 只放测试真正会用到的几个值：校验只按 name/kind 判定，不需要整份字典
  sectionRows = [
    { name: '第一小提琴', kind: 'instrument' },
    { name: '长号', kind: 'instrument' },
    { name: '其他', kind: 'special' },
    { name: '总谱', kind: 'special' },
    { name: '木管', kind: 'group' },
  ]
  createUserFails = false
  adminPages = []
  tokenOk = true
}

const register = (over: Record<string, unknown> = {}) =>
  handler(
    new Request('http://x/', {
      method: 'POST',
      body: JSON.stringify({
        code: 'WX_CODE',
        full_name: '张三',
        email: USER_EMAIL,
        instrument: '第一小提琴',
        college: '元培',
        join_date: '2024秋',
        is_in_orchestra: true,
        ...over,
      }),
    }),
  )

Deno.test('join_date 格式：服务端先校验，非法一律 400（不走到建号那一步）', async () => {
  for (const bad of ['2024-09-01', '2024夏', '24秋', 'Fall 2024', '2024 秋']) {
    reset()
    const res = await register({ join_date: bad })
    assertEquals(res.status, 400, `${bad} 应回 400`)
    assertEquals((await res.json() as { error: string }).error, 'invalid join_date')
    // 负向断言的同伴：合法值在同一条路径上是放行的（下面那组）
    assertEquals(recorded.length, 0, `${bad} 不该发起任何上游请求（code2session / 建号都不该跑）`)
  }
  for (const ok of ['2024秋', '2024春']) {
    reset()
    const res = await register({ join_date: ok })
    assertEquals(res.status, 200, `${ok} 应放行`)
  }
})

/**
 * 「写到**某个**账号身上」的请求 —— 正是认错人时会被写歪的那两处
 * （profile 的 openid 补写、auth 用户的改邮箱/改密码）。
 *
 * ⚠️ 别写成「所有非 GET 请求」：`POST /auth/v1/admin/users`（建号本身，没有 id）
 * 也会被算进去，于是「一个写入都不该发生」那条断言恒红，与认错人毫无关系。
 */
const accountWrites = () =>
  recorded.filter(
    (r) =>
      (r.method === 'PATCH' && r.url.includes('/rest/v1/profiles')) ||
      (r.method === 'PUT' && r.url.includes('/auth/v1/admin/users/')),
  )

/** 有没有任何一次请求指向这个 id（URL 或报文体里） */
const touches = (id: string) =>
  recorded.some((r) => r.url.includes(id) || r.body.includes(id))

// ---------------------------------------------------------------------------

Deno.test('正常新建：createUser 成功时**不去翻用户表**', async () => {
  reset()
  profileRows = [] // openid 未绑定
  adminPages = [[bystander]] // 就算表里有别人，也不该被翻到

  const res = await register()

  assertEquals(res.status, 200)
  assertEquals(await res.json(), { access_token: 'AT', refresh_token: 'RT' })
  assertEquals(
    recorded.some((r) => r.method === 'GET' && r.url.includes('/auth/v1/admin/users?')),
    false,
    'createUser 成功就不该去列用户表',
  )
})

Deno.test('★ 合成邮箱已存在：只认领按完整 openid 命中的那一个，绝不取列表第一个', async () => {
  reset()
  profileRows = [] // 没有 profile 绑这个 openid ⇒ 走到建号那一支
  createUserFails = true
  // 旁观者排在第 1 位 —— `users[0]` 那种实现会认领它
  adminPages = [[bystander, target]]

  const res = await register()

  assertEquals(res.status, 200)
  assertEquals(await res.json(), { access_token: 'AT', refresh_token: 'RT' })

  // 正向：profile 的 openid 补写落在**目标**身上
  const patch = recorded.find((r) => r.method === 'PATCH' && r.url.includes('/rest/v1/profiles'))
  assertEquals(patch !== undefined, true, '应该有一次 profile 补写')
  assertEquals(new URL(patch!.url).searchParams.get('id'), `eq.${TARGET_ID}`)

  // 负向：整场没有一次请求指向旁观者（改他的邮箱 / 轮换他的密码都会留下痕迹）
  assertEquals(touches(BYSTANDER_ID), false, '旁观者被碰了 —— 这正是 #77 那个认错人')
})

Deno.test('建号失败但一个都不匹配：回 500，且**一个人都不碰**', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[bystander]] // 只有旁观者，谁都不该被认领

  const res = await register()

  assertEquals(res.status, 500)
  assertEquals((await res.json() as { error: string }).error, 'create user failed')
  // 负向断言的同伴：这一场里「碰别人」是有可能发生的（就是被修掉的那个 bug），
  // 所以下面这条不是空转
  assertEquals(touches(BYSTANDER_ID), false)
  assertEquals(accountWrites().length, 0, '认不出人就一个写入都不该发生')
})

Deno.test('两个账号同时命中：回 500，不猜', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[{ ...target, id: '44444444-4444-4444-4444-444444444444' }, target]]

  const res = await register()

  assertEquals(res.status, 500)
  assertEquals(touches(TARGET_ID), false)
  assertEquals(accountWrites().length, 0, '命中了两个就不该写任何一个')
})

Deno.test('邮箱被占但 metadata 是别人的 openid：不算命中（只比 email 的实现会红）', async () => {
  reset()
  profileRows = []
  createUserFails = true
  // 一个占着这串地址、却声称自己是别人 openid 的账号
  adminPages = [[{ id: BYSTANDER_ID, email: SYNTHETIC.toLowerCase(), user_metadata: { wechat_openid: 'o12bmxSomebodyElse' } }]]

  const res = await register()

  assertEquals(res.status, 500)
  assertEquals(touches(BYSTANDER_ID), false)
})

Deno.test('建号失败但账号其实已建好（应答丢了）：照样认回来并按他继续', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[target]]

  const res = await register()

  assertEquals(res.status, 200)
  const patch = recorded.find((r) => r.method === 'PATCH' && r.url.includes('/rest/v1/profiles'))
  assertEquals(new URL(patch!.url).searchParams.get('id'), `eq.${TARGET_ID}`)
  // 换 session 用的是**这次注册填的邮箱**，不是合成邮箱
  const tokenReq = recorded.find((r) => r.url.includes('/auth/v1/token'))
  assertEquals(JSON.parse(tokenReq!.body).email, USER_EMAIL)
})

Deno.test('openid 已绑定：409，一个写入都不发生', async () => {
  reset()
  profileRows = [{ id: TARGET_ID }]

  const res = await register()

  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'wechat_already_bound' })
  assertEquals(
    recorded.some((r) => r.method !== 'GET'),
    false,
    '已绑定就该原地返回，不该有任何写入',
  )
})

Deno.test('旧版 mp 的 Other / OTHER：归一为 其他 后落库', async () => {
  for (const legacy of ['Other', 'OTHER']) {
    reset()
    const res = await register({ instrument: legacy })
    assertEquals(res.status, 200, `${legacy} 应放行`)

    const patch = recorded.find((r) => r.method === 'PATCH' && r.url.includes('/rest/v1/profiles'))
    assertEquals(patch !== undefined, true, `${legacy} 应该写 profile`)
    assertEquals(JSON.parse(patch!.body).instrument, '其他')
  }
})

Deno.test('非标准声部：400，且不调用微信、不建号', async () => {
  for (const bad of ['小提琴', '总谱', 'Piano', '木管']) {
    reset()
    const res = await register({ instrument: bad })
    assertEquals(res.status, 400, `${bad} 应回 400`)
    assertEquals((await res.json() as { error: string }).error, 'unknown instrument')
    assertEquals(
      recorded.some((r) => r.url.includes('api.weixin.qq.com')),
      false,
      `${bad} 不该调用微信 code2session`,
    )
    assertEquals(
      recorded.some((r) => r.method === 'POST' && r.url.includes('/auth/v1/admin/users')),
      false,
      `${bad} 不该创建 auth user`,
    )
  }
})

Deno.test('标准乐器放行（长号）', async () => {
  reset()
  const res = await register({ instrument: '长号' })
  assertEquals(res.status, 200)
})

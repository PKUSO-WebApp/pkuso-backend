import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { handler } from './handler.ts'

/**
 * 跑法：`deno test --allow-env supabase/functions/wechat-auth/`
 *
 * ## 这个文件守的是什么
 *
 * 这个函数是整条微信登录链路的入口，**此前一条测试都没有**（`deno test` 只检查被
 * import 到的模块图，而入口文件按设计没法被 import —— 见 `../entry-guard.test.ts`）。
 * 而它里面那处「合成邮箱已存在」的分支正是 #77 里最贵的一处：
 *
 * ```ts
 * const { data } = await listUsers({ filter: `email eq ${email}` })  // filter 不被转发
 * createdUserId = data?.users?.[0].id                                // 拿的是第一页第一人
 * ```
 *
 * 撞对的后果比 register-with-wechat 那条更直接 —— 紧接着就是轮换那个人的密码、
 * 拿合成邮箱换 session 并把**那个人的会话**发出去。也就是说：任何一个能在
 * `mode=register` 下拿到有效 code2session 的调用者，都可能拿到**用户表第一页第一人**
 * 的登录态。
 *
 * 所以这里的断言全都落在「碰到的到底是谁的 id」上：旁观者永远排在管理员列表第一位。
 */

const OPENID = 'o12bmxTcAAAA'
const SYNTHETIC = `wechat_${OPENID}@placeholder.local`

const TARGET_ID = '22222222-2222-2222-2222-222222222222'
const BYSTANDER_ID = '11111111-1111-1111-1111-111111111111'
const FRESH_ID = '33333333-3333-3333-3333-333333333333'

type StubUser = {
  id: string
  email: string | null
  user_metadata: Record<string, unknown> | null
}

let recorded: Array<{ method: string; url: string; body: string }> = []
let profileRows: Array<{ id: string }> = []
/** `GET /auth/v1/admin/users/<id>` 的作答 */
let userById: { id: string; email: string | null } | null = null
let createUserFails = false
let adminPages: StubUser[][] = []

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

  if (url.includes('api.weixin.qq.com')) return Promise.resolve(jsonRes({ openid: OPENID }))

  if (/\/auth\/v1\/admin\/users\/[0-9a-f-]{36}/.test(url)) {
    if (method === 'GET') return Promise.resolve(jsonRes(userById))
    return Promise.resolve(jsonRes({ id: url.split('/').pop() }))
  }
  if (url.includes('/auth/v1/admin/users') && method === 'POST') {
    if (createUserFails) {
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
  if (url.includes('/auth/v1/admin/users')) {
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    return Promise.resolve(jsonRes({ users: adminPages[page - 1] ?? [], aud: 'authenticated' }))
  }
  if (url.includes('/rest/v1/profiles')) {
    if (method === 'PATCH') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(jsonRes(profileRows))
  }
  if (url.includes('/auth/v1/token')) {
    return Promise.resolve(jsonRes({ access_token: 'AT', refresh_token: 'RT' }))
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
  userById = null
  createUserFails = false
  adminPages = []
}

const call = (mode: 'login' | 'register') =>
  handler(
    new Request('http://x/', {
      method: 'POST',
      body: JSON.stringify({ code: 'WX_CODE', mode }),
    }),
  )

/** 「写到某个账号身上」的请求：profile 的 openid 补写、auth 用户的改密码。 */
const accountWrites = () =>
  recorded.filter(
    (r) =>
      (r.method === 'PATCH' && r.url.includes('/rest/v1/profiles')) ||
      (r.method === 'PUT' && r.url.includes('/auth/v1/admin/users/')),
  )

const touches = (id: string) => recorded.some((r) => r.url.includes(id) || r.body.includes(id))

// ---------------------------------------------------------------------------

Deno.test('登录（已绑定）：轮换密码并换回会话', async () => {
  reset()
  profileRows = [{ id: TARGET_ID }]
  userById = { id: TARGET_ID, email: 'zhangsan@example.com' }

  const res = await call('login')

  assertEquals(res.status, 200)
  assertEquals(await res.json(), { access_token: 'AT', refresh_token: 'RT', is_new: false })
})

Deno.test('登录（未绑定）：user_not_found，不建号、不写任何账号', async () => {
  reset()
  profileRows = []

  const res = await call('login')

  assertEquals(res.status, 200)
  assertEquals(await res.json(), { error: 'user_not_found' })
  assertEquals(accountWrites().length, 0)
})

Deno.test('登录（绑了但没完成注册，还是合成邮箱）：user_not_found', async () => {
  reset()
  profileRows = [{ id: TARGET_ID }]
  userById = { id: TARGET_ID, email: SYNTHETIC }

  const res = await call('login')

  assertEquals(await res.json(), { error: 'user_not_found' })
})

Deno.test('注册（全新）：建号成功后把 openid 补写到**新账号**上', async () => {
  reset()
  profileRows = []
  adminPages = [[bystander]]

  const res = await call('register')

  assertEquals(res.status, 200)
  assertEquals(await res.json(), { access_token: 'AT', refresh_token: 'RT', is_new: true })
  const patch = accountWrites().find((r) => r.method === 'PATCH')
  assertEquals(new URL(patch!.url).searchParams.get('id'), `eq.${FRESH_ID}`)
})

Deno.test('★ 注册撞上已存在的合成邮箱：只认领按完整 openid 命中的那一个，绝不取列表第一个', async () => {
  reset()
  profileRows = []
  createUserFails = true
  // 旁观者排在第 1 位 —— `users[0]` 那种实现会把他的会话发出去
  adminPages = [[bystander, target]]

  const res = await call('register')

  assertEquals(res.status, 200)
  assertEquals(await res.json(), { access_token: 'AT', refresh_token: 'RT', is_new: true })

  // 正向：轮换密码打在**目标**身上
  const put = recorded.find((r) => r.method === 'PUT' && r.url.includes('/auth/v1/admin/users/'))
  assertEquals(put !== undefined, true, '应该有一次改密码')
  assertEquals(put!.url.endsWith(`/auth/v1/admin/users/${TARGET_ID}`), true)

  // 负向：整场没有一次请求指向旁观者 —— 指向他就等于把**他的**会话发出去
  assertEquals(touches(BYSTANDER_ID), false, '旁观者被碰了 —— 这正是 #77 那个认错人')
})

Deno.test('注册建号失败且一个都不匹配：回 500，且一个账号都不碰', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[bystander]]

  const res = await call('register')

  assertEquals(res.status, 500)
  assertEquals((await res.json() as { error: string }).error, 'create user failed')
  assertEquals(touches(BYSTANDER_ID), false)
  assertEquals(accountWrites().length, 0)
})

Deno.test('注册撞上两个命中：回 500，不猜', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[{ ...target, id: '44444444-4444-4444-4444-444444444444' }, target]]

  const res = await call('register')

  assertEquals(res.status, 500)
  assertEquals(accountWrites().length, 0)
})

Deno.test('注册撞上邮箱被占但 metadata 是别人的 openid：回 500，不认领', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[{
    id: BYSTANDER_ID,
    email: SYNTHETIC.toLowerCase(),
    user_metadata: { wechat_openid: 'o12bmxSomebodyElse' },
  }]]

  const res = await call('register')

  assertEquals(res.status, 500)
  assertEquals(touches(BYSTANDER_ID), false)
  assertEquals(accountWrites().length, 0)
})

Deno.test('注册建号失败但账号其实已建好（应答丢了）：认回来并接着走', async () => {
  reset()
  profileRows = []
  createUserFails = true
  adminPages = [[target]]

  const res = await call('register')

  assertEquals(res.status, 200)
  const put = recorded.find((r) => r.method === 'PUT' && r.url.includes('/auth/v1/admin/users/'))
  assertEquals(put!.url.endsWith(`/auth/v1/admin/users/${TARGET_ID}`), true)
})

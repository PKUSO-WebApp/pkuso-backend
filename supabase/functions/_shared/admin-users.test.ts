import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  ADMIN_USERS_PER_PAGE,
  findUnfinishedWechatAuthUser,
  MAX_ADMIN_USER_PAGES,
  syntheticEmailFor,
} from './admin-users.ts'

/**
 * 跑法：`deno test --allow-env supabase/functions/_shared/admin-users.test.ts`
 *
 * ## 这个文件守的是什么
 *
 * 微信登录/注册链路上「合成邮箱已存在」那一支，以前是
 * `(await listUsers({ filter })).data.users[0]` —— 而 `filter` 在 SDK 里**压根没被读**
 * （见 admin-users.ts 顶部）。于是它拿的是「用户表第一页第一人」，然后把这个陌生人的
 * id 当作「邮箱已存在的那个人」继续走：写 profiles、改 auth 邮箱、轮换密码、换会话
 * —— 也就是把**另一个人的账号**交给调用者（pkuso-backend#77）。
 *
 * 所以这里每一条断言都对应「查人判据」的某一个条件或某一个失败方向，而不是泛泛的
 * 行为覆盖。判别力靠**诱饵**：每个用例都把「错误实现会误认的那个账号」放在目标前面，
 * 并断言它**没有被认领**。
 *
 * ⚠️ 最重要的两条是「翻页」（目标在第 2 页）与「一个都匹配不上时返回 absent」
 * —— 把实现换回 `users[0]`，后者必红（前者可能还绿，因为它排在第一位）。
 */

type StubUser = {
  id: string
  email: string | null
  user_metadata: Record<string, unknown> | null
}

/** 分页作答：`pages[0]` 是第 1 页。缺的页按空页算。 */
let pages: StubUser[][] = []
let listFails = false
let requests: string[] = []

globalThis.fetch = ((input: string | URL | Request) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  requests.push(url)

  if (!url.includes('/auth/v1/admin/users')) {
    throw new Error(`这个文件只该请求 admin users，却收到了：${url}`)
  }
  if (listFails) {
    return Promise.resolve(
      new Response(JSON.stringify({ code: 500, msg: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }
  const page = Number(new URL(url).searchParams.get('page') ?? '1')
  // 形状照抄真实端点：`GET /admin/users` 回的是 `{ users: [...], aud: ... }`，
  // **不是**一个裸数组。写错这一处，`data.users` 会是 undefined，于是所有用例都
  // 走到 absent —— 那条「一个都匹配不上」的用例照样绿，红的是别处。
  return Promise.resolve(
    new Response(JSON.stringify({ users: pages[page - 1] ?? [], aud: 'authenticated' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}) as typeof fetch

Deno.env.set('SUPABASE_URL', 'https://test.supabase.co')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'TEST_SERVICE_KEY')

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

/** 本次要认领的那个 openid —— 刻意带大小写（微信 openid 是大小写敏感的 base64url 串）。 */
const TARGET_OPENID = 'o12bmxTcAAAA'

/**
 * 库里那行长什么样：**email 是折叠过大小写的**。
 *
 * 这不是我编的偏好，是这条用例存在的理由之一：GoTrue 存 email 时会自己归一，
 * 所以拿 `wechat_${openid}@…` 原样去比会**永远比不中** —— 那正是「查人路径从来没
 * 真正生效过」的形态。把这条夹具写成折叠后的样子，任何去掉折叠的实现都会红。
 */
const storedTarget = (): StubUser => ({
  id: 'u-target',
  email: syntheticEmailFor(TARGET_OPENID).toLowerCase(),
  user_metadata: { wechat_openid: TARGET_OPENID },
})

/** 一个与本次请求毫不相干的正常账号（`users[0]` 会误认成它）。 */
const bystander: StubUser = {
  id: 'u-bystander',
  email: 'zhangsan@example.com',
  user_metadata: { full_name: '张三' },
}

/**
 * 两个字段互相矛盾的账号：邮箱是**另一个** openid 的合成邮箱，却正好把目标那串当作
 * 前缀；metadata 又写着目标。只比 metadata 的实现、以及拿前缀/包含来比邮箱的实现
 * 都会认领它。
 *
 * 现实里对应两种数据：老版本代码把 metadata 写歪留下的行，以及有人手动改过
 * `user_metadata` —— 它本来就是用户自己能写的（见 `admin-users.ts` 顶部的论证）。
 * 认人判据必须把「两个字段都指向同一个 openid」当作必要条件，所以这种行**一个都不认**。
 */
const prefixClaimant: StubUser = {
  id: 'u-prefix-claimant',
  email: syntheticEmailFor(`${TARGET_OPENID}X`).toLowerCase(),
  user_metadata: { wechat_openid: TARGET_OPENID },
}

/** 邮箱对得上、metadata 却是**别人的** openid（只比 email 的实现会误认）。 */
const squatter: StubUser = {
  id: 'u-squatter',
  email: syntheticEmailFor(TARGET_OPENID).toLowerCase(),
  user_metadata: { wechat_openid: 'o12bmxSomeoneElse' },
}

/** metadata 对得上、邮箱却不是这个 openid 的（只比 metadata 的实现会误认）。 */
const otherEmailSameMetadata: StubUser = {
  id: 'u-other-email',
  email: syntheticEmailFor('o12bmxZzzzZZZZ').toLowerCase(),
  user_metadata: { wechat_openid: TARGET_OPENID },
}

/** metadata 里没有 openid（老数据 / 别处建的账号）。 */
const noMetadata: StubUser = {
  id: 'u-no-metadata',
  email: syntheticEmailFor(TARGET_OPENID).toLowerCase(),
  user_metadata: {},
}

/** 一批与本次查询无关的账号，用来把目标挤到下一页 / 挤到后面。 */
const fillers = (n: number, from = 0): StubUser[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `u-filler-${from + i}`,
    email: `member${from + i}@example.com`,
    user_metadata: {},
  }))

const reset = () => {
  pages = []
  listFails = false
  requests = []
}

const lookup = () => findUnfinishedWechatAuthUser(admin, TARGET_OPENID)

// ---------------------------------------------------------------------------

Deno.test('合成邮箱由 openid 生成（查人与建号共用同一份）', () => {
  assertEquals(syntheticEmailFor('o12bmxTcAAAA'), 'wechat_o12bmxTcAAAA@placeholder.local')
})

Deno.test('目标与陌生人在同一页：只认领目标 —— 绝不取「第一个」', async () => {
  reset()
  // 三个陌生人排在前面：`users[0]` 那种实现会认领第一个，
  // 拿前缀比邮箱的实现会认领 prefixClaimant
  pages = [[bystander, prefixClaimant, storedTarget()]]

  const got = await lookup()

  assertEquals(got.status, 'found')
  assertEquals(got.status === 'found' && got.user.id, 'u-target')
})

Deno.test('目标在第 2 页：翻页也要找到（第 1 页必须是满页）', async () => {
  reset()
  // 满页 = 后面还有；这一条同时钉住「不许只拉一页」
  pages = [fillers(ADMIN_USERS_PER_PAGE), [bystander, storedTarget()]]

  const got = await lookup()

  assertEquals(got.status, 'found')
  assertEquals(got.status === 'found' && got.user.id, 'u-target')
  assertEquals(requests.length, 2, '应该正好拉了 2 页')
})

Deno.test('一个都匹配不上：返回 absent，而不是把第一页第一人交出去', async () => {
  reset()
  pages = [[bystander, prefixClaimant, squatter, otherEmailSameMetadata, noMetadata]]

  const got = await lookup()

  assertEquals(got.status, 'absent')
})

Deno.test('邮箱对得上但 metadata 是别人的 openid：不算命中（只比 email 的实现会红）', async () => {
  reset()
  // 只有 squatter 一个候选：误认它就等于把调用者的会话发给一个陌生人
  pages = [[squatter]]

  const got = await lookup()

  assertEquals(got.status, 'absent')
})

Deno.test('metadata 对得上但邮箱不是这个 openid：不算命中（只比 metadata 的实现会红）', async () => {
  reset()
  pages = [[otherEmailSameMetadata]]

  const got = await lookup()

  assertEquals(got.status, 'absent')
})

Deno.test('前缀撞车：邮箱只差一个字符、metadata 却写着目标 —— 不算命中（拿前缀比邮箱的实现会红）', async () => {
  reset()
  // 只有它一个候选。误认它就等于把调用者的会话发给一个**邮箱并不是这串**的账号
  pages = [[prefixClaimant]]

  const got = await lookup()

  assertEquals(got.status, 'absent')
})

Deno.test('两个账号同时命中（数据异常）：报 ambiguous，一个都不认', async () => {
  reset()
  pages = [[storedTarget(), { ...storedTarget(), id: 'u-target-2' }]]

  const got = await lookup()

  assertEquals(got.status, 'ambiguous')
  assertEquals(got.status === 'ambiguous' && got.count, 2)
})

Deno.test('只差大小写的两个 openid：认准逐字符相等的那一个', async () => {
  reset()
  // `o12bmxtcAAAA` 与目标 `o12bmxTcAAAA` 折叠后同形。库里能不能真的同时存在这样两行
  // 取决于 GoTrue 存的 email 折不折叠 —— 这一条**不依赖那个答案**：
  // metadata 逐字符比对，认领的永远是请求里那个 openid 自己的账号。
  // （反过来说：若把 metadata 也比成折叠的，这里会变成 ambiguous —— 失败方向是
  //   查不到，不是认错人。）
  const caseVariant: StubUser = {
    id: 'u-case-variant',
    email: syntheticEmailFor('o12bmxtcAAAA').toLowerCase(),
    user_metadata: { wechat_openid: 'o12bmxtcAAAA' },
  }
  pages = [[caseVariant, storedTarget()]]

  const got = await lookup()

  assertEquals(got.status, 'found')
  assertEquals(got.status === 'found' && got.user.id, 'u-target')
})

Deno.test('翻满页数上限还没翻完：报 truncated（不是 absent）', async () => {
  reset()
  // 每一页都满 ⇒ 永远「后面还有」
  pages = Array.from({ length: MAX_ADMIN_USER_PAGES }, (_, i) =>
    fillers(ADMIN_USERS_PER_PAGE, i * ADMIN_USERS_PER_PAGE),
  )

  const got = await lookup()

  assertEquals(got.status, 'truncated')
  assertEquals(requests.length, MAX_ADMIN_USER_PAGES)
})

Deno.test('列表接口失败：报 error 并带上上游文案（不是当成「没有这个人」）', async () => {
  reset()
  listFails = true

  const got = await lookup()

  assertEquals(got.status, 'error')
  assertStringIncludes(got.status === 'error' ? got.message : '', 'boom')
})

Deno.test('请求形状：分页拉取，不带 filter（filter 在 SDK 里根本不会被读）', async () => {
  reset()
  pages = [[bystander]]

  await lookup()

  assertEquals(requests.length, 1)
  const url = new URL(requests[0])
  assertEquals(url.pathname, '/auth/v1/admin/users')
  assertEquals(url.searchParams.get('page'), '1')
  assertEquals(url.searchParams.get('per_page'), String(ADMIN_USERS_PER_PAGE))
  assertEquals(url.searchParams.has('filter'), false)
})

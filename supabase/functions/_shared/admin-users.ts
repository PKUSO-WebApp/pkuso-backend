/**
 * 「按完整 WeChat openid 找那个未注册完成的 auth 账号」—— 微信登录/注册链路里
 * 「合成邮箱已存在」这一支唯一的查人方式（pkuso-backend#77）。
 *
 * ## 为什么不写 `listUsers({ filter: ... })`
 *
 * 2026-10-17 源码级核实（`@supabase/auth-js` 2.116 / 2.117，本机 deno npm 缓存里那两份）：
 * `GoTrueAdminApi.listUsers()` 构造 query 时**只读 `params?.page` 与 `params?.perPage`**，
 * `filter` 在实现里一次都没出现（`PageParams` 也只有这两个字段）。所以那句话即使传进去
 * 也**不会**进 URL —— 实际请求是 `GET /admin/users?page=&per_page=`，返回**第一页**。
 * 于是原来那种写法 `const u = (await listUsers({filter})).data.users[0]` 拿到的是
 * 「用户表第一页第一人」，与要找的人无关。
 *
 * ## 为什么不自己拼一个带 `filter` 的 fetch
 *
 * 远端 Admin API 支不支持 `filter` 这个查询参数，「客户端发得对不对」验证不了 ——
 * 服务端**忽略未知查询参数**时，你会原封不动地复现上面那个「返回第一页」的 bug，
 * 而且这次连类型检查都没有（自己拼的 URL 不过 SDK）。**必须选一条客户端自己就能
 * 判对错的查法**：分页拉取 + 本地精确比对。
 *
 * ## 认人判据（这就是「不会把 A 认成 B」的全部内容）
 *
 * 候选的**必要条件**是两个，同时成立：
 *
 * 1. `user.email` 与 `wechat_<openid>@placeholder.local` **按大小写折叠后**相等；
 * 2. `user.user_metadata.wechat_openid` 与 openid **逐字符完全相等**（不折叠大小写）。
 *
 * 为什么第 1 条要折叠大小写、而第 2 条不折叠：
 *
 * - GoTrue 存 email 时会自己归一（大小写、去空白），所以库里那行的 email 未必与
 *   我们拼出来的串逐字相同；不折叠就永远匹配不上，等于这条恢复路径从来没生效过
 *   —— 而那正是它现在「恒 500」的形态之一。折叠之后，**认人这件事完全落在第 2 条上**。
 * - 第 2 条读的是 `user_metadata`，JSON 值原样存取，**不经过任何归一**。所以
 *   「两个 openid 只差大小写」这种理论上的撞车（`o12bmxTc` vs `o12bmxtc`）在这里
 *   被分得干干净净：请求 `o12bmxTc` 时，那个 `o12bmxtc` 的账号 metadata 对不上，
 *   不会被认领。**判据因此不依赖「GoTrue 到底折不折叠 email」这个我们没在真机上
 *   核过的问题** —— 折叠只用来放宽候选，不放宽身份。
 *
 * ⚠️ **两个条件都要**，不能用其中一个换另一个：
 * - 只比 email ⇒ 少了「这个账号确实属于这个 openid」的证据，只说明「有人占了这串地址」；
 * - 只比 metadata ⇒ `user_metadata` 是**用户自己能写的**。攻击者把自己的账号
 *   metadata 写成受害者的 openid，等受害者来注册时，这段代码就会把受害者的会话
 *   发到一个仍归攻击者所有的账号上（攻击者当初填的 recovery 邮箱还能收信）。
 *   加上 email 这一条，攻击者得先让**自己的账号邮箱**变成受害者的合成邮箱才够得着。
 *
 * ## 找不到时**绝不退而求其次**
 *
 * 返回 `absent` / `ambiguous` / `truncated` / `error` 四种「没找到」，调用方一律
 * 回 500 并记日志。**没有「取第一个」这个选项** —— 那是 #77 里最危险的那件事。
 *
 * 另一种写法是把 openid（或合成邮箱）落到 `public.profiles` 的某一列上再查 ——
 * 那要一条 migration，而且 `profiles.wechat_openid` **本来就是**那一列：本模块存在的
 * 前提，恰恰是调用方已经查过它、没查到（否则早就走「已绑定」那条路了）。
 */

import type { SupabaseClient, User } from 'npm:@supabase/supabase-js@2'

/** 合成邮箱的域名。不可收信，所以这条登录路径永远走不通（见两个函数的顶部注释）。 */
export const SYNTHETIC_EMAIL_DOMAIN = 'placeholder.local'

/**
 * openid → 合成邮箱。**两个函数与这里的查人逻辑共用这一份**：以前它是在两处
 * 手抄的字面量，一旦哪一处改了（比如换域名），查人就会去找一个再也不存在的地址，
 * 而失败方向是「恒 500」——不响、不报错，只是谁都注册不上。
 */
export function syntheticEmailFor(openid: string): string {
  return `wechat_${openid}@${SYNTHETIC_EMAIL_DOMAIN}`
}

/**
 * 每页拉多少个。取 1000（GoTrue 允许的上限）：本项目用户量在几百的量级，
 * 一次请求就能拉完，正常路径下不会有第二次往返。
 * ⚠️ 别改成「一页够用」的假设 —— 下面判「翻完没有」看的是**返回条数是否满页**。
 */
export const ADMIN_USERS_PER_PAGE = 1000

/**
 * 最多翻几页。翻满还没翻完就**报错**，不返回「没找到」——
 * 把「没查完」说成「查不到」正是 #77 那类静默错误的一种。
 * 20 × 1000 = 两万账号；真的到了那一天，这条日志会告诉你该换查法了。
 */
export const MAX_ADMIN_USER_PAGES = 20

/** 查人结果。四种「没找到」要**分开**：它们的排查动作完全不同。 */
export type AuthUserLookup =
  /** 恰好一个账号同时满足 email 与 metadata，返回它 */
  | { status: 'found'; user: User }
  /** 翻完了，没有任何账号满足两个条件 */
  | { status: 'absent'; scanned: number }
  /** 有两个以上账号满足（数据异常），一个都不认 */
  | { status: 'ambiguous'; count: number; scanned: number }
  /** 翻到页数上限还没翻完 —— 结论未知，不是「没有」 */
  | { status: 'truncated'; scanned: number }
  /** 列表接口本身失败（网络 / 权限 / 上游 5xx） */
  | { status: 'error'; message: string }

/**
 * 四种「没找到」各一句话，**共用一份**：两个函数（`wechat-auth` / `register-with-wechat`）
 * 都要把它写进日志与 500 的 detail。手抄两份的下场是同一个故障在两处的说法不同，
 * 而排查的人正要靠这句话决定下一步 —— 与 `syntheticEmailFor` 是同一个理由。
 */
export function describeLookupFailure(
  lookup: Exclude<AuthUserLookup, { status: 'found' }>,
): string {
  switch (lookup.status) {
    case 'absent':
      return 'no auth user matches this openid'
    case 'ambiguous':
      return `ambiguous: ${lookup.count} auth users match this openid`
    case 'truncated':
      return `user list not fully scanned (stopped at ${lookup.scanned} users)`
    case 'error':
      return `user list lookup failed: ${lookup.message}`
  }
}

/** `user_metadata` 里那个 openid；不是非空字符串就当没有。 */
function metadataOpenid(user: User): string | null {
  const raw = (user.user_metadata as Record<string, unknown> | null)?.['wechat_openid']
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * 按完整 openid 找那个「建了 auth 账号、但没绑定完 openid」的账号。
 *
 * 只读，不改任何东西（调用方拿到 id 之后自己决定写什么）。
 */
export async function findUnfinishedWechatAuthUser(
  admin: SupabaseClient,
  openid: string,
): Promise<AuthUserLookup> {
  const targetEmail = syntheticEmailFor(openid)
  const targetFolded = targetEmail.toLowerCase()

  const matches: User[] = []
  let scanned = 0

  for (let page = 1; page <= MAX_ADMIN_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: ADMIN_USERS_PER_PAGE,
    })
    if (error) return { status: 'error', message: error.message }

    const users = data?.users ?? []
    scanned += users.length

    for (const user of users) {
      if (user.email?.toLowerCase() !== targetFolded) continue
      if (metadataOpenid(user) !== openid) continue
      matches.push(user)
    }

    // 不满页 = 这是最后一页（GoTrue 按 link 头给 nextPage，而它对两位以上页码的
    // 解析只取第一个字符 —— 别依赖它；条数才是客户端自己就能算准的东西）。
    if (users.length < ADMIN_USERS_PER_PAGE) {
      if (matches.length === 0) return { status: 'absent', scanned }
      if (matches.length === 1) return { status: 'found', user: matches[0] }
      return { status: 'ambiguous', count: matches.length, scanned }
    }
  }

  return { status: 'truncated', scanned }
}

/**
 * service_role 客户端的工厂。
 *
 * ## 为什么 env 由调用方读一次传进来，而不是工厂自己读
 *
 * 每个调用点**都要先判「env 齐没齐」**、不齐就回一个「server misconfigured」
 * —— 而守卫判的值与客户端拿的值**必须是同一对**。让工厂自己去读，就等于同一件事
 * 读两遍、有两个真相：守卫过了而客户端拿到空 url，`createClient` 会当场抛。
 *
 * 所以这里的分工是：`readServiceEnv()` 读一次（缺任何一个返回 null，正好就是守卫的
 * 判据），拿到手的那一对值再交给工厂。守卫与客户端因此**结构上**不可能不一致。
 *
 * ## ⚠️ 读 env 必须在请求处理里，不能在模块顶层
 *
 * 测试是**先 import、后 `Deno.env.set`** 的（ES import 会被提升到模块体之前），
 * 模块顶层读到的是空 —— 于是建出一个 url 为空串的客户端，构造时就抛。
 * `delete-storage-file/handler.ts` 与 `_shared/auth.ts` 一直是在 handler / 函数体里
 * 读的，这里是同一个理由。别为了「少读一次」把它提到模块常量里。
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export type ServiceEnv = { url: string; key: string }

/**
 * 读 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`。**缺任何一个都返回 null**，
 * 调用方据此回「server misconfigured」。
 *
 * 返回值刻意**不是** `{ url: '', key: '' }` 那种「空壳也算成功」的形状：那会让
 * 「忘了配 secret」这件事一路走到 `createClient` 才炸，而那时错误信息说的是
 * 「supabaseUrl is required」—— 排查的人会去找代码而不是找 secret。
 */
export function readServiceEnv(): ServiceEnv | null {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  return url && key ? { url, key } : null
}

/**
 * service_role 客户端。**不带 auth 选项** —— 与既有大多数调用点一字不差。
 * 只做 PostgREST 读写与 storage 调用的那些用它就够了。
 */
export function serviceClient(env: ServiceEnv): SupabaseClient {
  return createClient(env.url, env.key)
}

/**
 * 同 `serviceClient()`，另加 admin 调用点原本就带的会话选项。
 *
 * 这几个客户端只用来调 admin API（建用户 / 改密码 / 改邮箱 / 查用户）或顺带读写 DB，
 * **从不持有用户会话**，所以显式关掉会话持久化与自动刷新 —— 选项字面量原样搬运自
 * 那几处调用点，不是为了「更好」而加上的。
 */
export function adminClient(env: ServiceEnv): SupabaseClient {
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * **以调用者的身份**读写 PostgREST 的客户端 —— RLS 会对它生效。
 *
 * `apikey` 仍是 service key（换成 publishable key 也一样能过网关，但这一个已经在 env 里、
 * 不必再引一个新变量），而 `Authorization` 用**调用者自己的 JWT**：PostgREST 是按
 * `Authorization` 里的 JWT 判角色的，于是 `auth.uid()` 是真的、策略也真的会挡。
 *
 * 为什么这样拼是可靠的：supabase-js 的 fetch 只在头里**还没有** `Authorization` 时才去填
 * 自己的那把钥匙 —— `@supabase/supabase-js/src/lib/fetch.ts`：
 *
 * ```ts
 * if (!headers.has('Authorization')) { ... headers.set('Authorization', `Bearer ${bearer}`) }
 * ```
 *
 * 所以这里传进去的那一个不会被 service key 顶掉（2.117.0 源码级核对；升级 supabase-js 时
 * 这一行要重新核）。`global.headers` 会被并进 `SupabaseClient.headers`，PostgREST 的每个
 * 请求都从那里取头，所以是**每个**请求都带上了它，不只是某一个。
 *
 * ⚠️ 两个用法上的坑：
 * - `authorization` 必须是请求里**原样**的那个头（含 `Bearer ` 前缀），别自己拼；
 * - 它**不是** service client：读不到 RLS 之外的东西 —— 那正是它存在的理由。凡是「必须
 *   读到调用者本来读不到的行」的场合（例如往私有桶写文件）才用 `serviceClient()`。
 */
export function userClient(env: ServiceEnv, authorization: string): SupabaseClient {
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
}

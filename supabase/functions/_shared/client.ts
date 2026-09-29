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

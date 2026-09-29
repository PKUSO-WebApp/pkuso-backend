/**
 * Edge Function 的入口鉴权。
 *
 * ## 为什么必须有它（而不是靠 config.toml 的 verify_jwt）
 *
 * 本仓库的 CI 用 `--no-verify-jwt` 部署（见 `.github/workflows/sync-dev.yml` /
 * `deploy-prod.yml`），所以 `supabase/config.toml` 里那些 `verify_jwt = true`
 * **一行都不生效** —— 2026-09-29 实测：prod 上 12 个函数实际全是 `false`。
 *
 * **网关不验签，函数就必须自己验。**
 *
 * 同一天实测出三个函数体内**一行鉴权都没有**：`ocr-analyze` / `llm-analyze` /
 * `segment-parts`。于是持有公开 publishable key 的任何人可以直接调它们 ——
 * 烧的是 `DEEPSEEK_API_KEY` 与 `OCR_SPACE_API_KEY` 的额度。
 * （同批的 `send-verification-code` 更严重：它当时只做 base64 解码、不验签名，
 *  伪造 payload 就能以任意 user 发信；已在 #63 修掉。）
 *
 * ## 别退回「信任网关」的写法
 *
 * `auth.getUser(token)` 会**真的去 auth 服务校验签名与有效期**。手写 base64 解码
 * payload 是同一个 bug 的另一副面孔 —— 它与网关设置耦合，而那个设置不在本仓库
 * 的可控范围内。
 *
 * ## 用法
 *
 * ```ts
 * import { requireUser } from "../_shared/auth.ts";
 *
 * export async function handler(req: Request): Promise<Response> {
 *   if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
 *
 *   const auth = await requireUser(req, corsHeaders);
 *   if (!auth.ok) return auth.response;   // 401 / 500，已带 CORS 头
 *   // 之后可以用 auth.userId
 * }
 * ```
 *
 * ## 为什么返回联合类型而不是抛异常
 *
 * 调用方要的是「直接 return 一个 Response」。抛异常会逼每个 handler 写 try/catch，
 * 而本仓库的 handler 风格是早退（`if (...) return ...`）—— 顺着它来，少一层嵌套。
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

export type AuthOk = { ok: true; userId: string; email: string | null }
export type AuthFail = { ok: false; response: Response }

/**
 * 校验请求携带的 JWT。**没通过时返回的 Response 已经带好 CORS 头**，
 * 调用方直接 `return auth.response` 即可。
 *
 * 401（缺 header / token 无效）与 500（本函数自己 env 没配好）分开 —— 前者是调用方的问题，
 * 后者是我们的问题，混在一起会让排查时找错方向。
 */
export async function requireUser(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<AuthOk | AuthFail> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return { ok: false, response: json({ error: 'missing authorization header' }, 401) }
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    return { ok: false, response: json({ error: 'server misconfigured' }, 500) }
  }

  const supabase = createClient(url, key)
  const token = authHeader.replace('Bearer ', '')
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)

  // ⚠️ 判据必须是 **`user?.id`**，不能只判 `!user`：`getUser` 在「HTTP 200 但响应体缺
  // user 字段」时返回的是 `{}` —— **truthy**，于是「有没有 user」这一问会被骗过去，
  // 放行一个没有 id 的调用者（`auth.userId` 会是 undefined）。
  // 这是 `_shared/auth.test.ts` 里那条用例逼出来的，不是假想。
  if (error || !user?.id) {
    return { ok: false, response: json({ error: 'invalid token' }, 401) }
  }

  return { ok: true, userId: user.id, email: user.email ?? null }
}

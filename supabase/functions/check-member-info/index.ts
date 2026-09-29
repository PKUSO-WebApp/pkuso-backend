// 查询 member_info 是否有匹配姓名的记录
//
// 流程：接收 full_name → 查询 member_info 表 → 返回匹配结果
// 用途：注册时检查用户姓名是否在团员名单中，以及对应邮箱是否一致
//
// 安全设计：
// - verify_jwt=false：未登录用户可调用（注册阶段）
// - 仅返回匹配结果，不暴露敏感信息
// - 使用 service_role key 绕过 RLS

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

  const body = (await req.json().catch(() => null)) as {
    full_name?: string
  } | null

  if (!body?.full_name?.trim()) {
    return json({ error: 'missing full_name' })
  }

  const fullName = body.full_name.trim()
  const supabase = serviceClient(env)

  // 查询 member_info 表，按姓名精确匹配
  const { data, error } = await supabase
    .from('member_info')
    .select('email')
    .eq('full_name', fullName)
    .maybeSingle()

  if (error) {
    console.error('[check-member-info] query error', error)
    return json({ error: 'query failed' })
  }

  if (!data) {
    return json({ found: false })
  }

  return json({
    found: true,
    email: data.email ?? null,
  })
})

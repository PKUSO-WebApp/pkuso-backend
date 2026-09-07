// 查询 member_info 是否有匹配姓名的记录
//
// 流程：接收 full_name → 查询 member_info 表 → 返回匹配结果
// 用途：注册时检查用户姓名是否在团员名单中，以及对应邮箱是否一致
//
// 安全设计：
// - verify_jwt=false：未登录用户可调用（注册阶段）
// - 仅返回匹配结果，不暴露敏感信息
// - 使用 service_role key 绕过 RLS

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const ok = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }
  if (req.method !== 'POST') return ok({ error: 'method not allowed' })
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return ok({ error: 'server misconfigured' })
  }

  const body = (await req.json().catch(() => null)) as {
    full_name?: string
  } | null

  if (!body?.full_name?.trim()) {
    return ok({ error: 'missing full_name' })
  }

  const fullName = body.full_name.trim()
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 查询 member_info 表，按姓名精确匹配
  const { data, error } = await supabase
    .from('member_info')
    .select('email')
    .eq('full_name', fullName)
    .maybeSingle()

  if (error) {
    console.error('[check-member-info] query error', error)
    return ok({ error: 'query failed' })
  }

  if (!data) {
    return ok({ found: false })
  }

  return ok({
    found: true,
    email: data.email ?? null,
  })
})

// 删除 Supabase Storage 中的文件
// 由数据库触发器调用，用于级联删除关联的图片/附件
//
// 输入：{ bucket: string, paths: string[] }
// 输出：{ success: boolean, deleted: number, errors?: string[] }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const { bucket, paths } = await req.json()

    if (!bucket || !Array.isArray(paths) || paths.length === 0) {
      return new Response(
        JSON.stringify({ error: 'missing bucket or paths' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 从环境变量获取配置
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'server misconfigured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 批量删除文件
    const errors: string[] = []
    let deletedCount = 0

    for (const path of paths) {
      try {
        const response = await fetch(
          `${supabaseUrl}/storage/v1/object/${bucket}/${path}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${serviceRoleKey}`,
              'apikey': serviceRoleKey,
            },
          }
        )

        if (response.ok) {
          deletedCount++
        } else {
          const errorText = await response.text()
          errors.push(`Failed to delete ${path}: ${response.status} ${errorText}`)
        }
      } catch (e) {
        errors.push(`Error deleting ${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return new Response(
      JSON.stringify({
        success: errors.length === 0,
        deleted: deletedCount,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

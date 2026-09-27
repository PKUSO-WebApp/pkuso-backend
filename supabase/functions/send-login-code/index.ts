// 发送登录验证码 Edge Function
//
// 流程：接收 email → 检查邮箱是否已注册 → 生成 6 位验证码 → 存 DB → SMTP 发邮件
// 用途：登录页「邮箱+验证码」登录方式，未登录用户可调用
//
// 安全设计：
// - verify_jwt=false：面向未登录用户
// - IP 级 60s 冷却（内存 Map，实例重启后重置——可接受的安全折中）
// - 统一响应：无论用户是否存在，返回相同结构（防枚举）
// - 旧码杀死：同 purpose 同邮箱只保留最新活跃验证码
// - 邮箱格式校验

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CORS_ALLOW_HEADERS, createLogger } from '../_shared/diag.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? ''
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '465')
const SMTP_USER = Deno.env.get('SMTP_USER') ?? ''
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? ''
const SMTP_FROM_NAME = Deno.env.get('SMTP_FROM_NAME') ?? 'PKUSO'

const CODE_LENGTH = 6
const CODE_EXPIRY_MINUTES = 5
const IP_COOLDOWN_MS = 60_000

const ok = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

// --- IP-based cooldown (in-memory, per instance) ---
const ipLastRequest = new Map<string, number>()

function checkIpCooldown(ip: string): boolean {
  const now = Date.now()
  const last = ipLastRequest.get(ip)
  if (last && now - last < IP_COOLDOWN_MS) return false
  ipLastRequest.set(ip, now)
  return true
}

// --- helpers (shared with send-verification-code) ---
function generateCode(): string {
  const arr = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b % 10).join('')
}

function encodeRfc2047(value: string): string {
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`
}

async function sendEmail(to: string, subject: string, htmlBody: string): Promise<void> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const conn = await Deno.connectTls({ port: SMTP_PORT, hostname: SMTP_HOST })
  const reader = conn.readable.getReader()
  const writer = conn.writable.getWriter()

  const send = async (cmd: string): Promise<string> => {
    await writer.write(encoder.encode(cmd + '\r\n'))
    const { value } = await reader.read()
    return decoder.decode(value)
  }

  await reader.read() // greeting
  await send(`EHLO ${SMTP_HOST}`)
  await send('AUTH LOGIN')
  await send(btoa(SMTP_USER))
  await send(btoa(SMTP_PASS))
  await send(`MAIL FROM:<${SMTP_USER}>`)
  await send(`RCPT TO:<${to}>`)
  await send('DATA')

  const rawEmail = [
    `From: ${encodeRfc2047(SMTP_FROM_NAME)} <${SMTP_USER}>`,
    `To: ${to}`,
    `Subject: ${encodeRfc2047(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(unescape(encodeURIComponent(htmlBody))),
    '.',
    '',
  ].join('\r\n')

  await send(rawEmail)
  await send('QUIT')

  writer.releaseLock()
  reader.releaseLock()
  await conn.close()
}

function buildLoginCodeEmailHtml(code: string): string {
  const titleZh = '登录验证码'
  const titleEn = 'Login Code'
  const bodyZh = '你正在使用验证码登录。请使用以下验证码完成操作。验证码<strong>有效期为 5 分钟</strong>。'
  const bodyEn =
    'You are signing in with a verification code. Use the code below to complete the operation. This code <strong>expires in 5 minutes</strong>.'
  const ignoreZh = '如果你没有请求此操作，请忽略本邮件，你的账号仍然安全。'
  const ignoreEn =
    "If you didn't request this, you can safely ignore this email. Your account remains secure."

  return `<div style="font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 28px 24px; color: #333333; background-color: #ffffff;">
  <h2 style="font-size: 20px; line-height: 1.5; color: #1a237e; margin: 0 0 20px; font-weight: 700;">
    ${titleZh}<br>
    <span lang="en">${titleEn}</span>
  </h2>

  <p lang="zh" style="font-size: 14px; line-height: 1.8; margin: 0 0 12px;">你好：</p>
  <p lang="zh" style="font-size: 14px; line-height: 1.8; margin: 0 0 20px;">${bodyZh}</p>

  <p lang="en" style="font-size: 14px; line-height: 1.8; margin: 0 0 12px;">Hello,</p>
  <p lang="en" style="font-size: 14px; line-height: 1.8; margin: 0 0 20px;">${bodyEn}</p>

  <p style="margin: 26px 0; text-align: center;">
    <span style="background-color: #1a56db; color: #ffffff; padding: 14px 36px; border-radius: 6px; font-size: 24px; font-weight: 700; letter-spacing: 6px; display: inline-block;">
      ${code}
    </span>
  </p>

  <p lang="zh" style="font-size: 13px; line-height: 1.7; color: #555555; margin: 0 0 6px;">${ignoreZh}</p>
  <p lang="en" style="font-size: 13px; line-height: 1.7; color: #555555; margin: 0 0 20px;">${ignoreEn}</p>

  <hr style="border: none; border-top: 1px solid #eeeeee; margin: 20px 0;">

  <p lang="zh" style="font-size: 12px; line-height: 1.7; color: #999999; margin: 0 0 4px;">本邮件由 PKUSO 管理系统自动发送，请勿直接回复。</p>
  <p lang="en" style="font-size: 12px; line-height: 1.7; color: #999999; margin: 0;">This is an automated message from PKUSO Management System. Please do not reply.</p>
</div>`
}

Deno.serve(async (req) => {
  // 结构化日志（见 _shared/diag.ts）：diag 与客户端那条失败记录对账，ms 为累计耗时。
  // ⚠️「静默」是对**响应**的要求（防枚举：成功/失败回同一结构），不是对日志的要求——
  // 下面几条静默分支恰恰只能靠日志分辨，否则「没收到验证码」永远查不出是冷却、是没这
  // 个用户、还是 SMTP 挂了。
  const { log } = createLogger('send-login-code', req)
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
      },
    })
  }
  if (req.method !== 'POST') {
    log('fail', { step: 'method', status: 405, error: 'method not allowed' })
    return ok({ error: 'method not allowed' })
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    log('fail', { step: 'config', status: 500, error: 'server misconfigured' })
    return ok({ error: 'server misconfigured' })
  }

  // IP cooldown
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!checkIpCooldown(clientIp)) {
    // 60s 内重复点「获取验证码」会走到这：**响应是 success，邮件却不发**，
    // 客户端于是提示「已发送」而用户永远收不到——这类「假成功」只能靠这行日志认出。
    // 不记 IP：diag 已经能把这次请求和客户端对上，IP 只会往日志里塞个人信息。
    log('fail', { step: 'cooldown', status: 200, error: 'ip cooldown' })
    return ok({ success: true }) // 静默拒绝，防枚举
  }

  const body = (await req.json().catch(() => null)) as { email?: string } | null
  const email = body?.email?.trim().toLowerCase()

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    log('fail', { step: 'parse_body', status: 400, error: 'invalid email format' })
    return ok({ error: 'invalid email format' })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 查找邮箱对应的 user_id（通过 profiles 表）
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (profileError) {
    log('fail', { step: 'profile_lookup', status: 500, error: 'profile lookup failed', detail: profileError.message })
    return ok({ success: true }) // 静默，不暴露查询错误
  }

  // 用户不存在时返回 user_not_found（前端引导注册）
  // 注意：这会暴露用户是否存在，但登录场景下可接受（用户已输入邮箱）
  if (!profile) {
    log('ok', { step: 'lookup', result: 'user_not_found' })
    return ok({ error: 'user_not_found' })
  }

  const userId = profile.id

  // 杀死该用户 login purpose 的所有 alive 码
  await supabase
    .from('verification_codes')
    .update({ used: true })
    .eq('user_id', userId)
    .eq('purpose', 'login')
    .eq('used', false)

  // 生成 6 位验证码
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString()

  const { error: insertError } = await supabase.from('verification_codes').insert({
    user_id: userId,
    code,
    purpose: 'login',
    target_email: email,
    expires_at: expiresAt,
  })

  if (insertError) {
    log('fail', { step: 'insert_code', status: 500, error: 'insert failed', detail: insertError.message })
    return ok({ success: true })
  }

  // 发送邮件
  const subject = `【PKUSO】你的登录验证码 / Your Login Code`
  const htmlBody = buildLoginCodeEmailHtml(code)

  try {
    await sendEmail(email, subject, htmlBody)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('fail', { step: 'smtp', status: 502, error: 'failed to send email', detail: msg })
    return ok({ error: 'failed to send email' })
  }

  log('ok', { step: 'sent' })
  return ok({ success: true })
})

/**
 * 排练邮件通知（mp 团长专用）。
 *
 * web 的 `/api/notify` 是 Next.js API + Nodemailer/Resend；mp 不能复用那条
 * service_role + admin 鉴权链路（web 目前不改）。本函数是 mp 的发信入口：
 *   · 自己验 JWT（CI 用 --no-verify-jwt 部署，网关不验签）；
 *   · 只允许 admin 或 has_capability('rehearsal') 的团长；
 *   · 模板仍读 app_settings（与 web 共用同一份模板/签名）；
 *   · 收件人仍按「在团 + 分排声部」过滤。
 *
 * 邮件发送发生在排练 RPC 成功之后；失败不回滚排练，调用方把「已保存但邮件失败」
 * 呈现给用户（与 web 现有行为一致）。
 */

import { readServiceEnv, serviceClient } from '../_shared/client.ts'
import { requireUser } from '../_shared/auth.ts'
import { CORS_HEADERS, json } from '../_shared/http.ts'

export type RehearsalType = 'full' | 'section'

export type RecipientRow = {
  email: string | null
  is_in_orchestra: boolean | null
  instrument: string | null
}

export type GroupMemberRow = {
  group_name: string
  member_name: string
}

const SYNTHETIC_EMAIL_SUFFIX = '@placeholder.local'

const EMAIL_TEMPLATE_FULL_SUBJECT_KEY = 'email_template_full_subject'
const EMAIL_TEMPLATE_FULL_BODY_KEY = 'email_template_full_body'
const EMAIL_TEMPLATE_SECTION_SUBJECT_KEY = 'email_template_section_subject'
const EMAIL_TEMPLATE_SECTION_BODY_KEY = 'email_template_section_body'
const EMAIL_SIGNATURE_KEY = 'email_signature'

export const DEFAULT_FULL_SUBJECT = '[排练通知] {title}'
export const DEFAULT_FULL_BODY = `<h2>排练通知</h2>
<p><strong>曲目：</strong>{title}</p>
<p><strong>时间：</strong>{dateStr}</p>
<p><strong>地点：</strong>{location}</p>
<p>请各位团员准时出席！</p>
<p style="margin-top:24px;color:#666;">——<br/>{signature}</p>`
export const DEFAULT_SECTION_SUBJECT = '[排练通知] {title}（{targetSection}）'
export const DEFAULT_SECTION_BODY = `<h2>排练通知</h2>
<p><strong>声部：</strong>{targetSection}</p>
<p><strong>曲目：</strong>{title}</p>
<p><strong>时间：</strong>{dateStr}</p>
<p><strong>地点：</strong>{location}</p>
<p>请各位团员准时出席！</p>
<p style="margin-top:24px;color:#666;">——<br/>{signature}</p>`
export const DEFAULT_EMAIL_SIGNATURE = '北京大学学生交响乐团'

const BATCH_SIZE = 20
const BATCH_DELAY_MS = 1500

export type SmtpConfig = {
  host: string
  port: number
  user: string
  pass: string
  fromName: string
  from: string
}

/** 微信注册用户的合成邮箱不投递（与 web 的 isSyntheticEmail 同一判据）。 */
export function isSyntheticEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(SYNTHETIC_EMAIL_SUFFIX)
}

export function normalizeTargetSections(
  input: unknown,
  fallbackText?: unknown,
): string[] {
  const values: string[] = Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string')
    : typeof fallbackText === 'string'
      ? fallbackText.split(/[,，、]/)
      : []
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** 把声部组名展开成具体乐器；不在组表里的名字原样保留。 */
export function expandTargetSections(
  targetSections: string[],
  groupMembers: GroupMemberRow[],
): string[] {
  const expanded = new Set(targetSections)
  const groups = new Set(targetSections)
  for (const row of groupMembers) {
    if (groups.has(row.group_name)) expanded.add(row.member_name)
  }
  return [...expanded]
}

export function filterRecipients(
  rows: RecipientRow[],
  type: RehearsalType,
  expandedSections: string[],
): string[] {
  const sectionSet = new Set(expandedSections)
  return rows
    .filter((row): row is RecipientRow & { email: string } => !!row.email)
    .filter((row) => !isSyntheticEmail(row.email))
    .filter((row) => row.is_in_orchestra === true)
    .filter(
      (row) =>
        type === 'full' ||
        (!!row.instrument && sectionSet.has(row.instrument)),
    )
    .map((row) => row.email)
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), escapeHtml(value))
  }
  return result
}

export function defaultTemplates(type: RehearsalType): { subject: string; body: string } {
  return type === 'full'
    ? { subject: DEFAULT_FULL_SUBJECT, body: DEFAULT_FULL_BODY }
    : { subject: DEFAULT_SECTION_SUBJECT, body: DEFAULT_SECTION_BODY }
}

export function readSmtpConfig(): SmtpConfig | null {
  const host = Deno.env.get('SMTP_HOST') ?? ''
  const port = Number(Deno.env.get('SMTP_PORT') ?? '465')
  const user = Deno.env.get('SMTP_USER') ?? ''
  const pass = Deno.env.get('SMTP_PASS') ?? ''
  if (!host || !user || !pass) return null
  return {
    host,
    port,
    user,
    pass,
    fromName: Deno.env.get('SMTP_FROM_NAME') ?? 'PKUSO',
    from: Deno.env.get('SMTP_FROM') || user,
  }
}

function encodeRfc2047(value: string): string {
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`
}

function base64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)))
}

async function sendMailBatch(
  recipients: string[],
  subject: string,
  html: string,
  config: SmtpConfig,
): Promise<void> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const conn = await Deno.connectTls({ hostname: config.host, port: config.port })
  const reader = conn.readable.getReader()
  const writer = conn.writable.getWriter()
  let buffer = ''

  const readResponse = async (): Promise<string> => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('SMTP connection closed')
      if (value) buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\r\n')
      const first = lines.findIndex((line) => /^\d{3}[ -]/.test(line))
      if (first >= 0) {
        for (let i = first; i < lines.length; i += 1) {
          // 多行响应以 `250-` 继续、`250 ` 结束；单行响应直接命中。
          if (/^\d{3} /.test(lines[i])) {
            const response = lines.slice(first, i + 1).join('\r\n')
            buffer = lines.slice(i + 1).join('\r\n')
            return response
          }
        }
      }
    }
  }
  const expect = (response: string, codes: string[], step: string) => {
    if (!codes.some((code) => response.startsWith(code))) {
      throw new Error(`SMTP ${step} failed: ${response.trim().slice(0, 160)}`)
    }
  }
  const send = async (command: string, codes: string[], step: string) => {
    await writer.write(encoder.encode(command + '\r\n'))
    const response = await readResponse()
    expect(response, codes, step)
    return response
  }

  try {
    expect(await readResponse(), ['220'], 'greeting')
    await send(`EHLO ${config.host}`, ['250'], 'EHLO')
    await send('AUTH LOGIN', ['334'], 'AUTH LOGIN')
    await send(btoa(config.user), ['334'], 'AUTH USER')
    await send(btoa(config.pass), ['235'], 'AUTH PASS')
    await send(`MAIL FROM:<${config.from}>`, ['250'], 'MAIL FROM')

    for (const recipient of recipients) {
      await send(`RCPT TO:<${recipient}>`, ['250', '251'], 'RCPT TO')
    }

    await send('DATA', ['354'], 'DATA')

    const rawEmail = [
      `From: ${encodeRfc2047(config.fromName)} <${config.from}>`,
      'To: undisclosed-recipients:;',
      `Subject: ${encodeRfc2047(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64(html),
      '.',
    ].join('\r\n')

    await writer.write(encoder.encode(rawEmail + '\r\n'))
    expect(await readResponse(), ['250'], 'message')
    await send('QUIT', ['221'], 'QUIT')
  } finally {
    writer.releaseLock()
    reader.releaseLock()
    await conn.close()
  }
}

export async function sendRehearsalEmails(
  recipients: string[],
  subject: string,
  html: string,
  config: SmtpConfig,
): Promise<number> {
  let batches = 0
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE)
    await sendMailBatch(batch, subject, html, config)
    batches += 1
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
    }
  }
  return batches
}

async function canSend(client: ReturnType<typeof serviceClient>, userId: string): Promise<boolean> {
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  if (profileError) throw new Error(profileError.message)
  if (profile?.role === 'admin') return true

  const { data: capability, error: capabilityError } = await client
    .from('president_capabilities')
    .select('capability')
    .eq('user_id', userId)
    .eq('capability', 'rehearsal')
    .maybeSingle()
  if (capabilityError) throw new Error(capabilityError.message)
  return !!capability
}

type NotifyBody = {
  title?: unknown
  dateStr?: unknown
  location?: unknown
  type?: unknown
  targetSections?: unknown
  targetSection?: unknown
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405, CORS_HEADERS)
  }

  const auth = await requireUser(req, CORS_HEADERS)
  if (!auth.ok) return auth.response

  const env = readServiceEnv()
  if (!env) return json({ error: 'server misconfigured' }, 500, CORS_HEADERS)

  const client = serviceClient(env)
  try {
    if (!(await canSend(client, auth.userId))) {
      return json({ error: 'forbidden' }, 403, CORS_HEADERS)
    }

    const body = (await req.json().catch(() => null)) as NotifyBody | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const dateStr = typeof body?.dateStr === 'string' ? body.dateStr.trim() : ''
    const location = typeof body?.location === 'string' ? body.location.trim() : ''
    const type: RehearsalType = body?.type === 'section' ? 'section' : 'full'
    const targetSections = normalizeTargetSections(body?.targetSections, body?.targetSection)
    const targetSectionText =
      typeof body?.targetSection === 'string' && body.targetSection.trim()
        ? body.targetSection.trim()
        : targetSections.join(', ')

    if (!title || !dateStr || !location) {
      return json({ error: 'title / dateStr / location are required' }, 400, CORS_HEADERS)
    }
    if (type === 'section' && targetSections.length === 0) {
      return json({ error: 'targetSections is required for section rehearsal' }, 400, CORS_HEADERS)
    }

    const { data: recipientRows, error: recipientError } = await client
      .from('profiles')
      .select('email, is_in_orchestra, instrument')
      .eq('status', 'approved')
      .eq('role', 'member')
      .not('email', 'is', null)
      .neq('email', '')
    if (recipientError) throw new Error(recipientError.message)

    let expandedSections = targetSections
    if (type === 'section') {
      const { data: groupMembers, error: groupError } = await client
        .from('section_group_members')
        .select('group_name, member_name')
        .in('group_name', targetSections)
      if (groupError) throw new Error(groupError.message)
      expandedSections = expandTargetSections(targetSections, (groupMembers ?? []) as GroupMemberRow[])
    }

    const emails = filterRecipients(
      (recipientRows ?? []) as RecipientRow[],
      type,
      expandedSections,
    )
    if (emails.length === 0) {
      return json({ error: 'no valid recipients' }, 400, CORS_HEADERS)
    }

    const templateKeys =
      type === 'full'
        ? [EMAIL_TEMPLATE_FULL_SUBJECT_KEY, EMAIL_TEMPLATE_FULL_BODY_KEY]
        : [EMAIL_TEMPLATE_SECTION_SUBJECT_KEY, EMAIL_TEMPLATE_SECTION_BODY_KEY]
    const { data: settings } = await client
      .from('app_settings')
      .select('key, value')
      .in('key', [...templateKeys, EMAIL_SIGNATURE_KEY])

    const settingMap = new Map<string, string>()
    for (const row of settings ?? []) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        settingMap.set(row.key, row.value.trim())
      }
    }
    const defaults = defaultTemplates(type)
    const subjectTemplate =
      settingMap.get(templateKeys[0]) || defaults.subject
    const bodyTemplate = settingMap.get(templateKeys[1]) || defaults.body
    const signature = settingMap.get(EMAIL_SIGNATURE_KEY) || DEFAULT_EMAIL_SIGNATURE

    const vars = {
      title,
      dateStr,
      location,
      signature,
      targetSection: targetSectionText,
    }
    const subject = renderTemplate(subjectTemplate, vars)
    const html = renderTemplate(bodyTemplate, vars)

    const smtp = readSmtpConfig()
    if (!smtp) return json({ error: 'SMTP is not configured' }, 500, CORS_HEADERS)

    const batches = await sendRehearsalEmails(emails, subject, html, smtp)
    return json({ success: true, recipients: emails.length, batches }, 200, CORS_HEADERS)
  } catch (error) {
    console.error('[notify-rehearsal]', error)
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      502,
      CORS_HEADERS,
    )
  }
}

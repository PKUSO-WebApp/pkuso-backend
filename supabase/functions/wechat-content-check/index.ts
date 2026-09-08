// 微信内容安全检测 Edge Function（社区/发帖/请假理由等 UGC 接入用）。
//
// 文本与图片走同步接口（即时返回，便于前端立即反馈）：
//   - text  : POST body { kind:'text',  content, openid?, scene? }   → /wxa/msg_sec_check
//   - image : POST body { kind:'image', imageUrl, openid?, scene? }  → /wxa/img_sec_check
//            （函数拉取图片字节后以 multipart media 字段原样转发；图片上限 1MB，超限直接拦截）
// 音视频（media_check_async）为异步、需回调接收最终结果，当前社区发帖不含音视频，故不暴露该 kind。
//
// scene 取值：1 资料 / 2 评论 / 3 论坛（社区贴用这个） / 4 社交日志。openid 选填（经典版接口无需）。
// 返回：{ result: 'pass' | 'review' | 'block', errcode, errmsg, label?, keyword? }
// 失败（微信 API 错误 / 图片超限）时返回 { ok:false, error, debug }（仍 200，便于排查）。
//
// 健壮性：
// - verify_jwt 暂设 false（与本仓库 wechat-auth 一致），便于调试；生产应改 true 并加频控。
// - WECHAT_APP_ID / WECHAT_APP_SECRET 经 supabase secrets 注入，不入库、不下发客户端。
// - access_token 服务端缓存（约 5 分钟安全余量）；微信返回 40001/40014/42001 时清缓存重试一次。
// - 图片上限 1MB：先据 content-length 预判、再据实际字节校验，超限在下载/转发前即拦截。

interface WechatCheckData {
  errcode?: number
  errmsg?: string
  suggest?: string
  label?: number
  keyword?: string
}

export type CheckResult = {
  result: 'pass' | 'review' | 'block'
  errcode: number
  errmsg: string
  label?: number
  keyword?: string
}

const TIMEOUT_MS = 9000
const MAX_IMAGE_BYTES = 1 * 1024 * 1024

// 需要刷新 access_token 重发的微信错误码（凭证失效/过期）
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001])

let cachedToken: { token: string; exp: number } | null = null
let lastDebug: Record<string, unknown> = {}

async function wxFetch(url: string, init?: RequestInit): Promise<{ status: number; raw: string }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const raw = await res.text()
    return { status: res.status, raw }
  } finally {
    clearTimeout(t)
  }
}

async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.exp > now) return cachedToken.token
  const appId = Deno.env.get('WECHAT_APP_ID') ?? ''
  const appSecret = Deno.env.get('WECHAT_APP_SECRET') ?? ''
  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${appId}&secret=${appSecret}`
  lastDebug.tokenUrl = url.replace(appSecret, '***')
  const { status, raw } = await wxFetch(url)
  lastDebug.tokenStatus = status
  lastDebug.tokenRaw = raw
  const data = JSON.parse(raw) as { access_token?: string; expires_in?: number; errmsg?: string }
  if (!data.access_token) throw new Error(`wechat token failed: ${data.errmsg ?? raw}`)
  cachedToken = {
    token: data.access_token,
    exp: now + (data.expires_in ?? 7200) * 1000 - 5 * 60 * 1000,
  }
  return cachedToken.token
}

// 微信返回 → 统一判定。仅处理 errcode 0 / 87014；其余（如 token 失效、参数缺失）视为 API 错误，返回 null。
export function classify(data: WechatCheckData): CheckResult | null {
  const errcode = data.errcode ?? -1
  if (errcode === 0) {
    if (data.suggest === 'risk') {
      return {
        result: 'block',
        errcode,
        errmsg: data.errmsg ?? 'risk',
        label: data.label,
        keyword: data.keyword,
      }
    }
    if (data.suggest === 'review') {
      return {
        result: 'review',
        errcode,
        errmsg: data.errmsg ?? 'review',
        label: data.label,
        keyword: data.keyword,
      }
    }
    return { result: 'pass', errcode, errmsg: data.errmsg ?? 'ok' }
  }
  if (errcode === 87014) {
    return { result: 'block', errcode, errmsg: data.errmsg ?? 'risky content' }
  }
  return null
}

async function checkText(
  content: string,
  openid: string,
  scene: number,
  retried = false
): Promise<CheckResult> {
  const token = await getAccessToken()
  const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${token}`
  lastDebug.textUrl = url.replace(token, '***')
  lastDebug.textBody = { content }
  const { status, raw } = await wxFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  lastDebug.textStatus = status
  lastDebug.textRaw = raw
  const data = JSON.parse(raw) as WechatCheckData
  const r = classify(data)
  if (!r) {
    if (!retried && TOKEN_ERROR_CODES.has(data.errcode ?? -1)) {
      cachedToken = null
      return checkText(content, openid, scene, true)
    }
    throw new Error(`wechat text check api error: ${JSON.stringify(data)}`)
  }
  return r
}

async function checkImage(
  imageUrl: string,
  openid: string,
  scene: number,
  retried = false
): Promise<CheckResult> {
  const token = await getAccessToken()
  const imgRes = await fetch(imageUrl)
  const lenHeader = imgRes.headers.get('content-length')
  if (lenHeader && Number(lenHeader) > MAX_IMAGE_BYTES) {
    throw new Error('图片过大，请压缩至 1MB 以内后重试')
  }
  const buf = new Uint8Array(await imgRes.arrayBuffer())
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error('图片过大，请压缩至 1MB 以内后重试')
  }
  const form = new FormData()
  form.append(
    'media',
    new Blob([buf], { type: imgRes.headers.get('content-type') || 'image/jpeg' }),
    'image.jpg'
  )
  const url = `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${token}`
  lastDebug.imageUrl = url.replace(token, '***')
  const { status, raw } = await wxFetch(url, { method: 'POST', body: form })
  lastDebug.imageStatus = status
  lastDebug.imageRaw = raw
  const data = JSON.parse(raw) as WechatCheckData
  const r = classify(data)
  if (!r) {
    if (!retried && TOKEN_ERROR_CODES.has(data.errcode ?? -1)) {
      cachedToken = null
      return checkImage(imageUrl, openid, scene, true)
    }
    throw new Error(`wechat image check api error: ${JSON.stringify(data)}`)
  }
  return r
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (!Deno.env.get('WECHAT_APP_ID') || !Deno.env.get('WECHAT_APP_SECRET')) {
    return json(500, { error: 'server misconfigured' })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json(400, { error: 'invalid json body' })
  }

  const openid = typeof body.openid === 'string' ? body.openid.trim() : ''
  const scene = typeof body.scene === 'number' ? body.scene : 3

  try {
    let r: CheckResult
    if (body.kind === 'text') {
      if (typeof body.content !== 'string' || !body.content)
        return json(400, { error: 'missing content' })
      r = await checkText(body.content, openid, scene)
    } else if (body.kind === 'image') {
      if (typeof body.imageUrl !== 'string' || !body.imageUrl)
        return json(400, { error: 'missing imageUrl' })
      r = await checkImage(body.imageUrl, openid, scene)
    } else {
      return json(400, { error: 'unknown kind (expected text|image)' })
    }
    return json(200, r)
  } catch (e) {
    // 返回 200 + debug，避免网关把 502 的 body 吞掉，便于定位
    return json(200, {
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      debug: lastDebug,
    })
  }
}

if (import.meta.main) {
  Deno.serve(handler)
}

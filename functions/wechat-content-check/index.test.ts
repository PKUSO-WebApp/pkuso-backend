import { handler, classify } from './index.ts'

Deno.env.set('WECHAT_APP_ID', 'APPID_TEST')
Deno.env.set('WECHAT_APP_SECRET', 'SECRET_TEST')

let lastFetch: { url: string; init?: RequestInit } | null = null
let msgCallCount = 0
let imgCallCount = 0

const fakeFetch = (input: any, init?: any): Promise<Response> => {
  lastFetch = { url: typeof input === 'string' ? input : input.url, init }
  const url = lastFetch.url
  if (url.includes('/cgi-bin/token')) {
    return Promise.resolve(new Response(JSON.stringify({ access_token: 'TOK', expires_in: 7200 })))
  }
  if (url.includes('/wxa/msg_sec_check')) {
    msgCallCount++
    // 第一次返回凭证失效，验证「清缓存重试一次」
    if (msgCallCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }))
      )
    }
    const b = JSON.parse(init.body as string)
    if (b.content.includes('违规')) {
      return Promise.resolve(new Response(JSON.stringify({ errcode: 87014, errmsg: 'risky' })))
    }
    if (b.content.includes('待审')) {
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', suggest: 'review', label: 20001 }))
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', suggest: 'pass' }))
    )
  }
  if (url.includes('/wxa/img_sec_check')) {
    imgCallCount++
    if (imgCallCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 42001, errmsg: 'token expired' }))
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', suggest: 'pass' }))
    )
  }
  if (url === 'https://x.test/pic.jpg') {
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
    )
  }
  if (url === 'https://x.test/big.jpg') {
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg', 'content-length': '2097152' },
      })
    )
  }
  return Promise.resolve(new Response('{}'))
}

// @ts-ignore override global fetch for the test
globalThis.fetch = fakeFetch as any

const post = (obj: Record<string, unknown>) =>
  handler(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(obj) }))

Deno.test('text: pass maps suggest=pass', async () => {
  msgCallCount = 0
  const res = await post({ kind: 'text', content: '今天晚上有排练' })
  const j = await res.json()
  if (j.result !== 'pass') throw new Error('expected pass, got ' + JSON.stringify(j))
  if (!lastFetch!.url.includes('/wxa/msg_sec_check')) throw new Error('wrong endpoint')
  const b = JSON.parse(lastFetch!.init!.body as string)
  if (b.content !== '今天晚上有排练' || b.version !== undefined) {
    throw new Error('wrong request body: ' + JSON.stringify(b))
  }
})

Deno.test('text: retries once on 40001 then passes', async () => {
  msgCallCount = 0
  const res = await post({ kind: 'text', content: 'hi' })
  const j = await res.json()
  if (j.result !== 'pass') throw new Error('expected pass after retry, got ' + JSON.stringify(j))
  if (msgCallCount !== 2) throw new Error('expected 2 calls (retry), got ' + msgCallCount)
})

Deno.test('text: block on errcode 87014', async () => {
  msgCallCount = 0
  const res = await post({ kind: 'text', content: '这是违规内容' })
  const j = await res.json()
  if (j.result !== 'block' || j.errcode !== 87014)
    throw new Error('expected block/87014, got ' + JSON.stringify(j))
})

Deno.test('text: review on suggest=review', async () => {
  msgCallCount = 0
  const res = await post({ kind: 'text', content: '这条待审一下' })
  const j = await res.json()
  if (j.result !== 'review' || j.label !== 20001)
    throw new Error('expected review, got ' + JSON.stringify(j))
})

Deno.test('image: fetches url then posts multipart (media only)', async () => {
  imgCallCount = 0
  const res = await post({ kind: 'image', imageUrl: 'https://x.test/pic.jpg' })
  const j = await res.json()
  if (j.result !== 'pass') throw new Error('expected pass, got ' + JSON.stringify(j))
  if (!lastFetch!.url.includes('/wxa/img_sec_check')) throw new Error('wrong endpoint')
  if (!(lastFetch!.init!.body instanceof FormData)) throw new Error('expected multipart FormData')
  const fd = lastFetch!.init!.body as FormData
  if (!fd.has('media')) throw new Error('multipart missing media field')
})

Deno.test('image: retries once on 42001 then passes', async () => {
  imgCallCount = 0
  const res = await post({ kind: 'image', imageUrl: 'https://x.test/pic.jpg' })
  const j = await res.json()
  if (j.result !== 'pass') throw new Error('expected pass after retry, got ' + JSON.stringify(j))
  if (imgCallCount !== 2) throw new Error('expected 2 calls, got ' + imgCallCount)
})

Deno.test('image: oversized rejected before forwarding', async () => {
  imgCallCount = 0
  const res = await post({ kind: 'image', imageUrl: 'https://x.test/big.jpg' })
  const j = await res.json()
  if (j.ok !== false || !String(j.error).includes('过大')) {
    throw new Error('expected size rejection, got ' + JSON.stringify(j))
  }
  if (imgCallCount !== 0) throw new Error('should not call wechat for oversized image')
})

Deno.test('validation: openid optional (no openid allowed)', async () => {
  msgCallCount = 0
  const res = await post({ kind: 'text', content: 'hi' })
  const j = await res.json()
  if (j.result !== 'pass') throw new Error('expected pass without openid, got ' + JSON.stringify(j))
})

Deno.test('validation: unknown kind -> 400', async () => {
  const res = await post({ kind: 'video' })
  if (res.status !== 400) throw new Error('expected 400, got ' + res.status)
})

Deno.test('classify unit: api error -> null', () => {
  const r = classify({ errcode: 40001, errmsg: 'invalid token' })
  if (r !== null) throw new Error('expected null for api error')
})

// `_shared/diag.ts` 的用例。
//
// 重点不在「能取到头」而在两条契约：
// 1. **不合法一律当没带**——这个头由客户端控制，是往日志里写字面的唯一入口；
// 2. **身份字段不可被调用方覆盖**——diag/fn/event 被 fields 里同名字段顶掉的话，
//    对账凭据就成了调用方随手能改的东西，整套关联 id 就白加了。
import { assertEquals, assertMatch, assertNotEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { CORS_ALLOW_HEADERS, createLogger, readDiagId } from './diag.ts'

const HEADER = 'x-pkuso-diag'

function reqWith(value?: string): Request {
  return new Request('https://example.test/functions/v1/x', {
    method: 'POST',
    headers: value === undefined ? {} : { [HEADER]: value },
  })
}

/** 收走 console.log：日志模块的产物就是它的输出，不接住就没得断言。 */
function captureLog(fn: () => void): string[] {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = original
  }
  return lines
}

Deno.test('readDiagId：契约内的值原样返回', () => {
  const id = 'a1b2c3d4-mf3k9x-7q2z'
  assertEquals(readDiagId(reqWith(id)), id)
})

Deno.test('readDiagId：没带这个头 → null（旧版本客户端是常态，不是错误）', () => {
  assertEquals(readDiagId(reqWith(undefined)), null)
  assertEquals(readDiagId(reqWith('')), null)
  assertEquals(readDiagId(reqWith('   ')), null)
})

Deno.test('readDiagId：带空白的头取到的是干净串（Headers 层已剥，本函数不 trim）', () => {
  assertEquals(readDiagId(reqWith('  abc-123  ')), 'abc-123')
})

Deno.test('readDiagId：非法内容一律当没带（这是往日志里写字面的入口）', () => {
  // 实测两种「想当然的注入样本」根本进不来，所以它们不该出现在这里：
  //   - 带 CR/LF 的值：构造时就抛 `Invalid header value`
  //   - 非 Latin-1 的值（如 `诊断`）：构造时就抛 `not a valid ByteString`
  // 也就是说 HTTP 层已经挡掉了「换行/编码」这两类。校验真正要挡的是下面这些
  // **ASCII 但非契约字符**的形态——它们能真的送进来。
  assertEquals(readDiagId(reqWith('{"a":1}')), null)
  assertEquals(readDiagId(reqWith('a b')), null)
  assertEquals(readDiagId(reqWith('abc;drop')), null)
  assertEquals(readDiagId(reqWith('<script>')), null)
  assertEquals(readDiagId(reqWith('a/b')), null)
})

Deno.test('readDiagId：长度上界是 64（含 64 合法，65 非法）', () => {
  const at64 = 'a'.repeat(64)
  assertEquals(readDiagId(reqWith(at64)), at64)
  assertEquals(readDiagId(reqWith('a'.repeat(65))), null)
})

Deno.test('createLogger：每条日志都带 fn / diag / event / ms，并合并 fields', () => {
  const lines = captureLog(() => {
    const { log } = createLogger('wechat-auth', reqWith('dev-1'))
    log('fail', { step: 'token_exchange', status: 502 })
  })
  assertEquals(lines.length, 1)
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>
  assertEquals(parsed.fn, 'wechat-auth')
  assertEquals(parsed.diag, 'dev-1')
  assertEquals(parsed.event, 'fail')
  assertEquals(parsed.step, 'token_exchange')
  assertEquals(parsed.status, 502)
  assertEquals(typeof parsed.ms, 'number')
})

Deno.test('createLogger：客户端没带头时 diag 仍出现且为 null（不是缺字段）', () => {
  const lines = captureLog(() => {
    createLogger('send-login-code', reqWith(undefined)).log('ok', { step: 'sent' })
  })
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>
  assertEquals('diag' in parsed, true)
  assertEquals(parsed.diag, null)
})

Deno.test('createLogger：调用方覆盖不了 fn / diag / event（否则对账凭据可被伪造）', () => {
  const lines = captureLog(() => {
    const { log } = createLogger('wechat-auth', reqWith('real-diag'))
    log('fail', { fn: 'spoofed', diag: 'spoofed', event: 'spoofed', ms: -1 })
  })
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>
  assertEquals(parsed.fn, 'wechat-auth')
  assertEquals(parsed.diag, 'real-diag')
  assertEquals(parsed.event, 'fail')
  assertNotEquals(parsed.ms, -1)
})

Deno.test('CORS 放行头里必须有 x-pkuso-diag（H5 端预检要它，小程序端不预检所以本地测不出来）', () => {
  assertMatch(CORS_ALLOW_HEADERS, /\bx-pkuso-diag\b/)
  // 别把原有的头弄丢
  for (const h of ['authorization', 'x-client-info', 'apikey', 'content-type']) {
    assertMatch(CORS_ALLOW_HEADERS, new RegExp(`\\b${h}\\b`))
  }
})

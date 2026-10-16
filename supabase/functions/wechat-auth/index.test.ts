import { assert, assertEquals, assertNotEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'

/**
 * 跑法：`deno test --allow-env --allow-read supabase/functions/wechat-auth/`
 *
 * （`--allow-read` 是给下面那次 import 用的 —— 见「入口路径为什么是拼出来的」。）
 *
 * ## 这条守卫钉的是什么
 *
 * `code2session` 成功那一步记的是**完整 openid**，字段名就叫 `openid`（不再有 `openid8`）。
 * 这不是格式偏好：这条日志存在的唯一目的是排查登录失败，而排查里绕不开「这两次失败
 * 是不是同一个人」—— 同一 appid 签发的 openid 共享一段前缀，截短之后的短串区分不了人。
 * 两个夹具的 openid **前 8 位完全相同**，就是让「退回 `slice(0, 8)`」这件事不只让断言
 * 变红，还让两条用例记出**一模一样**的值 —— 「认错人」在日志里的真实形态。
 *
 * ⚠️ 夹具的 openid 是编的。本仓公开，**真 openid 一格都不许写进来**。
 *
 * ## 怎么驱动一个「顶层就 serve()」的入口
 *
 * 入口文件顶层 `Deno.serve(...)` 会真的绑端口，所以它此前一条测试都写不了
 * （`entry-guard.test.ts` 那条静态守卫管的是另一件事：入口有没有 import `serve`）。
 * 这里的办法是**先把 `Deno.serve` 换成一个只接住 handler 的桩、再动态 import 入口**，
 * 于是可以像真请求那样把它驱动起来。
 *
 * ⚠️ `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 是入口在**模块顶层**读的，必须在 import
 * 之前 `Deno.env.set`（静态 import 会被提升到模块体之前，所以这里用 `await import()`）。
 *
 * ### 入口路径为什么是拼出来的，不写字面量
 *
 * `deno test` 会**类型检查**它跟进到的模块图，而这个入口里带着一条与本次改动无关的
 * 存量类型错误（配额记在 `scripts/type-error-quota.json`）。写字面量 import 会让
 * 本文件在 `Check` 阶段就整体失败 —— 报的还是别人那处错误，一句都读不到本文件的断言。
 * 拼成变量之后类型检查器跟进不去，import 退化成运行时加载（因此要 `--allow-read`），
 * 本文件才跑得起来。
 * ⇒ 那个配额清空之后（`scripts/check-types.mjs` 里说的待办），这里可以改回字面量。
 */

type LogLine = Record<string, unknown>

let lines: LogLine[] = []
let captured: unknown = null
/** jscode2session 桩这一次要回哪个 openid */
let servedOpenid = ''

Deno.env.set('SUPABASE_URL', 'https://test.supabase.co')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'TEST_SERVICE_KEY')
Deno.env.set('WECHAT_APP_ID', 'wx_test_appid')
Deno.env.set('WECHAT_APP_SECRET', 'test_app_secret')

const realServe = Deno.serve
Deno.serve = ((h: unknown) => {
  captured = h
  return {
    finished: Promise.resolve(),
    shutdown: () => Promise.resolve(),
    ref: () => {},
    unref: () => {},
  } as unknown as Deno.HttpServer
}) as unknown as typeof Deno.serve

const entryPath: string = new URL('./index.ts', import.meta.url).href
await import(entryPath)

Deno.serve = realServe

/** 前 8 位相同的两个身份 —— 截断实现会把它们记成同一个值。 */
const OPENID_A = 'MOCK-OPENID-AAAA-1111'
const OPENID_B = 'MOCK-OPENID-BBBB-2222'

/**
 * 发一次真请求，把这一趟的结构化日志收回。
 *
 * 收尾那条自检（一条都没收到就抛）是必需的：日志采集渠道哑掉时，本文件所有断言
 * 都会因为「取不到那一行」而以同一副面孔失败，而「没收到日志」根本不是被测逻辑的
 * 结论。0 得先被证明是数出来的，不是没记下来。
 *
 * 两个桩都**只在这一次请求期间**装上：`fetch` 是被测代码在调用点取全局的
 * （入口里是裸 `fetch(...)`，supabase-js 那边也是 `(...args) => fetch(...args)`），
 * 所以装在函数内即可，不必也不该在模块级常驻 —— 常驻会漏给同进程的其它测试文件。
 */
async function drive(openid: string): Promise<LogLine[]> {
  servedOpenid = openid
  lines = []
  const realConsoleLog = console.log
  const realFetch = globalThis.fetch
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string') {
      try {
        lines.push(JSON.parse(args[0]) as LogLine)
      } catch {
        // 不是本函数的结构化日志，忽略
      }
    }
  }
  // 上游只桩 jscode2session 这一跳：拿到 openid 就够了，后面的 profile 查询与 token
  // 交换一律 500 提前结束 —— 本文件不验那两段，跑到底只会多引一批无关的夹具。
  // ⚠️ 没有这一跳的真回包，这一趟只会留下 code2session 的 **fail** 日志。
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('jscode2session')) {
      return Promise.resolve(
        new Response(JSON.stringify({ openid: servedOpenid, session_key: 'stub' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify({ message: 'stub：本测试不往下走' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
  try {
    const handler = captured as ((req: Request) => Promise<Response>) | null
    if (!handler) throw new Error('没接住 handler —— Deno.serve 的桩没生效，这条用例什么都没验到')
    await handler(
      new Request('https://fn.test/wechat-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'STUB_CODE', mode: 'login' }),
      }),
    )
  } finally {
    console.log = realConsoleLog
    globalThis.fetch = realFetch
  }
  if (lines.length === 0) {
    throw new Error('一条日志都没收到 —— 日志采集渠道是哑的，这不是「被测逻辑没记」')
  }
  return lines
}

/** 取这一趟里 `code2session` 那条 step 日志。 */
function code2sessionStep(got: LogLine[]): LogLine {
  const line = got.find((l) => l.event === 'step' && l.step === 'code2session')
  assert(line, `没有 code2session 的 step 日志；这一趟收到的是：${JSON.stringify(got)}`)
  return line
}

Deno.test('夹具自检：两个 openid 前 8 位相同、都长于 8 位、彼此不同', () => {
  assertEquals(OPENID_A.slice(0, 8), OPENID_B.slice(0, 8))
  assert(OPENID_A.length > 8 && OPENID_B.length > 8, '短于 8 位的夹具让截断实现也照样绿')
  assertNotEquals(OPENID_A, OPENID_B)
})

Deno.test('code2session 记的是完整 openid（字段名 openid，且不留 openid8）', async (t) => {
  for (const openid of [OPENID_A, OPENID_B]) {
    await t.step(`openid=${openid}`, async () => {
      const step = code2sessionStep(await drive(openid))
      assertEquals(step.openid, openid)
      assertEquals('openid8' in step, false)
    })
  }
})

Deno.test('前 8 位相同的两个人，日志里是两个不同的值（截断实现记不出这个区别）', async () => {
  const a = code2sessionStep(await drive(OPENID_A))
  const b = code2sessionStep(await drive(OPENID_B))
  assertEquals(a.openid, OPENID_A)
  assertEquals(b.openid, OPENID_B)
  assertNotEquals(a.openid, b.openid)
})

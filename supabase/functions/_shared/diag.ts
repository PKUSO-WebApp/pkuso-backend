// 请求关联 id（请求头 `x-pkuso-diag`）：把「客户端那条失败记录」与「服务端这一条日志」
// 钉成同一次请求。
//
// 为什么需要它：排查「用户网络正常、却登录失败」时，两端各自都有记录，却无法证明它们
// 说的是同一次请求——登录失败时客户端还没有会话，cel 里的 user_id 是 null（`auth.uid()`
// 取不到），除了时间戳没有任何可对账的字段。而「请求到底有没有送到服务端」正是下一层
// 要回答的问题。同一条 diag 两边都出现 = 送到了；只在客户端出现 = 没送到，或被打回在
// 平台层（那时客户端会记到 FunctionsHttpError，但没有我们函数自己的日志）。
//
// 契约（前后端一致，客户端见 pkuso-mp `src/lib/diag.ts`）：
// - 请求头 `x-pkuso-diag`，值 `[A-Za-z0-9._-]{1,64}`，客户端生成（安装级 id + 请求级后缀）
// - 函数把它写进**每一条**结构化日志的 `diag` 字段；客户端没带时为 null（旧版本客户端）
//
// 该头由客户端完全控制，所以**校验通过才进日志**：不合法一律当「没带」处理，
// 不给日志留一个能塞任意内容（换行、超长）的口子。

const DIAG_HEADER = 'x-pkuso-diag'
const DIAG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * CORS 预检要放行的头。小程序端不走预检，H5 端会走——三个登录链路上的函数共用这一份，
 * 免得加头时漏改其中一处（漏了的表现是 H5 端请求被浏览器拦在预检，小程序端却正常）。
 */
export const CORS_ALLOW_HEADERS =
  `authorization, x-client-info, apikey, content-type, ${DIAG_HEADER}`

/**
 * 取客户端 diag id；缺失或不合契约一律返回 null。
 *
 * 这里**不** trim：头值两端的空白在 Headers 层就没了，拿到手的一定是干净串。
 * 这一条是测出来的，不是推断的——把 `.trim()` 删掉，空白那条用例照样绿（变异测试
 * 跑过；一度以为它有用，是因为当时那条用例其实是被**另一个**夹具错误弄红的）。
 *
 * CR/LF 与非 Latin-1 的值同样轮不到这里操心：前者构造时抛 `Invalid header value`
 * （实测），后者抛 `not a valid ByteString`（实测），都到不了这一行。
 */
export function readDiagId(req: Request): string | null {
  const raw = req.headers.get(DIAG_HEADER)
  return raw && DIAG_PATTERN.test(raw) ? raw : null
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void

/**
 * 结构化日志工厂：`fn` / `diag` 自动带上，`ms` 为**相对本次请求起点**的累计耗时。
 *
 * 累计而非分步：逐条读出即得整条时间线，既能看出「卡在哪一跳」，也能看出「一共卡了
 * 多久」——对端挂起时这两者都是关键判断依据（8s 超时掐断 vs 20s 才失败，指向不同的病因）。
 *
 * `fields` 展开在前、固定字段在后：调用方塞不进同名的 fn/diag/event/ms 去覆盖身份字段。
 */
export function createLogger(fn: string, req: Request): { log: Logger; diag: string | null } {
  const startedAt = Date.now()
  const diag = readDiagId(req)
  const log: Logger = (event, fields = {}) => {
    console.log(JSON.stringify({ ...fields, fn, diag, event, ms: Date.now() - startedAt }))
  }
  return { log, diag }
}

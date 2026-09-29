/**
 * 带重试的上游 JSON 请求，以及它用的退避策略。
 *
 * ## 为什么要合成一份
 *
 * 这套策略原先在 `llm-analyze` 与 `segment-parts` 里各有一份**逐字相同**的实现。
 * 它恰好是本仓最容易出错、又最没有别的东西能拦住的一段（下面每一条都是踩出来的）：
 *
 * - `fetch` 自己抛（连接重置 / DNS / TLS / 超时）也**必须**重试 —— 这一类恰恰是最该
 *   重试的瞬时故障，而它不套 try 的话异常直接冒到最外层，**一次都不重试**
 * - 429 / 5xx 可重试；401 / 404 / 400 只请求一次
 * - 2xx 但 body 解析不出来**也**值得重试（网关会在成功状态码上塞错误页），
 *   但**不能**把「body 不是 JSON」无条件算作可重试 —— 那会连带把 401/404 也重试满，
 *   所以判据里带着 `response.ok`
 * - 报文要区分「无法解析」与「空响应」，不互相诬称
 * - 实际发出去几次要如实记：不可重试的错误会立刻 break，报 `maxRetries + 1` 是假数字
 *
 * 两处一起改才能保持一致，而「一起改」正是不会发生的事 —— 所以合成一份。
 */

import { UPSTREAM_TIMEOUT_MS } from './timeout.ts'

export type Retry = {
  baseDelayMs: number
  sleep: (ms: number) => Promise<void>
}

/**
 * 退避对象。**每个调用方各持一份**（`export const retry = createRetry()`），
 * 不是一个共享单例 —— 测试会把它整个换掉（见下），共享单例会让一个函数的用例
 * 影响另一个函数的用例。
 *
 * ⚠️ `sleep` 做成可注入是**为了让断言不量墙钟**（2026-09-25 改）：过去靠桩里记
 * `Date.now()` 差值再断言递增，而 `Date.now()` 只有 1ms 分辨率、`setTimeout` 本身也有
 * 抖动，负载下会量到 `[3,2,4]` 而红。那不只是「偶尔烦人」：它会让**变异验证读错图**
 * （一红就以为变异被抓住了）。可注入之后，断言变成「**请求的**毫秒数是不是 base×2^n」
 * —— 纯值比较、不碰时钟，用例也从 7 秒变瞬时。
 *
 * ⚠️ 生产默认值必须留在**这里**：用例会先把 `baseDelayMs` 与 `sleep` 抓一份再覆盖，
 * 覆盖之后套件里就没有任何东西走默认实现了 —— 把默认值改坏（例如 `sleep` 改成 no-op）
 * 只有那几条抓默认值的断言会红。所以改这个数之前先看 `llm-analyze/index.test.ts`
 * 里「生产默认退避」那条。
 */
export function createRetry(): Retry {
  return {
    // 第 n 次重试前等 baseDelayMs × 2^n —— 默认 1s / 2s / 4s。
    baseDelayMs: 1000,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * OpenAI 风格的上游报文（DeepSeek 与之一致）：只要出现 `error` 就算失败，
 * 成功时从 `choices[0].message.content` 取正文。
 *
 * ⚠️ 判据里带着 `!data.error` 这件事**已经**是信封相关的了 —— 所以本模块不是
 * 「任意 JSON 上游」的通用重试器，别把它当成那个用。
 */
export type UpstreamJson = {
  error?: { message?: string }
  choices?: Array<{ message?: { content?: string } }>
}

export type RetryOutcome =
  | { ok: true; data: UpstreamJson; attempts: number }
  | { ok: false; error: string | null; attempts: number }

/** 最多重试几次（最多发出 `MAX_RETRIES + 1` 次请求）。 */
const MAX_RETRIES = 3

/**
 * 发一次上游请求，按结果决定要不要重试。返回的 `attempts` 是**实际发出去几次**。
 *
 * 超时信号由本函数统一带上（每次尝试都取一个新的 `AbortSignal.timeout`）—— 调用点
 * 不必、也不该自己再传一个：漏带的表现是「一条挂住的连接吃光整个预算」，
 * 而那种漏在本地测不出来。
 *
 * ⚠️ 失败时返回的 `error` 可能是 `null`（原实现里 `lastError` 就是这个类型），
 * 调用方照旧把它插进报文里即可 —— 别在这里改成「兜底一句通用文案」，
 * 那会把「到底哪一跳失败」这条信息抹掉。
 */
export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  retry: Retry,
): Promise<RetryOutcome> {
  let lastError: string | null = null
  let attempts = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts = attempt + 1

    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        // 单次上限。不设的话一条挂住的连接会吃光整个预算 ——
        // 前端的总超时一到就报错，后端还在烧额度。
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (err) {
      lastError = `上游请求失败（${describeUpstreamError(err)}）`
      if (attempt === MAX_RETRIES) break
      await retry.sleep(backoffMs(retry, attempt))
      continue
    }

    // 上游 5xx 有时返回 HTML 错误页而不是 JSON。直接 `await response.json()` 会抛，
    // 整个重试循环被跳过、外层 catch 回一个与真实原因无关的解析错。
    // 解析不出来就当上游错误处理，交给下面的重试判定。
    let data: UpstreamJson | null = null
    // 与「body 是字面 null」区分开：两者都让 data 为 null，但原因不同，
    // 报文里不能都说成「无法解析」。
    let unparsable = false
    try {
      data = (await response.json()) as UpstreamJson
    } catch {
      unparsable = true
    }

    if (response.ok && data && !data.error) {
      return { ok: true, data, attempts }
    }

    if (unparsable) {
      lastError = `上游响应无法解析（HTTP ${response.status}）`
    } else if (data === null) {
      lastError = `上游返回了空响应（HTTP ${response.status}）`
    } else {
      lastError = data.error?.message || `HTTP ${response.status}`
    }

    // 两头都要：
    // - 429 / 5xx —— 标准的瞬时故障
    // - 2xx 但 body 解析不出来 —— 网关在成功状态码上塞了错误页，也值得重试
    // 但**不能**把「body 不是 JSON」无条件算作可重试：那会连带把 401/404
    // 这类客户端错误也重试 4 次。所以用 response.ok 把它限制在成功状态码上。
    const isRetryable =
      response.status === 429 || response.status >= 500 || (response.ok && unparsable)

    if (!isRetryable || attempt === MAX_RETRIES) break

    // 指数退避：base × 2^attempt —— 默认 1s, 2s, 4s
    await retry.sleep(backoffMs(retry, attempt))
  }

  return { ok: false, error: lastError, attempts }
}

/** 第 n 次重试前等多少毫秒。单独成函数是为了让「退避按 2^n 递增」只有一个实现。 */
function backoffMs(retry: Retry, attempt: number): number {
  return retry.baseDelayMs * Math.pow(2, attempt)
}

/** fetch 抛出来的错误 —— 只取类型与消息，这类是网络层信息，给前端看没有风险。 */
function describeUpstreamError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

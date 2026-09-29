/**
 * 上游 HTTP 请求的单次超时上限。
 *
 * ## 为什么每个上游调用都必须显式给超时
 *
 * 微信的 `jscode2session` / token 交换、DeepSeek 的 completions —— 这些对端都没有默认
 * 上限。不设的话，一条挂住的连接会让函数一直占着执行槽到 wall-clock 上限，而客户端
 * 早已放弃等待：表现是「用户点了没反应，服务端却查不到任何失败记录」—— 排查的人会去
 * 翻日志，而那里什么都没有。
 *
 * 8s 的依据：微信跨境往返实测 1.7–4.4s，留足余量。这里由**各调用点自己**决定用不用
 * 这个值 —— 它是共用的**取值**，不是共用的策略。
 *
 * ⚠️ 这里**刻意不写前端那份总超时的具体值**：它是跨仓的常量，这个文件里曾经写过一次
 * 具体的数，而前端后来改了值，注释就烂在那儿了。要核就回 pkuso-web 的 `analysis.ts` 看。
 *
 * ## 本仓还有**另一套**上游超时，别合并
 *
 * `wechat-content-check` 用 `AbortController` + `setTimeout`（它要在 finally 里
 * `clearTimeout`，还要把 status 与原文一起带回来），取值也不同。那套留在原地。
 *
 * ⚠️ `register-with-wechat` 的两次上游 fetch **一个超时都没有**（现状如此）——
 * 这是既存的不一致，本模块不替它做决定。
 */
export const UPSTREAM_TIMEOUT_MS = 8000

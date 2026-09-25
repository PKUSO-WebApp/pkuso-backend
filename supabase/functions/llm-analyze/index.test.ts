import { handler, retry } from "./handler.ts";
import { MAX_EXTRA_SECTIONS, MAX_SUB_PARTS } from "./analyze.ts";

// 把退避压到 1ms：真等 1s/2s/4s 会让整套用例跑 40 秒以上，没人愿意跑就等于没有保护。
// ⚠️ 光调小基数**不够**（2026-09-25）：退避要**被观测到**才能断言，而过去是靠桩里记
// `Date.now()` 差值 —— 1ms 分辨率 + `setTimeout` 抖动，负载下会量出 `[3,2,4]`。
// 那不只是偶尔红：它会让**变异验证读错图**（一红就以为变异被抓住了）。
// 现在把 `sleep` 整个换掉：**只记录被请求的毫秒数、立刻 resolve** —— 纯值比较，不碰时钟。
// ⚠️ **覆盖之前先各抓一份生产默认值** —— 下面那条用例要在它们上面断言。
// 覆盖之后套件里就没有任何东西会走默认实现了（`sleep` 被换成桩，其余测试文件都不
// import `handler.ts`）。对抗测试实测：把默认 `sleep` 改成 no-op、或把 `baseDelayMs`
// 改成 4，**覆盖前那版套件照样 127 全绿** —— 而「退避彻底消失」意味着 4 次重试在毫秒内
// 打完，对 429 限流的上游等于全灭。
const realBase = retry.baseDelayMs;
const realSleep = retry.sleep;

retry.baseDelayMs = 1;
let delays: number[] = [];
retry.sleep = (ms: number) => {
  delays.push(ms);
  return Promise.resolve();
};

/**
 * 跑法：deno test --allow-env=DEEPSEEK_API_KEY supabase/functions/llm-analyze/
 *
 * （要 --allow-env 是因为本文件要 Deno.env.set/delete 那个 key；除此外不需要任何权限，
 *   接口是直接调 handler 的，不起服务、不出网。）
 *
 * 覆盖 handler 里的重试 / 退避 / 超时信号 / 报文 —— 这几处是最容易出错的部分，
 * 而且**没有别的东西能拦住它们**（analyze.test.ts 只覆盖纯函数）。
 * 桩掉 `globalThis.fetch` 的做法照抄 `wechat-content-check/index.test.ts`。
 */

Deno.env.set("DEEPSEEK_API_KEY", "TEST_KEY");

const OK_BODY = JSON.stringify({
  choices: [{
    message: {
      content: JSON.stringify({
        section: "打击乐",
        instrument: "木琴",
        subParts: [],
        evidence: "Allegretto",
      }),
    },
  }],
});

const SRC = "文件名: x.pdf\nOCR 文本: Allegretto";

let calls = 0;
/** 最近一次上游请求里的 prompt 正文 —— 用来断言 prompt 与代码常量没有漂移 */
let lastPrompt = "";
let respond: (call: number) => Response | Promise<Response> = () =>
  new Response(OK_BODY, { status: 200 });

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // 只有打上游的那次走桩；其余交给真 fetch（本文件里没有别的出网调用）
  if (!url.includes("api.deepseek.com")) {
    throw new Error(`意外请求: ${url}`);
  }
  calls++;
  try {
    const raw = typeof init?.body === "string" ? init.body : "";
    lastPrompt = (JSON.parse(raw) as { messages?: Array<{ content?: string }> })
      ?.messages?.[0]?.content ?? "";
  } catch {
    lastPrompt = "";
  }
  // 每次上游请求都必须带超时信号 —— 否则一条挂住的连接会吃光整个预算。
  // 这条断言放在桩里，**每条用例都会走到**：将来谁把 signal 去掉，这里会立刻红。
  // （超时时长本身没法在这里跑：4 次 × 8s 会让用例慢 30 秒以上。）
  if (!(init?.signal instanceof AbortSignal)) {
    throw new Error(`第 ${calls} 次上游请求没带 AbortSignal`);
  }
  return Promise.resolve(respond(calls));
}) as typeof fetch;

const reset = (fn: typeof respond) => {
  respond = fn;
  calls = 0;
  delays = [];
  lastPrompt = "";
};

const post = (body: unknown) =>
  handler(
    new Request("http://localhost/", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const eq = (actual: unknown, expected: unknown, msg: string) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e || typeof actual !== typeof expected) {
    throw new Error(`${msg}\n  实际: ${a} (${typeof actual})\n  期望: ${e}`);
  }
};

const html = (status: number) => new Response("<html>err</html>", { status });

Deno.test("正常路径：平铺字段 + 只请求一次", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  const res = await post({ text: SRC });
  const j = await res.json();
  eq(res.status, 200, "状态码");
  eq(calls, 1, "上游调用次数");
  // 字段必须平铺在顶层 —— 前端读 data.instrument / data.subParts
  eq([j.success, j.section, j.instrument], [true, "打击乐", "木琴"], "响应体");
  // `evidenceFound` 也必须平铺在顶层（靠 `...analysis` 展开，改成显式列字段时最容易漏它）
  eq(j.evidenceFound, true, "evidenceFound 平铺在顶层");
  eq(j.subParts, [], "没有分声部时是空数组（不再是 null）");
});

Deno.test("prompt 里的分声部号上界由 MAX_SUB_PARTS 插值，不是手抄一份", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  await post({ text: SRC });
  // 抄一份数字进 prompt 的后果：改了常量而 prompt 仍在对模型说旧值 ——
  // 模型照旧上界给号、代码按新上界弃权，两边静默拆台（同 SECTION_LIST 的理由）。
  eq(lastPrompt.includes(`个数最多 ${MAX_SUB_PARTS}`), true, "上界要与常量一致");
  // 反向自检：真拿到了 prompt 正文，不是因为两边都空而「通过」
  eq(lastPrompt.length > 200, true, "prompt 正文确实取到了");
});

Deno.test("prompt 里的额外声部上界由 MAX_EXTRA_SECTIONS 插值，不是手抄一份", async () => {
  // 与上一条同一条理由：抄一个数字进 prompt，改了常量而 prompt 仍在对模型说旧值 ——
  // 模型照旧上界给、代码按新上界截，两边静默拆台。
  reset(() => new Response(OK_BODY, { status: 200 }));
  await post({ text: SRC });
  eq(lastPrompt.includes(`个数最多 ${MAX_EXTRA_SECTIONS}`), true, "上界要与常量一致");
  // ⚠️ **两句的措辞一模一样，只有数字不同**（32 / 3），而 `"个数最多 3"` 是
  // `"个数最多 32"` 的子串 —— 所以光断那一句区分不出「插值没了」。
  // 数**出现次数**才钉得住：两句都必须在。
  const hits = lastPrompt.split("个数最多 ").length - 1;
  eq(hits, 2, "两条上界（分声部号 / 额外声部）都要在 prompt 里");
});

Deno.test("fetch 抛异常也要重试到底（网络故障是最该重试的一类）", async () => {
  reset(() => {
    throw new TypeError("connection reset by peer");
  });
  const res = await post({ text: SRC });
  const j = await res.json();
  eq(calls, 4, "重试次数");
  // **量的是「请求了多少毫秒」而不是「实际等了多久」**：base=1 → 1, 2, 4。
  // 逐位相等同时钉住三件事：退避真的发生了、按 2^n 递增、**走的是 `retry.baseDelayMs`
  // 而不是字面量**（2026-09-25 之前这条路上写死了 `1000`，把基数调小对它无效 ——
  // 那条用例因此真等了 1s/2s/4s，跑 7 秒，而注释还写着「base=1ms」）。
  eq(delays, [1, 2, 4], "退避应按 base × 2^n 递增");
  eq(/after 4 attempt/.test(j.error), true, "报文要带真实次数");
  eq(/connection reset/.test(j.error), true, "报文要含上游错误");
});
Deno.test("生产默认退避：基数 1000，且默认 sleep 真的等待", async () => {
  // ⚠️ 这条断言的是**顶层覆盖之前**抓下来的那两个默认值（本文件其余用例走的都是桩）。
  // 它是「退避的实现被改坏时有人会红」的唯一保证 —— 少了它，把默认 `sleep` 改成
  // no-op（退避消失）或把基数改成任何值，套件都全绿。
  eq(realBase, 1000, "baseDelayMs 的生产默认值");
  const t0 = performance.now();
  await realSleep(20);
  // `setTimeout` 不会**提前**触发，所以下界是可靠的；no-op 则恒为 0
  eq(performance.now() - t0 >= 15, true, "默认 sleep 必须真的等");
});
// ⚠️ 这里原先写着「生产默认值断言不了 —— Deno 会缓存模块，读不到没被改过的那一份」——
// **那句是错的**：Deno 按**测试文件**隔离模块实例，另起一个只 import `handler.ts` 的
// 文件、或在覆盖前先抓一份，都能断言（实测：改掉默认值，两种写法都会红）。
// 错的结论比没有结论更糟 —— 它会让下一个人以为这个缺口「原理上关不上」而放弃它。

Deno.test("可重试的状态码：429 / 5xx", async () => {
  for (const status of [429, 500, 503]) {
    reset(() => html(status));
    await post({ text: SRC });
    eq(calls, 4, `HTTP ${status} 应重试满`);
    // ⚠️ 退避也要断言：**这条路上退避被改坏一点都不明显** —— 把它退回字面量 `1000`
    // 或整条 `await retry.sleep(...)` 删掉，`calls` 仍是 4（全绿），只是用例从毫秒
    // 变成几十秒（三档状态码 × 7 秒，实测 42 秒）。「又贵又静默」正是本 PR 要消灭的形态。
    eq(delays, [1, 2, 4], `HTTP ${status} 的退避应按 base × 2^n 递增`);
  }
});

Deno.test("不可重试的状态码：401 / 404 / 400 只请求一次", async () => {
  for (const status of [401, 404, 400]) {
    reset(() => html(status));
    await post({ text: SRC });
    eq(calls, 1, `HTTP ${status} 不该重试`);
  }
});

Deno.test("2xx 但 body 解析不出来：值得重试（网关在成功码上塞错误页）", async () => {
  reset(() => new Response("<html>err</html>", { status: 200 }));
  const res = await post({ text: SRC });
  const j = await res.json();
  eq(calls, 4, "200 + 非 JSON 应重试满");
  eq(/无法解析/.test(j.error), true, "报文要说无法解析");
});

Deno.test("报文区分「无法解析」与「空响应」，不互相诬称", async () => {
  reset(() => new Response("null", { status: 200 }));
  let j = await (await post({ text: SRC })).json();
  eq(/空响应/.test(j.error), true, "字面 null 体 → 空响应");
  eq(/无法解析/.test(j.error), false, "不该说无法解析");

  reset(() => html(500));
  j = await (await post({ text: SRC })).json();
  eq(/无法解析/.test(j.error), true, "HTML 体 → 无法解析");
  eq(/空响应/.test(j.error), false, "不该说空响应");
});

Deno.test("上游 200 但 content 不是字符串：不抛、走弃权", async () => {
  reset(() =>
    new Response(JSON.stringify({ choices: [{ message: { content: 123 } }] }), { status: 200 })
  );
  const res = await post({ text: SRC });
  const j = await res.json();
  eq(res.status, 200, "状态码");
  eq([j.success, j.instrument, j.abstainReason], [true, "", "bad-json"], "应弃权");
});

Deno.test("请求体畸形：一律 400，且不泄漏内部错误原文", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  for (const body of ["", "null", "[]", "not json", JSON.stringify({ text: 42 }), JSON.stringify({})]) {
    const res = await post(body);
    const j = await res.json();
    eq(res.status, 400, `「${body}」状态码`);
    eq(j.success, false, `「${body}」success`);
    const leaked = /Unexpected|Cannot destructure|is not a function|intermediate value/.test(
      j.error ?? "",
    );
    eq(leaked, false, `「${body}」不该泄漏内部原文`);
  }
  eq(calls, 0, "畸形请求不该触达上游");
});

Deno.test("缺 DEEPSEEK_API_KEY 时明确报错", async () => {
  const saved = Deno.env.get("DEEPSEEK_API_KEY");
  Deno.env.delete("DEEPSEEK_API_KEY");
  try {
    reset(() => new Response(OK_BODY, { status: 200 }));
    const res = await post({ text: SRC });
    const j = await res.json();
    eq(res.status, 500, "状态码");
    eq(/DEEPSEEK_API_KEY/.test(j.error), true, "报文");
  } finally {
    if (saved) Deno.env.set("DEEPSEEK_API_KEY", saved);
  }
});

Deno.test("OPTIONS 预检返回 204 且不触达上游", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  const res = await handler(new Request("http://localhost/", { method: "OPTIONS" }));
  eq(res.status, 204, "状态码");
  eq(calls, 0, "不该触达上游");
});

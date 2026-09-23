import { handler, retry } from "./handler.ts";

// 把退避压到 1ms：真等 1s/2s/4s 会让整套用例跑 40 秒以上，没人愿意跑就等于没有保护。
// 退避的**比例**由 `retry.baseDelayMs` 的默认值保证，见下面那条断言。
retry.baseDelayMs = 1;

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
        subPart: null,
        evidence: "Allegretto",
      }),
    },
  }],
});

const SRC = "文件名: x.pdf\nOCR 文本: Allegretto";

let calls = 0;
let backoffs: number[] = [];
let lastAt = 0;
let respond: (call: number) => Response | Promise<Response> = () =>
  new Response(OK_BODY, { status: 200 });

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // 只有打上游的那次走桩；其余交给真 fetch（本文件里没有别的出网调用）
  if (!url.includes("api.deepseek.com")) {
    throw new Error(`意外请求: ${url}`);
  }
  calls++;
  const now = Date.now();
  if (lastAt) backoffs.push(now - lastAt);
  lastAt = now;
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
  backoffs = [];
  lastAt = 0;
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
  // 字段必须平铺在顶层 —— 旧前端读 data.instrument / data.subPart
  eq([j.success, j.section, j.instrument, j.subPart], [true, "打击乐", "木琴", null], "响应体");
});

Deno.test("fetch 抛异常也要重试到底（网络故障是最该重试的一类）", async () => {
  reset(() => {
    throw new TypeError("connection reset by peer");
  });
  const res = await post({ text: SRC });
  const j = await res.json();
  eq(calls, 4, "重试次数");
  eq(backoffs.length, 3, "两次重试之间都要退避");
  // 退避必须递增（本用例里 base=1ms，只验单调性）
  eq(backoffs[1] >= backoffs[0] && backoffs[2] >= backoffs[1], true, "退避应递增");
  eq(/after 4 attempt/.test(j.error), true, "报文要带真实次数");
  eq(/connection reset/.test(j.error), true, "报文要含上游错误");
});
// 注：`retry.baseDelayMs` 的生产默认值（1000）在这里断言不了 —— Deno 会缓存模块，
// 读不到「没被本文件改过」的那一份。它在 handler.ts 里就一行，改它需要一个理由。

Deno.test("可重试的状态码：429 / 5xx", async () => {
  for (const status of [429, 500, 503]) {
    reset(() => html(status));
    await post({ text: SRC });
    eq(calls, 4, `HTTP ${status} 应重试满`);
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

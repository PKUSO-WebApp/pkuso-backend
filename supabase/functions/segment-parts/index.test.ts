import { handler, retry } from "./handler.ts";

// 把退避压到 1ms：真等 1s/2s/4s 会让整套用例跑 40 秒以上，没人愿意跑就等于没有保护。
// ⚠️ 光调小基数**不够**（2026-09-25）：退避要**被观测到**才能断言，而过去是靠桩里记
// `Date.now()` 差值。本文件那条用例的注释自己就记着「实测踩过：backoffs 量到 [3,2,4]」，
// 当时的应对是把基数从 1ms 抬到 20ms —— 那是**缓解不是解决**，负载一上来照样颠倒，
// 而它一红就会让**变异验证读错图**（一红就以为变异被抓住了）。
// 现在把 `sleep` 整个换掉：**只记录被请求的毫秒数、立刻 resolve**，断言变成纯值比较。
retry.baseDelayMs = 1;
let delays: number[] = [];
retry.sleep = (ms: number) => {
  delays.push(ms);
  return Promise.resolve();
};

/**
 * 跑法：deno test --allow-env supabase/functions/segment-parts/
 *
 * 覆盖 handler 的请求体校验 / 重试 / 报文 —— 那几处最容易出错，而且**没有别的东西
 * 能拦住它们**（`segment.test.ts` 只覆盖纯函数）。桩掉 `globalThis.fetch` 的做法
 * 照抄 `llm-analyze/index.test.ts`。
 */

Deno.env.set("DEEPSEEK_API_KEY", "TEST_KEY");

const OK_BODY = JSON.stringify({
  choices: [{
    message: {
      content: JSON.stringify({
        cuts: [4],
        evidence: ["Corno II in F"],
      }),
    },
  }],
});

/** 三页：第 1 页有乐器名，第 2、3 页是续页 */
const PAGES = [
  { page: 1, text: "Corno I in F" },
  { page: 2, text: "2" },
  { page: 3, text: "3" },
  { page: 4, text: "Corno II in F" },
];

let calls = 0;
/** 最近一次上游请求里的 prompt 正文 —— 用来断言 prompt 的判据没被改掉 */
let lastPrompt = "";
let respond: (call: number) => Response | Promise<Response> = () =>
  new Response(OK_BODY, { status: 200 });

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("api.deepseek.com")) throw new Error(`意外请求: ${url}`);
  calls++;
  try {
    const raw = typeof init?.body === "string" ? init.body : "";
    lastPrompt = (JSON.parse(raw) as { messages?: Array<{ content?: string }> })
      ?.messages?.[0]?.content ?? "";
  } catch {
    lastPrompt = "";
  }
  // 每次上游请求都必须带超时信号，否则一条挂住的连接会吃光整个预算。
  // 放在桩里 = **每条用例都会走到**：将来谁把 signal 去掉，这里立刻红。
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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e || typeof actual !== typeof expected) {
    throw new Error(`${msg}\n  实际: ${a}\n  期望: ${e}`);
  }
};

Deno.test("prompt 的判据必须是「首页才有的标题块」，并排除两条错的判据", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  await post({ pages: PAGES, pageCount: 4 });
  // ⚠️ 这三条规则都是**实测逼出来的**（Egmont 11 份语料，见 PR 描述）：
  //  · 判据本身 = 「这一页出现了只在该份首页才有的版式（作品标题/作曲家名）」
  //  · 排除「出现了乐器名」—— 每页页眉都有，照它切会把 11 页的单声部切成 9 段
  //  · 排除「乐器名变了」—— 续页的乐器名会被 OCR 读错（Corno IV→Corno I）
  eq(lastPrompt.includes("只在该份首页才有的版式"), true, "要给出正确判据（标题块）");
  eq(lastPrompt.includes("每一页页眉都印着乐器名"), true, "要点明「页眉每页都有乐器名」");
  eq(lastPrompt.includes("会被 OCR 读错"), true, "要点明「乐器名变化」也不可靠的理由");
  eq(lastPrompt.includes("装饰页"), true, "要点明「只有作曲家名的装饰页」不是边界");
  // 自检：确实取到了 prompt 正文，不是因为两边都空而「通过」
  eq(lastPrompt.length > 300, true, "prompt 正文确实取到了");
});

Deno.test("正常路径：平铺字段 + 段区间 + 只请求一次", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  const res = await post({ pages: PAGES, pageCount: 4 });
  const j = await res.json();
  eq(res.status, 200, "状态码");
  eq(calls, 1, "上游调用次数");
  eq([j.success, j.source], [true, "llm"], "顶层字段");
  eq(j.cuts, [4], "切点");
  eq(j.evidence, ["Corno II in F"], "证据");
  // 段区间由后端算好（省得每个调用方各写一遍）
  eq(j.ranges, [{ from: 1, to: 3 }, { from: 4, to: 4 }], "段区间");
  eq(j.pageCount, 4, "回显页数");
});

Deno.test("模型弃权（cuts 为空）也是**成功**，不是错误", async () => {
  reset(() =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: '{"cuts":[],"evidence":[]}' } }] }),
      { status: 200 },
    )
  );
  const res = await post({ pages: PAGES, pageCount: 4 });
  const j = await res.json();
  eq(res.status, 200, "弃权要回 200");
  eq(j.cuts, [], "不切");
  // ⚠️ 不切时**必须**是「整份一段」，不能是空数组 —— 前端要拿它渲染
  eq(j.ranges, [{ from: 1, to: 4 }], "不切 = 整份一段");
});

Deno.test("模型输出不是合法 JSON：走「不切」而不是报错", async () => {
  reset(() =>
    new Response(JSON.stringify({ choices: [{ message: { content: "这不是 JSON" } }] }), {
      status: 200,
    })
  );
  const res = await post({ pages: PAGES, pageCount: 4 });
  const j = await res.json();
  eq(res.status, 200, "截断/非法 JSON 不该让整次调用失败");
  eq(j.cuts, [], "退化成不切");
});

Deno.test("请求体校验：契约违规一律 400，不做宽容修正", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  const bad: Array<[string, unknown]> = [
    ["空对象", {}],
    ["pageCount 缺失", { pages: PAGES }],
    ["pageCount 不是整数", { pages: PAGES, pageCount: 4.5 }],
    ["pageCount 为 0", { pages: PAGES, pageCount: 0 }],
    ["pages 空数组", { pages: [], pageCount: 4 }],
    ["pages 不是数组", { pages: "x", pageCount: 4 }],
    ["page 超范围", { pages: [{ page: 9, text: "x" }], pageCount: 4 }],
    ["page 为 0", { pages: [{ page: 0, text: "x" }], pageCount: 4 }],
    ["text 不是字符串", { pages: [{ page: 1, text: 42 }], pageCount: 4 }],
    // ⚠️ 这条最要紧：页号是切点的坐标系，乱序/重复会让纯函数在一个意义不明的
    // 坐标系上工作 —— 那正是「降级逻辑掩盖失败」的经典形态
    ["页号乱序", { pages: [{ page: 3, text: "x" }, { page: 1, text: "y" }], pageCount: 4 }],
    ["页号重复", { pages: [{ page: 1, text: "x" }, { page: 1, text: "y" }], pageCount: 4 }],
  ];
  for (const [name, body] of bad) {
    const res = await post(body);
    const j = await res.json();
    eq(res.status, 400, `${name} 的状态码`);
    eq(j.success, false, `${name} 的 success`);
    if (typeof j.error !== "string" || !j.error) throw new Error(`${name} 应给出 error 文案`);
  }
  eq(calls, 0, "非法请求不该触达上游");
});

Deno.test("请求体畸形（不是 JSON / 字面 null）也回 400 且不泄漏原文", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  for (const body of ["", "null", "not json", "[]"]) {
    const res = await post(body);
    const j = await res.json();
    eq(res.status, 400, `「${body}」状态码`);
    // 判据要具体到「解析器的原话」，别把「JSON」这个词本身当成泄漏 ——
    // 我们的文案里本来就有「请求体必须是 JSON 对象」，用宽泛的正则会误报（实测踩过）。
    const leaked = /SyntaxError|Unexpected|position \d|at line|token/i.test(String(j.error));
    eq(leaked, false, `「${body}」不该泄漏内部原文`);
  }
});

Deno.test("单页文本超长会被截断，不会把 prompt 撑爆", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  const huge = "x".repeat(5000);
  const res = await post({ pages: [{ page: 1, text: huge }], pageCount: 1 });
  eq(res.status, 200, "超长文本不该报错");
  eq(calls, 1, "只请求一次");
});

Deno.test("fetch 抛异常也要重试到底（网络故障是最该重试的一类）", async () => {
  // ⚠️ 本用例过去把退避基数临时调大到 20ms，好让 `Date.now()` 量出来的差值不被抖动
  // 颠倒（注释里记着实测量到过 [3,2,4]）—— 那是**缓解**。现在 `retry.sleep` 被换成了
  // 「记录毫秒数 + 立刻 resolve」，量的是**请求值**：base=1 → [1, 2, 4]，逐位相等。
  reset(() => {
    throw new TypeError("connection reset by peer");
  });
  const res = await post({ pages: PAGES, pageCount: 4 });
  const j = await res.json();
  eq(calls, 4, "重试次数");
  eq(delays, [1, 2, 4], "退避应按 base × 2^n 递增");
  eq(/after 4 attempt/.test(j.error), true, "报文要带真实次数");
  eq(/connection reset/.test(j.error), true, "报文要含上游错误");
});

Deno.test("可重试的状态码：429 / 5xx 打满四次", async () => {
  for (const status of [429, 500, 503]) {
    reset(() => new Response("upstream boom", { status }));
    const res = await post({ pages: PAGES, pageCount: 4 });
    eq(res.status, 400, `${status} 最终回 400`);
    eq(calls, 4, `${status} 应重试到 4 次`);
  }
});

Deno.test("不可重试的状态码：401 / 404 / 400 只请求一次", async () => {
  for (const status of [401, 404, 400]) {
    reset(() => new Response(JSON.stringify({ error: { message: "nope" } }), { status }));
    await post({ pages: PAGES, pageCount: 4 });
    eq(calls, 1, `${status} 不该重试`);
  }
});

Deno.test("缺 DEEPSEEK_API_KEY 时明确报错", async () => {
  Deno.env.delete("DEEPSEEK_API_KEY");
  reset(() => new Response(OK_BODY, { status: 200 }));
  const res = await post({ pages: PAGES, pageCount: 4 });
  const j = await res.json();
  eq(res.status, 500, "状态码");
  eq(/DEEPSEEK_API_KEY/.test(j.error), true, "报文要点名缺哪个");
  eq(calls, 0, "不该触达上游");
  Deno.env.set("DEEPSEEK_API_KEY", "TEST_KEY");
});

Deno.test("OPTIONS 预检返回 204 且不触达上游", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  const res = await handler(new Request("http://localhost/", { method: "OPTIONS" }));
  eq(res.status, 204, "状态码");
  eq(calls, 0, "不该触达上游");
});

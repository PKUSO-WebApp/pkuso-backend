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
  const res = await post({ ocr_text: SRC });
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
  await post({ ocr_text: SRC });
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
  await post({ ocr_text: SRC });
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
  const res = await post({ ocr_text: SRC });
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
    await post({ ocr_text: SRC });
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
    await post({ ocr_text: SRC });
    eq(calls, 1, `HTTP ${status} 不该重试`);
  }
});

Deno.test("2xx 但 body 解析不出来：值得重试（网关在成功码上塞错误页）", async () => {
  reset(() => new Response("<html>err</html>", { status: 200 }));
  const res = await post({ ocr_text: SRC });
  const j = await res.json();
  eq(calls, 4, "200 + 非 JSON 应重试满");
  eq(/无法解析/.test(j.error), true, "报文要说无法解析");
});

Deno.test("报文区分「无法解析」与「空响应」，不互相诬称", async () => {
  reset(() => new Response("null", { status: 200 }));
  let j = await (await post({ ocr_text: SRC })).json();
  eq(/空响应/.test(j.error), true, "字面 null 体 → 空响应");
  eq(/无法解析/.test(j.error), false, "不该说无法解析");

  reset(() => html(500));
  j = await (await post({ ocr_text: SRC })).json();
  eq(/无法解析/.test(j.error), true, "HTML 体 → 无法解析");
  eq(/空响应/.test(j.error), false, "不该说空响应");
});

Deno.test("上游 200 但 content 不是字符串：不抛、走弃权", async () => {
  reset(() =>
    new Response(JSON.stringify({ choices: [{ message: { content: 123 } }] }), { status: 200 })
  );
  const res = await post({ ocr_text: SRC });
  const j = await res.json();
  eq(res.status, 200, "状态码");
  eq([j.success, j.instrument, j.abstainReason], [true, "", "bad-json"], "应弃权");
});

Deno.test("旧字段名 text 已经不再被接受：400（那个别名已删除）", async () => {
  // 别名**从来没有真实调用方**（pkuso-web 一直发 `ocr_text`）。删除之后发旧名应当 400 ——
  // 这条钉住「不会有人悄悄把别名加回来」，也顺带说明为什么这个函数**只**认 ocr_text
  // （两个名字并存时，协议上说不清前端到底发了哪个）。
  const res = await post({ text: SRC });
  eq(res.status, 400, "旧字段名要 400");
});
Deno.test("file_name 类型不对：一律 400（不静默降级）", async () => {
  // ⚠️ 用例名里的「单独传」原来指的是「单独一个字段发」（与 OCR 文本分开发），
  // 但这里的请求**每条都带 `ocr_text`** —— 真正「只发 file_name」的形状在下面那条用例里。
  reset(() => new Response(OK_BODY, { status: 200 }));
  for (const bad of [42, [], {}]) {
    const res = await post({ ocr_text: SRC, file_name: bad });
    eq(res.status, 400, `file_name=${JSON.stringify(bad)} 应 400`);
  }
  // 悄悄忽略一个类型不对的 `file_name` 会让 `evidenceFromFileName` 恒为假 ——
  // 那是静默降级，正是这个仓库栽过的那类坑，所以这里不宽容。
  eq(calls, 0, "类型不对的请求不该触达上游");

  // `null` / 缺省 = **没有文件名**（段级调用就是这样），不是错误
  eq((await post({ ocr_text: SRC, file_name: null })).status, 200, "null 视为没有文件名");
  eq(calls, 1, "只有那一次触达上游");
});

Deno.test("只有文件名（没有 OCR 文本）：200，且 prompt 明说「只根据文件名」", async () => {
  // 前端有一条**既有**的降级路：一页有内容的都没读到（全空白 / 渲染失败 / OCR 读不出）
  // 时，只用文件名让模型判断。拆字段之前那种请求的 `ocr_text` 是 `"文件名: X"` 那一行
  // （非空），拆完之后是空串 —— 若照旧 400，那条路会被整条打断。
  reset(() => new Response(OK_BODY, { status: 200 }));
  const res = await post({ ocr_text: "", file_name: "PMLASIA01165-13-Horn_2.pdf" });
  eq(res.status, 200, "只有文件名应当放行");
  eq(calls, 1, "应当触达上游一次");
  eq(lastPrompt.includes("没有可用的识别文本"), true, "要明说没有识别文本");
  eq(lastPrompt.includes("只根据上面的文件名"), true, "要指路到文件名");
});

Deno.test("两样都没有：400（判据是「ocr_text 是字符串」+「至少给一样」）", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  for (
    const body of [
      { ocr_text: "" },
      { file_name: "" },
      {},
      // ⚠️ **字段整个缺失**（不是空串）也要 400：`ocr_text` 是必填的字符串，只有文件名不够。
      // 报文里那句「unless a non-empty file_name is provided」说的是**空串**那一种（见上一条用例）。
      { file_name: "x.pdf" },
    ]
  ) {
    const res = await post(body);
    eq(res.status, 400, `${JSON.stringify(body)} 应 400`);
  }
  eq(calls, 0, "不该触达上游");

  // ⚠️ **只有空白**的 `ocr_text` 仍然放行 —— 这不是本次的判据（本次只把「必须非空」
  // 松成「两样至少给一样」），而拆字段之前它也是放行的（旧判据 `!inputText` 对 "   "
  // 为假）。顺手加严会是一次**无关的行为变更**，那正是本仓反复栽过的那类坑。
  reset(() => new Response(OK_BODY, { status: 200 }));
  eq((await post({ ocr_text: "   " })).status, 200, "只有空白仍然放行（既有行为，未变）");
});

Deno.test("文件名单独成段，且标明「不代表某一页」（#300）", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  await post({ ocr_text: SRC, file_name: "…--_Piccolo,_Flute_1,_2.pdf" });
  eq(lastPrompt.includes("不代表某一页"), true, "要点明文件名不代表某一页");
  eq(lastPrompt.includes("Piccolo,_Flute_1,_2.pdf"), true, "文件名仍要发给模型");

  // 反向自检：**不给文件名时那句不该出现**（段级调用走的正是这条路，
  // 而「三段都按文件名填成同一样号」就是被那句要防的事）。
  reset(() => new Response(OK_BODY, { status: 200 }));
  await post({ ocr_text: SRC });
  eq(lastPrompt.includes("不代表某一页"), false, "没有文件名时不该出现那句");
});

Deno.test("请求体畸形：一律 400，且不泄漏内部错误原文", async () => {
  reset(() => new Response(OK_BODY, { status: 200 }));
  // ⚠️ 里面那条 `{ ocr_text: 42 }` 是这个列表里**唯一**在验「类型不对」的（其余都是
  // 「不是合法 JSON 对象」）—— 别把它换成别的字段名，否则 `typeof inputText !== 'string'`
  // 那一支就没人验了。
  for (const body of ["", "null", "[]", "not json", JSON.stringify({ ocr_text: 42 }), JSON.stringify({})]) {
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
    const res = await post({ ocr_text: SRC });
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

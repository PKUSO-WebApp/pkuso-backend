import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { handler } from "./handler.ts";
import {
  assertResponseHeaders,
  CORS_JSON_HEADERS,
  CORS_PREFLIGHT_HEADERS,
} from "../_shared/http.fixtures.ts";

/**
 * 跑法：`deno test --allow-env supabase/functions/ocr-analyze/`
 *（要 --allow-env 是因为本文件要 Deno.env.set 那个 key；除此外不需要任何权限，
 *  直接调 handler，不起服务、不出网 —— 网络那一层被下面的 fetch 桩接住了。）
 *
 * 覆盖 handler 里的**响应组装**：展开顺序、参数判据、回显、错误路径。
 * 这几处此前一行测试都没有（`shape.test.ts` 只覆盖纯函数），而它们正是最容易
 * 「静默出错」的地方 —— 一个字段被展开覆盖、一个非法参数被静默回落，都不会报错。
 * 桩掉 `globalThis.fetch` 的做法照抄 `llm-analyze/index.test.ts`。
 */

Deno.env.set("OCR_SPACE_API_KEY", "TEST_KEY");

const OK_BODY = JSON.stringify({
  ParsedResults: [
    {
      ParsedText: "Corno I in F",
      TextOverlay: {
        HasOverlay: true,
        Lines: [
          {
            LineText: "Corno I in F",
            Words: [{ WordText: "Corno", Left: 1, Top: 2, Width: 3, Height: 4 }],
          },
        ],
      },
    },
  ],
});

/** 最后一次发给上游的报文 —— 用来断言「我们到底让 OCR.space 做了什么」 */
let sent: FormData | null = null;
let upstream: () => Response = () => new Response(OK_BODY, { status: 200 });

// handler 现在**自己验签**（见 ../_shared/auth.ts）—— 网关不验签（CI 用 `--no-verify-jwt`
// 部署，config.toml 的 verify_jwt 是死配置），所以它必须自己去 auth 服务校验 token。
// 这里把那一次校验应答掉；「token 无效必须 401」由 _shared/auth.test.ts 单独覆盖。
const TEST_TOKEN = "test-token";
Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/auth/v1/user")) {
    return Promise.resolve(
      new Response(JSON.stringify({ id: "test-user", email: "test@example.com" }), {
        status: 200,
      }),
    );
  }
  if (!url.includes("api.ocr.space")) throw new Error(`意外请求: ${url}`);
  sent = init?.body as FormData;
  return Promise.resolve(upstream());
}) as typeof fetch;

const call = (body: unknown) =>
  handler(
    new Request("http://x/", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(body),
    }),
  );

const B64 = "AAAA";

Deno.test("响应体：显式字段展开在 shaped **之后**（未来加同名字段也不会被覆盖）", async () => {
  const j = await (await call({ file_base64: B64 })).json();
  assertEquals(j.success, true);
  assertEquals(j.text, "Corno I in F");
  assertEquals(j.pageCount, 1);
  assertEquals(["success", "language", "overlay", "engine"].every((k) => k in j), true);

  // ⚠️ 这一条断言的是**键序**，看着像实现细节，其实是那条不变量的唯一可测形态：
  // 「显式字段必须赢过 `...shaped`」。若哪天写成 `{success: true, ...shaped}`，
  // 而 shaped 又多出一个同名字段，就会静默覆盖 —— 而本仓三条链路都不做类型检查。
  // JSON.parse 保留键的插入顺序，所以这里量得到。
  const keys = Object.keys(j);
  const shapedKeys = ["text", "pageCount", "pages"];
  const explicitKeys = ["success", "language", "overlay", "engine"];
  const lastShaped = Math.max(...shapedKeys.map((k) => keys.indexOf(k)));
  const firstExplicit = Math.min(...explicitKeys.map((k) => keys.indexOf(k)));
  assertEquals(
    firstExplicit > lastShaped,
    true,
    `显式字段应排在 shaped 之后，实际键序: ${keys.join(",")}`,
  );
});

Deno.test("engine：非法的值静默退回 2，但**回显**让调用方看得见", async () => {
  for (const [given, want] of [
    [undefined, 2], // 不传 = 默认
    [1, 1],
    [3, 3],
    [5, 5],
    ["1", 2], // ← 最可能的误用形式：环境变量/表单/JSON 模板里数字都是字符串
    [true, 2],
    [4, 2], // 不存在的引擎号
    [0, 2],
    [99, 2],
  ] as const) {
    const body = given === undefined ? { file_base64: B64 } : { file_base64: B64, engine: given };
    const j = await (await call(body)).json();
    assertEquals(j.engine, want, `engine=${JSON.stringify(given)} 的回显`);
    assertEquals(sent?.get("OCREngine"), String(want), `engine=${JSON.stringify(given)} 实发给上游的`);
  }
});

Deno.test("overlay：判据严格 === true，且回显与实发往上的一致", async () => {
  for (const [given, want] of [
    [undefined, false],
    [true, true],
    ["true", false], // 字符串不是 true —— 不回显就无从发现
    [1, false],
    [false, false],
  ] as const) {
    const body = given === undefined ? { file_base64: B64 } : { file_base64: B64, overlay: given };
    const j = await (await call(body)).json();
    assertEquals(j.overlay, want, `overlay=${JSON.stringify(given)} 的回显`);
    assertEquals(
      sent?.get("isOverlayRequired"),
      String(want),
      `overlay=${JSON.stringify(given)} 实发给上游的`,
    );
  }
});

Deno.test("请求 overlay 时把上游的坐标一并带回（含 upstreamHasOverlay）", async () => {
  const j = await (await call({ file_base64: B64, overlay: true })).json();
  assertEquals(j.pages[0].lines.length, 1);
  assertEquals(j.pages[0].lines[0].top, 2);
  assertEquals(j.pages[0].upstreamHasOverlay, true);
});

Deno.test("缺 file_base64 → 400，且**不打上游**", async () => {
  sent = null;
  const res = await call({ mime_type: "image/jpeg" });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).success, false);
  assertEquals(sent, null, "参数就不合法时不该浪费一次配额");
});

Deno.test("请求体不是合法 JSON → 400 而不是抛异常", async () => {
  // 带 token：鉴权现在是**前置条件**，不带的话会先 401、测不到 JSON 解析这条
  const res = await handler(
    new Request("http://x/", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: "{ 这不是 JSON",
    }),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).success, false);
});

Deno.test("上游报错 → 400，并把上游的原因透出来", async () => {
  upstream = () =>
    new Response(JSON.stringify({ IsErroredOnProcessing: true, ErrorMessage: ["E502 引擎错误"] }), {
      status: 200,
    });
  const res = await call({ file_base64: B64 });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "E502 引擎错误");
  upstream = () => new Response(OK_BODY, { status: 200 });
});

Deno.test("**上游返回 0 页 → 502 失败**，绝不能报 success（实测的限流形态）", async () => {
  // 实测的报文：没有 IsErroredOnProcessing、没有 FileParseExitCode、没有 ErrorMessage，
  // 就是一个空的 ParsedResults。这种「成功但 0 页」如果报 success，调用方拿到的
  // `{success:true, text:"", pageCount:0}` 与「图确实空白」不可区分 —— 分段路径会把
  // 每一页都当成空白页，模型无从判断，界面上还会报「共 1 段」。
  for (const body of ['{"ParsedResults":[]}', '{"ParsedResults":null}', "{}"]) {
    upstream = () => new Response(body, { status: 200 });
    const res = await call({ file_base64: B64 });
    assertEquals(res.status, 502, `上游报文 ${body} 应判失败`);
    const j = await res.json();
    assertEquals(j.success, false, `上游报文 ${body} 不能报 success`);
    assertEquals(typeof j.error, "string");
  }
  upstream = () => new Response(OK_BODY, { status: 200 });
});

Deno.test("对照：上游给了 1 页但文字为空 → **仍是 success**（空图与 0 页是两件事）", async () => {
  upstream = () => new Response(JSON.stringify({ ParsedResults: [{ ParsedText: "" }] }), { status: 200 });
  const res = await call({ file_base64: B64 });
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.success, true);
  assertEquals(j.pageCount, 1);
  assertEquals(j.text, "");
  upstream = () => new Response(OK_BODY, { status: 200 });
});

Deno.test("没有 API key → 500 且给出可诊断的原因", async () => {
  const saved = Deno.env.get("OCR_SPACE_API_KEY");
  Deno.env.delete("OCR_SPACE_API_KEY");
  const res = await call({ file_base64: B64 });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "OCR_SPACE_API_KEY not configured");
  Deno.env.set("OCR_SPACE_API_KEY", saved!);
});

Deno.test("OPTIONS 预检 → 204 且带 CORS 头", async () => {
  const res = await handler(new Request("http://x/", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("mime 类型决定 filetype：图片走 JPG，其余走 PDF", async () => {
  await call({ file_base64: B64, mime_type: "image/jpeg" });
  assertEquals(sent?.get("filetype"), "JPG");
  await call({ file_base64: B64, mime_type: "application/pdf" });
  assertEquals(sent?.get("filetype"), "PDF");
  await call({ file_base64: B64 });
  assertEquals(sent?.get("filetype"), "JPG", "默认 image/png → JPG");
});

Deno.test("没有 Authorization 头 → 401（网关不验签，函数必须自己验）", async () => {
  // 回归守卫：2026-09-29 之前本函数体内**一行鉴权都没有**，而 CI 用 --no-verify-jwt
  // 部署（config.toml 的 verify_jwt 是死配置）⇒ 拿着公开 publishable key 的任何人
  // 都能调它烧 OCR.space 的额度。这条测试就是钉住那次修复。
  const res = await handler(
    new Request("http://x/", { method: "POST", body: JSON.stringify({ file_base64: "AAAA" }) }),
  );
  assertEquals(res.status, 401);
});

/**
 * 响应头（**表驱动**）：每个响应点实际带哪几个头。
 *
 * 同 llm-analyze：那里成功路径少写一个参数、响应少了全部 CORS 头，而套件全绿 ——
 * 因为当时的断言全在比状态码与报文（本文件此前对响应头只有一条 OPTIONS 的 ACAO），
 * 改动落在的维度恰好是**响应头**。期望值见 `../_shared/http.fixtures.ts`。
 */
Deno.test("响应头：每个响应点带哪些头（表驱动 —— 少一个 CORS 头这里就红）", async () => {
  const rows: Array<{
    name: string;
    expected: Record<string, string>;
    run: () => Promise<Response>;
  }> = [
    {
      name: "成功路径（浏览器要读的就是这个响应）",
      expected: CORS_JSON_HEADERS,
      run: () => {
        upstream = () => new Response(OK_BODY, { status: 200 });
        return call({ file_base64: B64 });
      },
    },
    {
      name: "502 上游 0 页",
      expected: CORS_JSON_HEADERS,
      run: () => {
        upstream = () => new Response('{"ParsedResults":[]}', { status: 200 });
        return call({ file_base64: B64 });
      },
    },
    {
      name: "400 上游报错",
      expected: CORS_JSON_HEADERS,
      run: () => {
        upstream = () =>
          new Response(JSON.stringify({ IsErroredOnProcessing: true, ErrorMessage: ["boom"] }), {
            status: 200,
          });
        return call({ file_base64: B64 });
      },
    },
    {
      name: "400 缺 file_base64",
      expected: CORS_JSON_HEADERS,
      run: () => call({}),
    },
    {
      name: "400 请求体畸形（外层 catch）",
      expected: CORS_JSON_HEADERS,
      run: () =>
        handler(
          new Request("http://x/", {
            method: "POST",
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            body: "{ 这不是 JSON",
          }),
        ),
    },
    {
      name: "401 缺 Authorization（失败响应也由本函数带 CORS 头）",
      expected: CORS_JSON_HEADERS,
      run: () =>
        handler(
          new Request("http://x/", { method: "POST", body: JSON.stringify({ file_base64: B64 }) }),
        ),
    },
    {
      name: "500 缺 OCR_SPACE_API_KEY",
      expected: CORS_JSON_HEADERS,
      run: async () => {
        const saved = Deno.env.get("OCR_SPACE_API_KEY");
        Deno.env.delete("OCR_SPACE_API_KEY");
        try {
          return await call({ file_base64: B64 });
        } finally {
          if (saved) Deno.env.set("OCR_SPACE_API_KEY", saved);
        }
      },
    },
    {
      name: "204 预检（只有 CORS 两个头，没有 content-type）",
      expected: CORS_PREFLIGHT_HEADERS,
      run: () => handler(new Request("http://x/", { method: "OPTIONS" })),
    },
  ];

  for (const row of rows) {
    assertResponseHeaders(await row.run(), row.expected, row.name);
  }
  assertEquals(rows.length >= 8, true, "响应点表被改小了？少一个入口就少一份保护");
  // 本表的最后几行没碰 upstream，但倒数第 6 行把它设成了「上游报错」—— 复原，免得
  // 以后有人在**本用例之后**追加用例时被这层隐藏状态咬到。
  upstream = () => new Response(OK_BODY, { status: 200 });
});

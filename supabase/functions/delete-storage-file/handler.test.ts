import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  BUCKET_REFERENCING_COLUMNS,
  escapeLike,
  handler,
  isSafePath,
  MAX_PATHS,
} from "./handler.ts";
import {
  assertResponseHeaders,
  CORS_JSON_HEADERS,
  CORS_PREFLIGHT_HEADERS,
} from "../_shared/http.fixtures.ts";

/**
 * 跑法：`deno test --allow-env supabase/functions/delete-storage-file/`
 *
 * ## 这个文件守的是什么
 *
 * `delete-storage-file` **不做鉴权**，而且短期内改不掉 —— 调用它的数据库触发器
 * 用 `net.http_post` 发请求、不带任何凭据（原因见 handler.ts 顶部）。既然
 * 「谁能调用」挡不住，它唯一的防线就是「调用也删不掉什么」：
 *
 *   1. bucket 白名单
 *   2. 引用检查（还有行引用它就不删）
 *
 * 所以这里每一条断言都对应**这两条防线里的某一条**，而不是泛泛的行为覆盖。
 * 删掉任何一条防线，本文件必有断言变红 —— 这是它存在的全部理由。
 *
 * 实测背景（2026-09-29，修复前）：本函数接受调用方指定的任意 `{bucket, paths}`，
 * 拿 service role key 直接删。持有 publishable key 的任何人可以删空任意 bucket
 * —— 包括 `sheet-music` 里的全部乐谱 PDF。
 */

Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "TEST_SERVICE_KEY");

/** 记录测试期间真实发出的请求，用来断言「到底有没有碰 storage」 */
let requests: Array<{ method: string; url: string }> = [];
/**
 * 引用检查的作答：**按路径**决定「查得到行吗」。
 * 判据是「URL 里解码后的 LIKE 模式包含以下任一子串」——这样才测得出混合场景
 * （一个路径被引用、另一个没有），用「按表作答」是测不出来的。
 */
let referencedMarkers: string[] = [];
/** 让引用检查报错（模拟网络/权限失败） */
let referenceCheckErrors = false;
/** 让 storage 的 DELETE 返回非 2xx */
let deleteFails = false;

const decodePattern = (url: string): string => {
  const m = url.match(/[?&]\w+=like\.([^&]*)/);
  return m ? decodeURIComponent(m[1]) : "";
};

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  requests.push({ method, url });

  // PostgREST 的引用检查
  if (url.includes("/rest/v1/")) {
    if (referenceCheckErrors) {
      return Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    }
    const pattern = decodePattern(url);
    const hit = referencedMarkers.some((marker) => pattern.includes(marker));
    return Promise.resolve(
      new Response(JSON.stringify(hit ? [{ id: "row-1" }] : []), { status: 200 }),
    );
  }

  // Storage 的删除
  if (url.includes("/storage/v1/object/")) {
    if (deleteFails) return Promise.resolve(new Response("nope", { status: 400 }));
    return Promise.resolve(new Response(null, { status: 200 }));
  }

  throw new Error(`意外请求: ${method} ${url}`);
}) as typeof fetch;

const call = (body: unknown) =>
  handler(new Request("http://x/", { method: "POST", body: JSON.stringify(body) }));

const deleteCount = () => requests.filter((r) => r.method === "DELETE").length;
const restCount = () => requests.filter((r) => r.url.includes("/rest/v1/")).length;

const reset = () => {
  requests = [];
  referencedMarkers = [];
  referenceCheckErrors = false;
  deleteFails = false;
};

// ---------------------------------------------------------------- 纯函数

Deno.test("escapeLike：`_` / `%` / `\\` 都要转义", () => {
  // 路径里真的会出现 `_`（随机 id、文件名），而它是引用检查唯一的输入。
  // 不转义时 `LIKE '%a_b%'` 会把 `aXb` 也当成命中 ⇒ 误判「还在用」⇒ 该删的删不掉（漏删）。
  assertEquals(escapeLike("a_b"), "a\\_b");
  assertEquals(escapeLike("50%.pdf"), "50\\%.pdf");
  assertEquals(escapeLike("a\\b"), "a\\\\b");
  assertEquals(escapeLike("plain/path-1.pdf"), "plain/path-1.pdf"); // 无通配符时原样
});

Deno.test("isSafePath：拒绝空串 / 绝对路径 / 上跳", () => {
  assertEquals(isSafePath("part/1.pdf"), true);
  assertEquals(isSafePath(""), false);
  assertEquals(isSafePath("/etc/passwd"), false);
  assertEquals(isSafePath("../../secret"), false);
  assertEquals(isSafePath("a/../../b"), false);
  assertEquals(isSafePath(123), false);
  assertEquals(isSafePath(null), false);
  // 单独一个 `.` 是合法文件名段，不该被 `..` 规则误伤
  assertEquals(isSafePath("a/./b"), true);
});

// ---------------------------------------------------------------- 防线 1：白名单

Deno.test("防线1：sheet-music 不在白名单里 —— 一次请求删不掉任何乐谱", async () => {
  reset();
  const res = await call({ bucket: "sheet-music", paths: ["a.pdf"] });
  const body = await res.json();

  assertEquals(res.status, 400);
  assertEquals(body.error, "bucket not managed by this function");
  // 关键断言：**没有发出任何请求**（连引用检查都不该跑）
  assertEquals(requests.length, 0);
});

Deno.test("防线1：不在白名单的 bucket 一律拒绝，且只回白名单、不回显输入", async () => {
  reset();
  const body = await (await call({ bucket: "任意别的桶", paths: ["a"] })).json();
  assertEquals(body.error, "bucket not managed by this function");
  assertEquals(body.managed, Object.keys(BUCKET_REFERENCING_COLUMNS));
  assertEquals(requests.length, 0);
});

Deno.test("防线1：白名单恰好是触发器用到的三个 bucket（多一个都是扩大攻击面）", () => {
  assertEquals(Object.keys(BUCKET_REFERENCING_COLUMNS).sort(), [
    "avatar_images",
    "community-images",
    "leave-attachments",
  ]);
});

Deno.test("防线1：路径数量有上限", async () => {
  reset();
  const paths = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `p${i}`);
  const res = await call({ bucket: "community-images", paths });
  assertEquals(res.status, 400);
  assertEquals(requests.length, 0);
});

// ---------------------------------------------------------------- 防线 2：引用检查

Deno.test("防线2：文件还被别的行引用 → 不删（这正是防线存在的意义）", async () => {
  reset();
  referencedMarkers = ["still-in-use"];
  const body = await (
    await call({ bucket: "community-images", paths: ["still-in-use.jpg"] })
  ).json();

  assertEquals(body.deleted, 0);
  assertEquals(body.skipped, 1);
  assertEquals(body.success, true); // 跳过不是错误
  assertEquals(deleteCount(), 0);
});

Deno.test("防线2：没有任何行引用 → 删（正常路径，别把防线做成一律不删）", async () => {
  reset();
  const body = await (await call({ bucket: "community-images", paths: ["orphan.jpg"] })).json();

  assertEquals(body.deleted, 1);
  assertEquals(body.skipped, 0);
  assertEquals(deleteCount(), 1);
});

Deno.test("防线2：混合场景 —— 被引用的留下、孤儿的删掉（逐路径判定）", async () => {
  reset();
  referencedMarkers = ["inuse.jpg"];
  const body = await (
    await call({
      bucket: "community-images",
      paths: ["inuse.jpg", "orphan.jpg"],
    })
  ).json();

  assertEquals(body.deleted, 1);
  assertEquals(body.skipped, 1);
  assertEquals(deleteCount(), 1);
  // 被删的必须是孤儿那个
  assertEquals(requests.filter((r) => r.method === "DELETE")[0].url.includes("orphan.jpg"), true);
});

Deno.test("防线2：引用检查**报错**时也不删（宁可漏删孤儿，也不能误删在用文件）", async () => {
  reset();
  referenceCheckErrors = true;
  const body = await (
    await call({ bucket: "community-images", paths: ["maybe-in-use.jpg"] })
  ).json();

  assertEquals(body.deleted, 0);
  assertEquals(body.skipped, 1);
  assertEquals(body.success, false); // 检查失败要报出来，不能静默
  assertEquals(deleteCount(), 0);
});

Deno.test("防线2：查的是「对应的那一列」，不是随便哪张表", async () => {
  reset();
  await call({ bucket: "avatar_images", paths: ["u1.png"] });

  assertEquals(restCount(), 1);
  const url = requests.find((r) => r.url.includes("/rest/v1/"))!.url;
  assertEquals(url.includes("/rest/v1/profiles"), true);
  assertEquals(url.includes("avatar_url"), true);
});

Deno.test("防线2：LIKE 模式确实带上了转义（路径里的 `_` 不会被当通配符）", async () => {
  reset();
  await call({ bucket: "community-images", paths: ["a_b.jpg"] });

  const url = requests.find((r) => r.url.includes("/rest/v1/"))!.url;
  const pattern = decodePattern(url);
  assertEquals(pattern, "%a\\_b.jpg%");
});

// ---------------------------------------------------------------- 拼装

Deno.test("不安全路径在引用检查**之前**就被拒，不会碰到 storage", async () => {
  reset();
  const body = await (await call({ bucket: "community-images", paths: ["../escape.jpg"] })).json();

  assertEquals(body.deleted, 0);
  assertEquals(body.success, false);
  assertEquals(deleteCount(), 0);
  assertEquals(restCount(), 0);
});

Deno.test("storage 删除失败会进 errors，success=false", async () => {
  reset();
  deleteFails = true;
  const body = await (await call({ bucket: "community-images", paths: ["x.jpg"] })).json();

  assertEquals(body.deleted, 0);
  assertEquals(body.success, false);
  assertEquals(Array.isArray(body.errors), true);
});

Deno.test("方法/报文校验", async () => {
  reset();
  assertEquals((await handler(new Request("http://x/", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("http://x/", { method: "OPTIONS" }))).status, 204);
  assertEquals((await call({ bucket: "community-images", paths: [] })).status, 400);
});

/**
 * 响应头（**表驱动**）：每个响应点实际带哪几个头。
 *
 * 同 llm-analyze（那里成功路径少写一个参数、响应少了全部 CORS 头却全绿）——
 * 期望值见 `../_shared/http.fixtures.ts`。本函数**不由浏览器调用**（触发器的
 * `net.http_post`），CORS 头在这里没有实际作用，但它同样是「原样搬运」的一部分：
 * 少一个头就是行为变更，这份表让它必须是有意为之。
 */
Deno.test("响应头：每个响应点带哪些头（表驱动 —— 少一个 CORS 头这里就红）", async () => {
  const rows: Array<{
    name: string;
    expected: Record<string, string>;
    run: () => Promise<Response>;
  }> = [
    {
      name: "成功路径",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return call({ bucket: "community-images", paths: ["orphan.jpg"] });
      },
    },
    {
      name: "400 不在白名单",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return call({ bucket: "sheet-music", paths: ["a.pdf"] });
      },
    },
    {
      name: "400 报文畸形",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return handler(new Request("http://x/", { method: "POST", body: "not json" }));
      },
    },
    {
      name: "405 非 POST",
      expected: CORS_JSON_HEADERS,
      run: () => handler(new Request("http://x/", { method: "GET" })),
    },
    {
      name: "500 env 缺",
      expected: CORS_JSON_HEADERS,
      run: async () => {
        const saved = Deno.env.get("SUPABASE_URL");
        Deno.env.delete("SUPABASE_URL");
        try {
          return await call({ bucket: "community-images", paths: ["x.jpg"] });
        } finally {
          if (saved) Deno.env.set("SUPABASE_URL", saved);
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
  assertEquals(rows.length >= 6, true, "响应点表被改小了？少一个入口就少一份保护");
});

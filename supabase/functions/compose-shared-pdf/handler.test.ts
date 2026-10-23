/**
 * `compose-shared-pdf` 的入口守则。
 *
 * 个人函数（`compose-annotated-pdf/handler.test.ts`）守的是「只取本人的批注」；
 * 本函数守的是相反的一条：**共享层不按 user 过滤**，但必须：
 *   1. 没登录/假 token 一律 401，且不碰库与 storage；
 *   2. 只按 `file_id` 过滤（**不能**出现 `user_id` 参数）——共享批注属于全团；
 *   3. 一笔都没有 ⇒ 400 `no annotations`，且**不下载原件**；
 *   4. 产物路径固定 `shared/<file_id>.pdf`，私有桶 + 1 小时签名 URL。
 */

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { handler, sharedPdfPath } from "./handler.ts";
import { OUTPUT_BUCKET, SOURCE_BUCKET } from "../_shared/pdf-annotations/export.ts";

const TEST_URL = "https://test.supabase.co";
const SERVICE_KEY = "TEST_SERVICE_KEY";
const TOKEN = "caller-jwt-token";
const ME = "aaaaaaaa-1111-4111-8111-111111111111";
const FILE_ID = "11111111-1111-4111-8111-111111111111";
const STORAGE_PATH = "22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf";

Deno.env.set("SUPABASE_URL", TEST_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

type Recorded = { method: string; url: string; headers: Headers; body: Uint8Array | null };

let requests: Recorded[] = [];
let files: Array<{ id: string; storage_path: string; file_size: number | null }> = [];
let sharedRows: Array<{ file_id: string; page: number; strokes: unknown }> = [];
let sourceBytes: Uint8Array = new Uint8Array();
let authRejects = false;
let uploadFails = false;
let signFails = false;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function eqParam(url: string, name: string): string | null {
  const raw = new URL(url).searchParams.get(name);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}

function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

function route(method: string, url: string, headers: Headers): Response {
  if (url.includes("/auth/v1/user")) {
    return authRejects
      ? jsonRes({ message: "invalid JWT" }, 401)
      : jsonRes({ id: ME, email: "me@example.com" });
  }

  // sign 必须排在两个 object 路由之前（它路径里也含 /object/）
  if (url.includes("/storage/v1/object/sign/")) {
    if (signFails) return jsonRes({ message: "sign failed" }, 500);
    const prefix = "/storage/v1/object/sign/";
    const key = url.slice(url.indexOf(prefix) + prefix.length).split("?")[0];
    return jsonRes({ signedURL: `/object/sign/${key}?token=abc123` });
  }

  if (url.includes(`/storage/v1/object/${OUTPUT_BUCKET}/`)) {
    if (uploadFails) return jsonRes({ message: "upload failed" }, 500);
    return jsonRes({ Key: `${OUTPUT_BUCKET}/whatever` });
  }

  if (url.includes(`/storage/v1/object/${SOURCE_BUCKET}/`)) {
    const total = sourceBytes.byteLength;
    const range = /bytes=0-(\d+)/.exec(headers.get("Range") ?? "");
    if (range) {
      const end = Math.min(Number(range[1]), Math.max(total - 1, 0));
      const slice = sourceBytes.slice(0, end + 1);
      return new Response(copyOf(slice), {
        status: 206,
        headers: {
          "content-range": `bytes 0-${end}/${total}`,
          "content-length": String(slice.byteLength),
        },
      });
    }
    return new Response(copyOf(sourceBytes), {
      status: 200,
      headers: { "content-length": String(total) },
    });
  }

  if (url.includes("/rest/v1/sheet_music_files")) {
    const id = eqParam(url, "id");
    return jsonRes(
      files
        .filter((f) => f.id === id)
        .map((f) => ({ id: f.id, storage_path: f.storage_path, file_size: f.file_size })),
    );
  }

  if (url.includes("/rest/v1/sheet_music_shared_annotations")) {
    const fileId = eqParam(url, "file_id");
    const limit = Number(new URL(url).searchParams.get("limit") ?? Number.MAX_SAFE_INTEGER);
    return jsonRes(
      sharedRows
        .filter((r) => r.file_id === fileId)
        .slice(0, limit)
        .map((r) => ({ page: r.page, strokes: r.strokes })),
    );
  }

  throw new Error(`意外请求: ${method} ${url}`);
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const raw = init?.body ?? null;
  const body = typeof raw === "string"
    ? new TextEncoder().encode(raw)
    : raw instanceof Uint8Array
    ? raw
    : null;
  requests.push({ method, url, headers, body });
  return Promise.resolve(route(method, url, headers));
}) as typeof fetch;

const call = (body: unknown, token: string | null = TOKEN) =>
  handler(
    new Request("http://x/", {
      method: "POST",
      ...(token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
      body: JSON.stringify(body),
    }),
  );

const restCalls = () => requests.filter((r) => r.url.includes("/rest/v1/"));
const storageCalls = () => requests.filter((r) => r.url.includes("/storage/v1/"));
const annotationCall = () =>
  restCalls().find((r) => r.url.includes("sheet_music_shared_annotations"))!;
const uploadCall = () =>
  requests.find((r) => r.url.includes(`/storage/v1/object/${OUTPUT_BUCKET}/`))!;

const reset = () => {
  requests = [];
  files = [];
  sharedRows = [];
  sourceBytes = new Uint8Array();
  authRejects = false;
  uploadFails = false;
  signFails = false;
  Deno.env.delete("ANNOTATED_PDF_MAX_BYTES");
};

let sourceCache: Uint8Array | null = null;
async function sourceFixture(): Promise<Uint8Array> {
  if (!sourceCache) {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([200, 500]);
    sourceCache = await doc.save();
  }
  return sourceCache;
}

const stroke = (points: Array<[number, number]>, color = "#ff0000") => ({
  color,
  width: 0.1,
  points,
});
const SHARED_STROKE = stroke([[0.5, 0.25], [0.5, 0.5]]);

async function seedHappy(): Promise<void> {
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 1024 }];
  sharedRows = [{ file_id: FILE_ID, page: 1, strokes: [SHARED_STROKE] }];
  sourceBytes = await sourceFixture();
}

Deno.test("sharedPdfPath：产物不带用户段（共享层不属于某个人）", () => {
  assertEquals(sharedPdfPath(FILE_ID), `shared/${FILE_ID}.pdf`);
});

Deno.test("鉴权：缺 Authorization → 401，且不碰库与 storage", async () => {
  reset();
  await seedHappy();
  const res = await call({ file_id: FILE_ID }, null);
  assertEquals(res.status, 401);
  assertEquals(requests.length, 0);
});

Deno.test("鉴权：假 token → 401（网关不验签，只能自己守）", async () => {
  reset();
  await seedHappy();
  authRejects = true;
  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 401);
  assertEquals(restCalls().length, 0);
  assertEquals(storageCalls().length, 0);
});

Deno.test("400 / 405 / 204：坏的报文与非 POST", async () => {
  reset();
  const bad = await handler(
    new Request("http://x/", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "not json",
    }),
  );
  assertEquals(bad.status, 400);

  assertEquals((await call({ file_id: "../../etc/passwd" })).status, 400);
  assertEquals((await handler(new Request("http://x/", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("http://x/", { method: "OPTIONS" }))).status, 204);
  assert(requests.every((r) => r.url.includes("/auth/v1/user")));
});

Deno.test("没有共享笔迹 ⇒ 400 no annotations，且不下载原件", async () => {
  reset();
  await seedHappy();
  sharedRows = [{ file_id: FILE_ID, page: 1, strokes: [] }];

  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "no annotations");
  assertEquals(storageCalls().length, 0);
});

Deno.test("成功：只按 file_id 读共享表（没有 user_id），产物写 shared/<file>.pdf 并签名", async () => {
  reset();
  await seedHappy();

  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 200);

  const annUrl = annotationCall().url;
  assertEquals(eqParam(annUrl, "file_id"), FILE_ID);
  assertEquals(eqParam(annUrl, "user_id"), null, "共享层不该按用户过滤");

  const upload = uploadCall();
  assertEquals(upload.url.includes(`/storage/v1/object/${OUTPUT_BUCKET}/shared/${FILE_ID}.pdf`), true);
  assertEquals(upload.headers.get("x-upsert"), "true");
  assertEquals(upload.headers.get("cache-control"), "max-age=0");
  // 读走调用者身份（两层里的第一层：RLS 真的会按 authenticated 判）
  assertEquals(
    annotationCall().headers.get("Authorization"),
    `Bearer ${TOKEN}`,
  );

  const body = await res.json();
  assertEquals(body.path, `shared/${FILE_ID}.pdf`);
  assertEquals(typeof body.url, "string");
  assert(body.url.includes("token=abc123"));
  assertEquals(body.expiresIn, 3600);
  assertEquals(body.annotatedPages, 1);
});

Deno.test("库里的 file_size 超限 ⇒ 413 source=file_size，且不下载原件", async () => {
  reset();
  await seedHappy();
  Deno.env.set("ANNOTATED_PDF_MAX_BYTES", "100");
  try {
    const res = await call({ file_id: FILE_ID });
    assertEquals(res.status, 413);
    const body = await res.json();
    assertEquals(body.source, "file_size");
    assertEquals(storageCalls().length, 0);
  } finally {
    Deno.env.delete("ANNOTATED_PDF_MAX_BYTES");
  }
});

Deno.test("全是单点笔迹（画不出来）⇒ 400 no drawable strokes，不上传", async () => {
  reset();
  await seedHappy();
  sharedRows = [{ file_id: FILE_ID, page: 1, strokes: [stroke([[0.5, 0.5]])] }];

  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "no drawable strokes");
  assertEquals(
    requests.some((r) => r.url.includes(`/storage/v1/object/${OUTPUT_BUCKET}/`)),
    false,
  );
});

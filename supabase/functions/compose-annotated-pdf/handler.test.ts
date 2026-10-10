import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { PDFArray, PDFDocument } from "npm:pdf-lib@1.17.1";
import {
  annotatedPath,
  contentRangeTotal,
  DEFAULT_MAX_PDF_BYTES,
  handler,
  hasAnyStroke,
  isFileId,
  MAX_ANNOTATION_ROWS,
  OUTPUT_BUCKET,
  pdfSizeLimit,
  SOURCE_BUCKET,
} from "./handler.ts";
import { MAX_TOTAL_STROKES } from "./compose.ts";
import {
  assertResponseHeaders,
  CORS_JSON_HEADERS,
  CORS_PREFLIGHT_HEADERS,
} from "../_shared/http.fixtures.ts";

/**
 * 跑法：`deno test --allow-env supabase/functions/compose-annotated-pdf/`
 *
 * ## 这个文件守的是什么
 *
 * `paint.test.ts` 验公式、`compose.test.ts` 验「公式有没有被写进 PDF」。这里验的是
 * **两头**：进来的（谁能调、能读到谁的数据）与出去的（产物写到哪、怎么拿回来）。
 * 每条用例都对应 handler.ts 文件头里的一条防线，删掉那条防线就必有断言变红：
 *
 * 1. **鉴权**（网关不验签，见 `_shared/auth.ts`）—— 缺 token / 假 token 一律 401，
 *    而且**根本不去碰库与 storage**；
 * 2. **只取本人的批注**：读走调用者身份（REST 头里必须是调用者的 JWT）**并且**带显式
 *    `.eq("user_id", …)`。桩里刻意同时存在**另一个用户的批注行**（在另一页上），
 *    所以少写那半句过滤时产物会多出一页别人的笔迹 —— 用例直接红；
 * 3. **四道体积判据**：桩能分别模拟「库里的 file_size 就超」「Range 下载被截断」
 *    「上游无视 Range 但长度头诚实」「连长度头都不给」四种上游，逐条验 413 的 `source`；
 * 4. **产物落地**：私有桶、路径 `<user_id>/<file_id>.pdf`、`x-upsert`、
 *    `cache-control: max-age=0`、回一个绝对签名 URL。
 *
 * 桩的作答顺序是 `auth → sign → 产物桶 → 原件桶 → /rest/v1/`，**sign 必须在最前**：
 * 签名 URL 里也含 `/object/`，顺序反了会被当成 upload / download。
 */

const TEST_URL = "https://test.supabase.co";
const SERVICE_KEY = "TEST_SERVICE_KEY";
const TOKEN = "caller-jwt-token";
const ME = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const FILE_ID = "11111111-1111-4111-8111-111111111111";
const STORAGE_PATH = "22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf";

Deno.env.set("SUPABASE_URL", TEST_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

// ------------------------------------------------------------------ 桩

type Recorded = { method: string; url: string; headers: Headers; body: Uint8Array | null };

let requests: Recorded[] = [];
/** `sheet_music_files` 的内容 */
let files: Array<{ id: string; storage_path: string; file_size: number | null }> = [];
/** `sheet_music_annotations` 的内容：**两个用户的行都在这里**（见文件头） */
let annotations: Array<{ file_id: string; user_id: string; page: number; strokes: unknown }> = [];
/** 原件的字节（显式标 `Uint8Array`：默认会推成 `Uint8Array<ArrayBuffer>`，pdf-lib 的产物赋不进来） */
let sourceBytes: Uint8Array = new Uint8Array();
/** 原件下载返回非 200 时直接回这个状态（测 404 / 502） */
let sourceStatus = 200;
/**
 * 上游对 `Range` 的态度（对应判据 3 的两种来源与判据 4）：
 * - `honest`：支持 Range，如实给 `content-range`（整份的大小就在它里面）
 * - `no-range`：无视 Range、整份返回，但 `content-length` 是诚实的
 * - `lying`：整份返回，而且**一个长度头都不给** —— 只有实际字节数能挡
 */
let upstream: "honest" | "no-range" | "lying" = "honest";
let authRejects = false;
let uploadFails = false;
let signFails = false;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 取 `xxx=eq.<值>` 的值；参数**不存在**（客户端没带这个过滤）时返回 null */
function eqParam(url: string, name: string): string | null {
  const raw = new URL(url).searchParams.get(name);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}

/** 复制成 ArrayBuffer 支撑的视图：`Response` 的 BodyInit 只收 `Uint8Array<ArrayBuffer>` */
function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** 用流作 body：既没有 content-length 也没有 content-range（判据 4 的考题） */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  const copy = copyOf(bytes);
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

function sourceResponse(headers: Headers): Response {
  if (sourceStatus !== 200) {
    return new Response(JSON.stringify({ message: "nope" }), { status: sourceStatus });
  }
  const total = sourceBytes.byteLength;
  const range = upstream === "honest" ? /bytes=0-(\d+)/.exec(headers.get("Range") ?? "") : null;
  if (range) {
    const end = Math.min(Number(range[1]), Math.max(total - 1, 0));
    const slice = sourceBytes.slice(0, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "content-range": `bytes 0-${end}/${total}`,
        // ⚠️ 这两个长度头必须**显式**给：Deno 的 `Response` 不会自己算 `content-length`
        // （真 HTTP 响应有，它是在网络层加的）。不显式给的话桩就失真了 ——
        // 判据 3 会一路退到判据 4，于是那两条分支的用例实际什么都没测到。
        "content-length": String(slice.byteLength),
      },
    });
  }
  if (upstream === "lying") return new Response(streamOf(sourceBytes), { status: 200 });
  return new Response(copyOf(sourceBytes), {
    status: 200,
    headers: { "content-length": String(total) },
  });
}

function route(method: string, url: string, headers: Headers): Response {
  // auth 服务：`requireUser` 真的来这里验签（这正是「网关不验签就得自己验」的落点）
  if (url.includes("/auth/v1/user")) {
    return authRejects
      ? jsonRes({ message: "invalid JWT" }, 401)
      : jsonRes({ id: ME, email: "me@example.com" });
  }

  // ⚠️ sign 必须排在两个 object 路由**之前**：它的路径里也含 `/object/`
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
    return sourceResponse(headers);
  }

  // PostgREST：**照它的语义过滤**。`user_id` 过滤只在客户端带了的时候才生效 ——
  // 这正是「少写 `.eq("user_id", …)` 会被用例抓到」的机制。
  if (url.includes("/rest/v1/sheet_music_files")) {
    const id = eqParam(url, "id");
    return jsonRes(
      files
        .filter((f) => f.id === id)
        .map((f) => ({ id: f.id, storage_path: f.storage_path, file_size: f.file_size })),
    );
  }
  if (url.includes("/rest/v1/sheet_music_annotations")) {
    const fileId = eqParam(url, "file_id");
    const userId = eqParam(url, "user_id");
    const limit = Number(new URL(url).searchParams.get("limit") ?? Number.MAX_SAFE_INTEGER);
    return jsonRes(
      annotations
        .filter((r) => r.file_id === fileId)
        .filter((r) => userId === null || r.user_id === userId)
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
const annotationCall = () => restCalls().find((r) => r.url.includes("sheet_music_annotations"))!;
const uploadCall = () =>
  requests.find((r) => r.url.includes(`/storage/v1/object/${OUTPUT_BUCKET}/`))!;
const signCall = () => requests.find((r) => r.url.includes("/storage/v1/object/sign/"))!;
const downloadCall = () =>
  requests.find((r) => r.url.includes(`/storage/v1/object/${SOURCE_BUCKET}/`))!;

const reset = () => {
  requests = [];
  files = [];
  annotations = [];
  sourceBytes = new Uint8Array();
  sourceStatus = 200;
  upstream = "honest";
  authRejects = false;
  uploadFails = false;
  signFails = false;
  Deno.env.delete("ANNOTATED_PDF_MAX_BYTES");
};

/** 临时把上限改小（不然「超限」那几条要真造 20MB） */
async function withLimit<T>(value: string, fn: () => Promise<T>): Promise<T> {
  Deno.env.set("ANNOTATED_PDF_MAX_BYTES", value);
  try {
    return await fn();
  } finally {
    Deno.env.delete("ANNOTATED_PDF_MAX_BYTES");
  }
}

// ------------------------------------------------------------------ fixture

const dec = new TextDecoder();

/** 内容流可能是 FlateDecode 压过的（pdf-lib 保存时就是），解压失败说明它没压 */
async function decodeStreamBytes(bytes: Uint8Array): Promise<string> {
  try {
    const ds = new DecompressionStream("deflate");
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return await new Response(new Blob([copy.buffer]).stream().pipeThrough(ds)).text();
  } catch {
    return dec.decode(bytes);
  }
}

/** 把一页的内容流（原件 + 我们追加的）全部解出来拼成一份文本 */
async function pageContentText(doc: PDFDocument, pageNo: number): Promise<string> {
  const contents = doc.getPage(pageNo - 1).node.Contents();
  if (!contents) return "";
  const objs = contents instanceof PDFArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref))
    : [contents];
  const parts: string[] = [];
  for (const obj of objs) {
    const bytes = (obj as { contents?: unknown } | null)?.contents;
    if (bytes instanceof Uint8Array) parts.push(await decodeStreamBytes(bytes));
  }
  return parts.join("\n");
}

let sourceCache: Uint8Array | null = null;

/** 2 页的干净原件：300×400 与 200×500（两个尺寸不同，好验「按该页尺寸换算」） */
async function sourceFixture(): Promise<Uint8Array> {
  if (!sourceCache) {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([200, 500]);
    sourceCache = await doc.save();
  }
  return sourceCache;
}

const stroke = (points: Array<[number, number]>, extra: { color?: string; width?: number } = {}) => ({
  color: extra.color ?? "#ff0000",
  width: extra.width ?? 0.1,
  points,
});

/** 我的笔迹在页 1；别人的在页 2（两页不同 ⇒ 少一层过滤时产物会多一页） */
const MY_STROKE = stroke([[0.5, 0.25], [0.5, 0.5]], { color: "#ff0000" });
const OTHER_STROKE = stroke([[0.5, 0.25], [0.5, 0.5]], { color: "#00ff00" });

async function seedHappy(): Promise<void> {
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 1024 }];
  annotations = [
    { file_id: FILE_ID, user_id: ME, page: 1, strokes: [MY_STROKE] },
    { file_id: FILE_ID, user_id: OTHER, page: 2, strokes: [OTHER_STROKE] },
  ];
  sourceBytes = await sourceFixture();
}

// ------------------------------------------------------------------ 纯函数

Deno.test("isFileId：只认 uuid（它是拼 PostgREST 查询与 storage 路径的输入）", () => {
  assertEquals(isFileId(FILE_ID), true);
  assertEquals(isFileId(FILE_ID.toUpperCase()), true);
  assertEquals(isFileId("not-a-uuid"), false);
  assertEquals(isFileId("11111111-1111-4111-8111-11111111111"), false); // 少一位
  assertEquals(isFileId("../../etc/passwd"), false);
  assertEquals(isFileId("1' or '1'='1"), false);
  assertEquals(isFileId(""), false);
  assertEquals(isFileId(null), false);
  assertEquals(isFileId(123), false);
});

Deno.test("contentRangeTotal：被截断时它是唯一知道**整份**多大的地方", () => {
  assertEquals(contentRangeTotal("bytes 0-199/12345"), 12345);
  assertEquals(contentRangeTotal("bytes 0-199/ 12345"), 12345);
  // 认不出来必须回 null（调用方据此退回 content-length），不能瞎猜一个数
  assertEquals(contentRangeTotal("bytes 0-199/*"), null);
  assertEquals(contentRangeTotal("garbage"), null);
  // `bytes */12345` 是 RFC 7233 的「整份 12345 字节」写法，读得出 N 是**更保守**的方向
  // （界只会更早触发），所以它算认得、不算畸形
  assertEquals(contentRangeTotal("bytes */12345"), 12345);
  assertEquals(contentRangeTotal(""), null);
  assertEquals(contentRangeTotal(null), null);
});

Deno.test("pdfSizeLimit：覆盖值只认正整数（写坏了要退回默认，不能悄悄变成 0）", () => {
  reset();
  assertEquals(pdfSizeLimit(), DEFAULT_MAX_PDF_BYTES);
  assertEquals(DEFAULT_MAX_PDF_BYTES, 20 * 1024 * 1024);

  Deno.env.set("ANNOTATED_PDF_MAX_BYTES", "1024");
  assertEquals(pdfSizeLimit(), 1024);
  // 这三个都是「配置写坏了」：退回默认值，而不是让所有请求都 413
  Deno.env.set("ANNOTATED_PDF_MAX_BYTES", "0");
  assertEquals(pdfSizeLimit(), DEFAULT_MAX_PDF_BYTES);
  Deno.env.set("ANNOTATED_PDF_MAX_BYTES", "-1");
  assertEquals(pdfSizeLimit(), DEFAULT_MAX_PDF_BYTES);
  Deno.env.set("ANNOTATED_PDF_MAX_BYTES", "abc");
  assertEquals(pdfSizeLimit(), DEFAULT_MAX_PDF_BYTES);
  Deno.env.delete("ANNOTATED_PDF_MAX_BYTES");
});

Deno.test("annotatedPath：两段都由服务端给（调用者的输入只有 file_id）", () => {
  assertEquals(annotatedPath(ME, FILE_ID), `${ME}/${FILE_ID}.pdf`);
  assertEquals(annotatedPath(OTHER, FILE_ID).startsWith(`${OTHER}/`), true);
});

Deno.test("hasAnyStroke：只认「至少有一笔」的行", () => {
  assertEquals(hasAnyStroke([{ strokes: [MY_STROKE] }]), true);
  assertEquals(hasAnyStroke([{ strokes: [] }, { strokes: [{ color: "#000" }] }]), true);
  assertEquals(hasAnyStroke([{ strokes: [] }]), false);
  assertEquals(hasAnyStroke([{ strokes: null }, { strokes: "不是数组" }]), false);
  assertEquals(hasAnyStroke([]), false);
  assertEquals(hasAnyStroke(null), false);
});

// ------------------------------------------------------------------ 入口与鉴权

Deno.test("鉴权：缺 Authorization → 401，且**不去碰库、也不碰 storage**", async () => {
  reset();
  await seedHappy();
  const res = await call({ file_id: FILE_ID }, null);

  assertEquals(res.status, 401);
  assertEquals(requests.length, 0, "没带凭据就不该出网（连 auth 服务都不该问）");
});

Deno.test("鉴权：token 无效 → 401（网关不验签，这一关只能由我们自己守）", async () => {
  reset();
  await seedHappy();
  authRejects = true;
  const res = await call({ file_id: FILE_ID });

  assertEquals(res.status, 401);
  // 问过 auth 服务了，但**没有**继续读库/读文件
  assertEquals(restCalls().length, 0);
  assertEquals(storageCalls().length, 0);
});

Deno.test("非 POST → 405；OPTIONS 预检 → 204", async () => {
  reset();
  assertEquals((await handler(new Request("http://x/", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("http://x/", { method: "OPTIONS" }))).status, 204);
});

Deno.test("400：报文不是 JSON / file_id 不是 uuid → 只走了鉴权那一步，不碰库与 storage", async () => {
  reset();
  const bad = await handler(
    new Request("http://x/", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "not json",
    }),
  );
  assertEquals(bad.status, 400);
  assertEquals((await bad.json()).error, "invalid json body");

  const notUuid = await call({ file_id: "../../etc/passwd" });
  assertEquals(notUuid.status, 400);
  assertEquals((await notUuid.json()).error, "invalid file_id");

  // 生成的请求只允许有「验签」这一种（鉴权在解析报文之前，这是有意的：
  // 没登录的调用者不该让我们做任何别的事）
  assertEquals(
    requests.every((r) => r.url.includes("/auth/v1/user")),
    true,
    `不该有别的请求：${requests.map((r) => r.url).join(", ")}`,
  );
});

// ------------------------------------------------------------------ 读：身份与过滤

Deno.test("404：文件行不存在", async () => {
  reset();
  files = [];
  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "file not found");
  assertEquals(storageCalls().length, 0);
});

Deno.test("读的是**调用者身份**：REST 带的是调用者的 JWT，不是 service key", async () => {
  reset();
  await seedHappy();
  await call({ file_id: FILE_ID });

  const rest = restCalls();
  assertEquals(rest.length, 2, "应当只查两张表（文件行 + 批注），不多不少");
  for (const r of rest) {
    // 这一条是「RLS 真的会生效」的前提：PostgREST 按 Authorization 判角色
    assertEquals(r.headers.get("authorization"), `Bearer ${TOKEN}`, `${r.url} 的 Authorization`);
    // apikey 仍是 service key（网关那一层用它），但角色由 JWT 决定
    assertEquals(r.headers.get("apikey"), SERVICE_KEY);
  }
});

Deno.test("只取本人的批注（1/2）：查询里显式带 user_id 过滤", async () => {
  reset();
  await seedHappy();
  await call({ file_id: FILE_ID });

  const url = annotationCall().url;
  const params = new URL(url).searchParams;
  assertEquals(params.get("user_id"), `eq.${ME}`, "批注查询必须显式限定 user_id");
  assertEquals(params.get("file_id"), `eq.${FILE_ID}`);
  // 只取要用的两列，别把整行（含其它用户的审计字段）拖回来
  assertEquals(params.get("select"), "page,strokes");
});

Deno.test("只取本人的批注（2/2）：别人的行一笔都进不了产物 —— 这是缺失过滤时的红灯", async () => {
  reset();
  await seedHappy();
  const res = await call({ file_id: FILE_ID });
  const body = await res.json();

  assertEquals(res.status, 200);
  // 桩在页 2 上也放了一行**别人的**批注：少写 `.eq("user_id", …)` 时这里会变成 2/2
  assertEquals(body.annotatedPages, 1, "只有我的那一页该被画");
  assertEquals(body.drawnStrokes, 1);
  assertEquals(body.pdfPages, 2, "页数不该变");

  const uploaded = await PDFDocument.load(uploadCall().body!);
  // 页 2 在原件里是空白的：别人的笔迹若被烧进来，这里就不再是 undefined
  assertEquals(uploaded.getPage(1).node.Contents(), undefined, "别人的批注不该被烧进产物");
  const p1 = await pageContentText(uploaded, 1);
  assert(p1.includes("1 0 0 RG"), `页 1 应有我的红色笔迹：\n${p1}`);
  const p2 = await pageContentText(uploaded, 2);
  assert(!p2.includes("0 1 0 RG"), `页 2 不该有别人的绿色笔迹：\n${p2}`);
});

Deno.test("只取**这一份**谱子的批注：同一个用户在别的曲子上的批注不该烧进来", async () => {
  reset();
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 1024 }];
  annotations = [
    { file_id: FILE_ID, user_id: ME, page: 1, strokes: [MY_STROKE] },
    // 同一个用户、**另一份**曲子（页 2 是干净的，所以少了 file_id 过滤就会多出一页）
    { file_id: "44444444-4444-4444-8444-444444444444", user_id: ME, page: 2, strokes: [OTHER_STROKE] },
  ];
  sourceBytes = await sourceFixture();

  const res = await call({ file_id: FILE_ID });
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.annotatedPages, 1, "别的曲子的批注不该跟着过来");
  assertEquals(body.drawnStrokes, 1);

  const uploaded = await PDFDocument.load(uploadCall().body!);
  assertEquals(uploaded.getPage(1).node.Contents(), undefined);
});

Deno.test("400：这个用户一行批注都没有 → 不下载原件（白读一次大文件是最贵的那种浪费）", async () => {
  reset();
  await seedHappy();
  annotations = [{ file_id: FILE_ID, user_id: OTHER, page: 2, strokes: [OTHER_STROKE] }];

  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "no annotations");
  assertEquals(storageCalls().length, 0);
});

Deno.test("400：有行、但一笔都画不出（全是单点）→ 明说原因，也不上传", async () => {
  reset();
  await seedHappy();
  annotations = [
    { file_id: FILE_ID, user_id: ME, page: 1, strokes: [stroke([[0.5, 0.5]])] },
  ];

  const res = await call({ file_id: FILE_ID });
  const body = await res.json();
  assertEquals(res.status, 400);
  assertEquals(body.error, "no drawable strokes");
  assertEquals(body.dotStrokes, 1, "单点笔迹要计数报出来，别静默吞掉");
  assertEquals(uploadCall(), undefined, "什么都画不出来就不该上传一份和原件一样的 PDF");
});

Deno.test("413：批注行数超上限 → 不下载原件", async () => {
  reset();
  await seedHappy();
  annotations = Array.from({ length: MAX_ANNOTATION_ROWS + 1 }, () => ({
    file_id: FILE_ID,
    user_id: ME,
    page: 1,
    strokes: [MY_STROKE],
  }));

  const res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 413);
  assertEquals((await res.json()).error, "too many annotation rows");
  assertEquals(storageCalls().length, 0);
});

// ------------------------------------------------------------------ 体积：四道判据

Deno.test("413 判据1：库里的 file_size 就超限 → 一次 storage 都不碰", async () => {
  reset();
  await seedHappy();
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 999999 }];

  await withLimit("1024", async () => {
    const res = await call({ file_id: FILE_ID });
    const body = await res.json();
    assertEquals(res.status, 413);
    assertEquals(body.source, "file_size");
    assertEquals(body.bytes, 999999);
    assertEquals(body.limit, 1024);
    assertEquals(storageCalls().length, 0, "库里就写着超限，没必要去读它");
  });
});

Deno.test("413 判据2/3：Range 下载被截断 → content-range 里的**整份**大小挡住它", async () => {
  reset();
  await seedHappy();
  // 库里那列先放一个**不超限**的值，好让这一条只考「下载路径上的判据」
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 10 }];
  upstream = "honest";

  await withLimit("100", async () => {
    const res = await call({ file_id: FILE_ID });
    const body = await res.json();
    assertEquals(res.status, 413);
    assertEquals(body.source, "content-range");
    assertEquals(body.bytes, sourceBytes.byteLength);
    assertEquals(body.limit, 100);
    // 带的是 Range（超限的文件永远不会被整份读进来）
    assertEquals(downloadCall().headers.get("range"), "bytes=0-99");
  });
});

Deno.test("413 判据3：上游无视 Range、整份返回 → content-length 挡住（不读完再判）", async () => {
  reset();
  await seedHappy();
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 10 }];
  upstream = "no-range";

  await withLimit("100", async () => {
    const res = await call({ file_id: FILE_ID });
    const body = await res.json();
    assertEquals(res.status, 413);
    assertEquals(body.source, "content-length");
    assertEquals(body.bytes, sourceBytes.byteLength);
  });
});

Deno.test("413 判据4：连长度头都不给 → 按**实际字节数**兜底（头可以撒谎，字节数不会）", async () => {
  reset();
  await seedHappy();
  files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 10 }];
  upstream = "lying";

  await withLimit("100", async () => {
    const res = await call({ file_id: FILE_ID });
    const body = await res.json();
    assertEquals(res.status, 413);
    assertEquals(body.source, "actual");
    assertEquals(body.bytes, sourceBytes.byteLength);
  });
});

Deno.test("原件不存在 → 404；下载失败 → 502（不把上游状态码当自己的状态码回）", async () => {
  reset();
  await seedHappy();
  sourceStatus = 404;
  assertEquals((await call({ file_id: FILE_ID })).status, 404);

  reset();
  await seedHappy();
  sourceStatus = 500;
  const res = await call({ file_id: FILE_ID });
  const body = await res.json();
  assertEquals(res.status, 502);
  assertEquals(body.error, "failed to download source pdf");
  assertEquals(body.upstream, 500);
});

// ------------------------------------------------------------------ 合成失败

Deno.test("413：笔数超上限 → 报数，不硬着头皮画到超时", async () => {
  reset();
  await seedHappy();
  annotations = [
    {
      file_id: FILE_ID,
      user_id: ME,
      page: 1,
      strokes: Array.from({ length: MAX_TOTAL_STROKES + 1 }, () => MY_STROKE),
    },
  ];

  const res = await call({ file_id: FILE_ID });
  const body = await res.json();
  assertEquals(res.status, 413);
  assertEquals(body.error, "too many strokes");
  assertEquals(body.limit, MAX_TOTAL_STROKES);
  assertEquals(uploadCall(), undefined);
});

Deno.test("500：原件不是 PDF → 500，且不把内部异常原文吐给调用方", async () => {
  reset();
  await seedHappy();
  sourceBytes = new TextEncoder().encode("definitely not a pdf");

  const res = await call({ file_id: FILE_ID });
  const body = await res.json();
  assertEquals(res.status, 500);
  assertEquals(body.error, "failed to compose pdf");
  assertEquals("detail" in body, false, "内部异常不该出现在响应里");
  assertEquals(uploadCall(), undefined);
});

// ------------------------------------------------------------------ 产物

Deno.test("成功：产物落到私有桶的 <user>/<file>.pdf，回绝对签名 URL", async () => {
  reset();
  await seedHappy();
  const res = await call({ file_id: FILE_ID });
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.path, annotatedPath(ME, FILE_ID));
  assertEquals(body.expiresIn, 3600);

  // 下载原件：service role + Range
  const dl = downloadCall();
  assertEquals(dl.method, "GET");
  assertEquals(dl.url, `${TEST_URL}/storage/v1/object/${SOURCE_BUCKET}/${STORAGE_PATH}`);
  assertEquals(dl.headers.get("range"), `bytes=0-${DEFAULT_MAX_PDF_BYTES - 1}`);

  // 上传：路径两段都由服务端算（调用者给的 file_id 只是读键，指不到别处去）
  const up = uploadCall();
  assertEquals(up.method, "POST");
  assertEquals(up.url, `${TEST_URL}/storage/v1/object/${OUTPUT_BUCKET}/${ME}/${FILE_ID}.pdf`);
  assertEquals(up.headers.get("x-upsert"), "true", "重复导出要覆盖同一份对象，不留垃圾");
  assertEquals(up.headers.get("cache-control"), "max-age=0", "别让 CDN 缓存住上一条批注");
  assertEquals(up.headers.get("content-type"), "application/pdf");
  assertEquals(up.headers.get("authorization"), `Bearer ${SERVICE_KEY}`);

  // 传上去的确实是一份**带笔迹的** PDF（不是原件、也不是空文件）
  const uploaded = up.body!;
  assertEquals(dec.decode(uploaded.slice(0, 5)), "%PDF-");
  assertEquals(uploaded.byteLength, body.bytes);
  const doc = await PDFDocument.load(uploaded);
  assertEquals(doc.getPageCount(), 2);
  const p1 = await pageContentText(doc, 1);
  // (0.5,0.25) → x=150、y=400×(1−0.25)=300；线宽 0.1×300=30
  assert(p1.includes("150 300 m"), `页 1 起点应是 150 300：\n${p1}`);
  assert(p1.includes("150 200 l"), `页 1 折点应是 150 200：\n${p1}`);
  assert(p1.includes("30 w"), `页 1 线宽应为 0.1×300=30：\n${p1}`);
  assert(p1.includes("1 0 0 RG"), `页 1 应是红色：\n${p1}`);

  // 签名：POST 到 sign 路由，有效期就是响应里回的那个数
  const sign = signCall();
  assertEquals(sign.method, "POST");
  assertEquals(
    sign.url,
    `${TEST_URL}/storage/v1/object/sign/${OUTPUT_BUCKET}/${ME}/${FILE_ID}.pdf`,
  );
  assertEquals(JSON.parse(dec.decode(sign.body!)), { expiresIn: 3600 });

  // 回给客户端的是**绝对** URL（小程序 downloadFile 要的就是它）
  assertEquals(
    body.url,
    `${TEST_URL}/storage/v1/object/sign/${OUTPUT_BUCKET}/${ME}/${FILE_ID}.pdf?token=abc123`,
  );
  // 计数如实回给客户端，让「少画了几笔」是可见的
  assertEquals(body.skippedStrokes, 0);
  assertEquals(body.outOfRangeStrokes, 0);
  assertEquals(typeof body.bytes, "number");
});

Deno.test("成功：同一份重复导出 → 覆盖同一个对象（路径里没有任何客户端可控的自由段）", async () => {
  reset();
  await seedHappy();
  await call({ file_id: FILE_ID });
  const first = uploadCall().url;
  await call({ file_id: FILE_ID });
  const uploads = requests.filter((r) => r.url.includes(`/storage/v1/object/${OUTPUT_BUCKET}/`));

  assertEquals(uploads.length, 2);
  assertEquals(uploads[1].url, first);
  assertEquals(uploads.every((u) => u.headers.get("x-upsert") === "true"), true);
});

Deno.test("500：上传失败 / 签名失败各自报出来，且签名失败时不回半个成功", async () => {
  reset();
  await seedHappy();
  uploadFails = true;
  let res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "failed to upload annotated pdf");
  assertEquals(signCall(), undefined, "上传都没成，不该去签名");

  reset();
  await seedHappy();
  signFails = true;
  res = await call({ file_id: FILE_ID });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "failed to sign annotated pdf");
});

// ------------------------------------------------------------------ 响应头

/**
 * 响应头（**表驱动**）：每个响应点实际带哪几个头。
 *
 * 同 `delete-storage-file` / `llm-analyze` —— 「成功路径少写一个参数、响应少了全部 CORS
 * 头」那次缺陷就是在这个维度上漏掉的（状态码与报文一字不变）。期望值见
 * `../_shared/http.fixtures.ts`。
 */
Deno.test("响应头：每个响应点带哪些头（表驱动 —— 少一个 CORS 头这里就红）", async () => {
  const rows: Array<{
    name: string;
    expected: Record<string, string>;
    run: () => Promise<Response>;
  }> = [
    {
      name: "200 成功",
      expected: CORS_JSON_HEADERS,
      run: async () => {
        reset();
        await seedHappy();
        return await call({ file_id: FILE_ID });
      },
    },
    {
      name: "401 缺 Authorization",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return call({ file_id: FILE_ID }, null);
      },
    },
    {
      name: "401 token 无效",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        authRejects = true;
        return call({ file_id: FILE_ID });
      },
    },
    {
      name: "400 报文畸形",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return handler(
          new Request("http://x/", {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKEN}` },
            body: "not json",
          }),
        );
      },
    },
    {
      name: "400 file_id 不是 uuid",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return call({ file_id: "nope" });
      },
    },
    {
      name: "404 文件行不存在",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        return call({ file_id: FILE_ID });
      },
    },
    {
      name: "400 没有批注",
      expected: CORS_JSON_HEADERS,
      run: async () => {
        reset();
        await seedHappy();
        annotations = [];
        return await call({ file_id: FILE_ID });
      },
    },
    {
      name: "413 超限",
      expected: CORS_JSON_HEADERS,
      run: () => {
        reset();
        files = [{ id: FILE_ID, storage_path: STORAGE_PATH, file_size: 999999 }];
        annotations = [{ file_id: FILE_ID, user_id: ME, page: 1, strokes: [MY_STROKE] }];
        return withLimit("1024", () => call({ file_id: FILE_ID }));
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
          return await call({ file_id: FILE_ID });
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
  assertEquals(rows.length >= 11, true, "响应点表被改小了？少一个入口就少一份保护");
});

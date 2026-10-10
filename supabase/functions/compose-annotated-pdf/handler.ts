/**
 * 把**当前登录用户**对一份乐谱的批注烧进 PDF，产出一份可以直接转发/分享的 PDF。
 *
 * 输入：`{ file_id: "<uuid>" }`（`sheet_music_files.id`）
 * 输出：`{ path, url, expiresIn, bytes, pdfPages, annotatedPages, drawnStrokes,
 *          dotStrokes, skippedStrokes, outOfRangeStrokes }`
 * `url` 是一个**签名 URL**（私有桶），客户端 `downloadFile` 它即可拿到产物。
 *
 * ## 为什么这件事可以在 Edge Function 里做（而不是不能）
 *
 * 三条路都比过（矢量的理由写在 `compose.ts` 顶部）：真正拦住「在服务端合成」的从来不是
 * CPU 而是**内存**，而矢量叠加的内存是 O(文件大小)、不是 O(像素)——页面里已嵌入的扫描图
 * **一个字节都不解码**（pdf-lib 原样搬运），所以一份 20MB 的谱子峰值约 137MB，在 256MB 的
 * isolate 里留了一倍余量。下面是这个数字的配方与四道体积判据（外加两道别的界）。
 *
 * ## 内存：实测数字 + 四道判据
 *
 * 实测（本机 Deno，配方：造一份 `N` MB 的 PDF（挂 N 个 1MB 的不可压缩流——
 * Flate 压不动，所以文件大小可控），`composeAnnotatedPdf(src, 一笔批注)`，
 * 采样 `Deno.memoryUsage().rss` 的峰值，**每个尺寸单起一个进程**，
 * 否则上一次的垃圾会算进基线）：
 *
 * | 输入 | 峰值 RSS | 峰值 / 输入 |
 * | --- | --- | --- |
 * | 5MB | 78MB | 4.7× |
 * | 10MB | 97MB | 4.4× |
 * | 20MB | 137MB | 4.2× |
 * | 30MB | 148MB | 3.2× |
 *
 * 也就是 **峰值 ≈ 53MB（空进程）+ 4~4.7 × 文件大小**。⚠️ 这是本机 Deno 的数字，
 * **不是**线上 isolate 的 —— isolate 的堆上限（256MB）没法从本机量出来，见 PR 的
 * 「没能验证的部分」。取 20MB 为上限：按上面的倍数约 137MB，占上限一半出头。
 *
 * 四道判据（粗→细，**每一道都不需要先把文件读进内存**）：
 * 1. `sheet_music_files.file_size`（DB 里就有，零网络成本）；
 * 2. 下载时带 `Range: bytes=0-<limit-1>` —— 超限的文件**永远不会被整份读进来**；
 * 3. 响应头：`content-range` 的总长（截断下载时它是**整份**的大小）与 `content-length`
 *    取大者；
 * 4. 读完后的实际字节数（头可以撒谎，字节数不会）。
 *
 * 另外两道界：`MAX_TOTAL_STROKES`（笔数，防的是脏数据，见 `compose.ts`）与
 * `MAX_ANNOTATION_ROWS`（批注行数）。⚠️ 行数上限只挡「行多」、**不挡「行大」**：
 * 单行的界是列上的 `pg_column_size < 256KB`，1000 行理论上仍是 256MB 的响应体，
 * 而 `res.json()` 那一步没有闸。真要堵它得先在库里用聚合/RPC 把总量算出来再决定读不读
 * ——本轮没做（代价是新增一个 SECURITY INVOKER 函数及其授权面，而这条路径要求攻击者
 * 先往库里写几百 MB **自己的**批注，那些写入本身是可审计的）。行上限挡住的是「无意」
 * 那一类：正常批注是一册几十到几百行。
 *
 * ## 鉴权：为什么必须自己验
 *
 * 本仓 CI 用 `--no-verify-jwt` 部署（见 `_shared/auth.ts` 顶部），`config.toml` 里的
 * `verify_jwt` 是**死配置** ⇒ 网关不验签。这里用 `requireUser()` 真去 auth 服务验签，
 * 没登录一律 401。
 *
 * ## 「只取本人的批注」：两层，不是一层
 *
 * 读**全部走调用者的身份**（`userClient`：apikey 是 service key、Authorization 是调用者
 * 的 JWT ⇒ PostgREST 按 `authenticated` 判角色、RLS 真的会挡），**并且**显式带上
 * `.eq("user_id", auth.userId)`：
 *
 * - 只靠 RLS：一旦哪天有人把这一处改成 service client（或换掉 apikey 的用法），
 *   读就不再受策略约束，而**代码上看不出来**——那时这一句是唯一的拦阻；
 * - 只靠显式过滤：策略是库里的真相，代码里的过滤条件只是它的复述，可能漂移。
 *
 * 两层都留着，并且 `handler.test.ts` 里有一条用例专门让「少写那半句」变得**可观测**
 * （测试桩里同时存在另一个用户的批注行）。
 *
 * ⚠️ **绝不用 service client 读批注**：那一读是「按任意 file_id 读任意人的东西」，
 * 只要请求体里的 file_id 换一个，别人的笔迹就会烧进**我**的 PDF。
 *
 * 读 `sheet_music_files` 那行（只要 storage_path）没有这个问题（它的策略是 `USING (true)`,
 * 见 `20260922000001_create_sheet_music_tables.sql`），但同样走调用者身份 —— 少一条
 * 「这个客户端为什么是 service role」的解释。
 *
 * ## 产物落地
 *
 * 私有桶 `sheet-music-annotated`（见 `20261010220000_..._bucket.sql`，**刻意不加任何
 * storage 策略**：唯一的入口是本函数的 service role 签名 URL），对象路径
 * `<user_id>/<file_id>.pdf`。两段都是**服务端算出来的**——调用者指定的只有 file_id，
 * 而它是用来**读**的键，不是写路径，所以这次 service role 写不可能被指向别处。
 *
 * - `upsert`：同一份乐谱重复导出就覆盖同一份对象，不留垃圾；
 * - `cacheControl: "0"`：路径是固定的人+曲子，覆盖之后 CDN 上若还留着上一条会**静默发出
 *   过期的批注**——「幂等」在这里比省一点流量重要；
 * - 每次合成都**重新下载原件、重新合成**，不做「批注没变就复用上次产物」的缓存：
 *   那种缓存要在服务端持有「上次是哪一版批注」的指纹，一旦指纹算错，用户拿到的是一份
 *   **看起来正常但内容过期**的 PDF（本仓专门记过「降级掩盖失败」这个坑）。要省这点 CPU
 *   就得先有一个可信的指纹存储，不是本轮的事。
 * - 签名 URL 有效期 1 小时；`expiresIn` 一并回给客户端（免得它自己猜）。
 */

import { requireUser } from "../_shared/auth.ts";
import { readServiceEnv, serviceClient, userClient } from "../_shared/client.ts";
import { CORS_HEADERS, json } from "../_shared/http.ts";
import { composeAnnotatedPdf, TooManyStrokesError } from "./compose.ts";

/** 原件所在桶（`sheet_music_files.storage_path` 的桶） */
export const SOURCE_BUCKET = "sheet-music";

/** 产物所在桶（私有；迁移在 `20261010220000_create_sheet_music_annotated_bucket.sql`） */
export const OUTPUT_BUCKET = "sheet-music-annotated";

/** 签名 URL 有效期（秒）。产物是「导出一次、马上分享」，1 小时足够。 */
export const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * 原件大小上限的默认值（20MB）。改它的判据是内存，不是产品偏好：
 * 见文件头的实测表。可用环境变量 `ANNOTATED_PDF_MAX_BYTES` 覆盖（见 `pdfSizeLimit`）。
 */
export const DEFAULT_MAX_PDF_BYTES = 20 * 1024 * 1024;

/** 单次下载的墙钟上限。20MB 走小程序/境内链路正常几秒到几十秒，60s 是「明显不对」的界。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * 一次请求最多读多少行批注（每行 = 一页）。正常一册几十到几百页；
 * 它防的是「行多」这一类的异常，**不防「行大」**（见文件头）。
 */
export const MAX_ANNOTATION_ROWS = 1000;

/** 从 `sheet_music_files` 里只取这两列：一个用来下载，一个用来提前判大小。 */
const FILE_COLUMNS = "storage_path, file_size";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `file_id` 必须是 uuid：它是拼 PostgREST 查询与 storage 路径的输入，别放别的形状进来。 */
export function isFileId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * 原件大小上限：默认 20MB，`ANNOTATED_PDF_MAX_BYTES` 可覆盖（测试要一个小的界来验
 * 「超限」那几条，而不是真造 20MB）。
 *
 * 覆盖值只认**正的整数**：写成 `"abc"` / `"0"` / `"-1"` 一律退回默认值——运行期参数
 * 悄悄变成 0 会让所有请求都 413，那是比「配置没生效」更难查的故障。
 */
export function pdfSizeLimit(): number {
  const raw = Deno.env.get("ANNOTATED_PDF_MAX_BYTES");
  if (!raw) return DEFAULT_MAX_PDF_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_PDF_BYTES;
}

/**
 * `content-range: bytes 0-199/12345` → 12345（整份文件的大小）。
 *
 * ⚠️ 这个头是**截断下载时唯一**能知道整份多大的地方：带 `Range` 请求一个超限的文件时，
 * 服务端回的是 206 + 前 N 字节，`content-length` 只是 N —— 只看它就永远发现不了超限。
 * 认不出来（没有这个头、`*`、畸形）返回 null，调用方退回 `content-length`。
 */
export function contentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /\/\s*(\d+)\s*$/.exec(header);
  if (!m) return null;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) ? total : null;
}

/** 产物在桶里的路径。**两段都由服务端给出**（见文件头）。 */
export function annotatedPath(userId: string, fileId: string): string {
  return `${userId}/${fileId}.pdf`;
}

/** 这批行里有没有「至少要画一笔」的东西（没有就不必下载原件了）。 */
export function hasAnyStroke(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const strokes = (row as { strokes?: unknown } | null)?.strokes;
    return Array.isArray(strokes) && strokes.length > 0;
  });
}

/** 给日志/响应用的错误文本（异常不一定是 Error） */
function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

type SourceDownload =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * 下载原件。**这是内存的主战场**（四道判据里的后三道都在这里），所以每一步都
 * 先判后读、一旦判超限就 `cancel()` 掉 body 再返回。
 */
async function downloadSource(env: { url: string; key: string }, storagePath: string, limit: number): Promise<SourceDownload> {
  // 逐段转义、保留 `/`：现在库里的 storage_path 全是 `<uuid>/<uuid>.pdf`（52/52 实测，
  // 无空格、无 `%`、无非 ASCII —— 所以这条转义对当下的数据是恒等的），但文件名是人给的，
  // 将来出现空格/中文时裸拼就会把请求发成一个坏的 URL。
  const objectPath = storagePath.split("/").map(encodeURIComponent).join("/");

  let res: Response;
  try {
    res = await fetch(`${env.url}/storage/v1/object/${SOURCE_BUCKET}/${objectPath}`, {
      headers: {
        Authorization: `Bearer ${env.key}`,
        apikey: env.key,
        // 只要前 limit 个字节：超限的文件**不会**被整份读进来（判据 2）
        Range: `bytes=0-${limit - 1}`,
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    // 超时（AbortSignal）与网络错误都到这里
    return { ok: false, status: 502, body: { error: "failed to download source pdf", detail: describe(e) } };
  }

  if (res.status === 404) {
    void res.body?.cancel();
    return { ok: false, status: 404, body: { error: "source pdf not found" } };
  }
  if (!res.ok) {
    void res.body?.cancel();
    return {
      ok: false,
      status: 502,
      body: { error: "failed to download source pdf", upstream: res.status },
    };
  }

  // 判据 3：`content-range` 的总长与 `content-length` 取大者
  const total = contentRangeTotal(res.headers.get("content-range"));
  const declared = Number(res.headers.get("content-length"));
  const bound = Math.max(total ?? 0, Number.isFinite(declared) ? declared : 0);
  if (bound > limit) {
    void res.body?.cancel();
    return {
      ok: false,
      status: 413,
      body: {
        error: "file too large",
        source: total !== null ? "content-range" : "content-length",
        bytes: bound,
        limit,
      },
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, status: 502, body: { error: "failed to read source pdf", detail: describe(e) } };
  }

  // 判据 4：实际字节数（头可以撒谎 —— 测试桩里就有一条「头说小、其实很大」的用例）
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      status: 413,
      body: { error: "file too large", source: "actual", bytes: bytes.byteLength, limit },
    };
  }

  return { ok: true, bytes };
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, CORS_HEADERS);
  }

  const env = readServiceEnv();
  if (!env) {
    return json({ error: "server misconfigured" }, 500, CORS_HEADERS);
  }

  // 网关不验签（CI 用 --no-verify-jwt 部署），必须自己验 —— 否则拿到 publishable key
  // 的任何人就能拿别人的批注去烧别人的谱子（顺带烧掉本函数的 CPU 与存储）。
  const auth = await requireUser(req, CORS_HEADERS);
  if (!auth.ok) return auth.response;

  let fileId: unknown;
  try {
    ({ file_id: fileId } = await req.json());
  } catch {
    return json({ error: "invalid json body" }, 400, CORS_HEADERS);
  }
  if (!isFileId(fileId)) {
    return json({ error: "invalid file_id" }, 400, CORS_HEADERS);
  }

  // 读全部走调用者身份（RLS 生效）；写才用 service role（见文件头）
  const authorization = req.headers.get("Authorization")!;
  const asCaller = userClient(env, authorization);

  const { data: file, error: fileError } = await asCaller
    .from("sheet_music_files")
    .select(FILE_COLUMNS)
    .eq("id", fileId)
    .maybeSingle();

  if (fileError) {
    console.error("compose-annotated-pdf 读文件行失败:", fileError.message);
    return json({ error: "failed to load file" }, 500, CORS_HEADERS);
  }
  if (!file) {
    return json({ error: "file not found" }, 404, CORS_HEADERS);
  }

  // ⚠️ `.eq("user_id", ...)` 与 RLS 是**两层**，别删（理由见文件头）
  const { data: rows, error: annotationError } = await asCaller
    .from("sheet_music_annotations")
    .select("page, strokes")
    .eq("file_id", fileId)
    .eq("user_id", auth.userId)
    .limit(MAX_ANNOTATION_ROWS + 1);

  if (annotationError) {
    console.error("compose-annotated-pdf 读批注失败:", annotationError.message);
    return json({ error: "failed to load annotations" }, 500, CORS_HEADERS);
  }

  const annotations = rows ?? [];
  if (annotations.length > MAX_ANNOTATION_ROWS) {
    return json(
      { error: "too many annotation rows", limit: MAX_ANNOTATION_ROWS },
      413,
      CORS_HEADERS,
    );
  }
  // 一笔都没有就**不要下载原件**：既省流量，也让这条路径在测试里可观测
  if (!hasAnyStroke(annotations)) {
    return json({ error: "no annotations" }, 400, CORS_HEADERS);
  }

  // 判据 1：库里就有的大小（零网络成本）
  const limit = pdfSizeLimit();
  const declaredSize = typeof file.file_size === "number" ? file.file_size : null;
  if (declaredSize !== null && declaredSize > limit) {
    return json(
      { error: "file too large", source: "file_size", bytes: declaredSize, limit },
      413,
      CORS_HEADERS,
    );
  }

  const download = await downloadSource(env, String(file.storage_path), limit);
  if (!download.ok) {
    return json(download.body, download.status, CORS_HEADERS);
  }

  let composed;
  try {
    composed = await composeAnnotatedPdf(download.bytes, annotations);
  } catch (e) {
    if (e instanceof TooManyStrokesError) {
      return json({ error: "too many strokes", drawn: e.drawn, limit: e.limit }, 413, CORS_HEADERS);
    }
    // 加密/损坏/不是 PDF 都会落到这里。不回内部异常原文（对调用方没有意义）。
    console.error("compose-annotated-pdf 合成失败:", e);
    return json({ error: "failed to compose pdf" }, 500, CORS_HEADERS);
  }

  // 有行、但一笔都画不出来（全是单点或脏数据）：说清楚，别上传一份和原件一样的 PDF
  if (composed.drawn === 0) {
    return json(
      {
        error: "no drawable strokes",
        dotStrokes: composed.dots,
        skippedStrokes: composed.skipped,
        outOfRangeStrokes: composed.outOfRange,
      },
      400,
      CORS_HEADERS,
    );
  }

  const path = annotatedPath(auth.userId, fileId);
  const admin = serviceClient(env);

  const upload = await admin.storage.from(OUTPUT_BUCKET).upload(path, composed.bytes, {
    contentType: "application/pdf", // 桶上限制了 mime：漏了会被 storage 拒
    upsert: true,
    cacheControl: "0", // 别让 CDN 缓存住上一条批注（见文件头）
  });
  if (upload.error) {
    console.error("compose-annotated-pdf 上传失败:", upload.error.message);
    return json({ error: "failed to upload annotated pdf" }, 500, CORS_HEADERS);
  }

  const signed = await admin.storage
    .from(OUTPUT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("compose-annotated-pdf 签名失败:", signed.error?.message ?? "no signedUrl");
    return json({ error: "failed to sign annotated pdf" }, 500, CORS_HEADERS);
  }

  return json(
    {
      path,
      url: signed.data.signedUrl,
      expiresIn: SIGNED_URL_TTL_SECONDS,
      bytes: composed.bytes.byteLength,
      pdfPages: composed.pageCount,
      annotatedPages: composed.annotatedPages,
      drawnStrokes: composed.drawn,
      dotStrokes: composed.dots,
      skippedStrokes: composed.skipped,
      outOfRangeStrokes: composed.outOfRange,
    },
    200,
    CORS_HEADERS,
  );
}

/**
 * 「把批注烧进 PDF」两个 Edge Function（个人 / 共享）共用的导出骨架：
 * 原件桶、产物桶、体积四道判据、行数上限、UUID 校验。
 *
 * 纯合成（坐标/绘制）在 `compose.ts` / `paint.ts`；这里只放**两个 handler 都要做、
 * 且做错了会出事**的那几件：鉴权之外的输入校验、**先判后读**的下载、以及产物路径。
 *
 * ## 内存：四道判据为什么不先读再判
 *
 * 实测（本机 Deno，配方见 `compose-annotated-pdf/handler.ts` 文件头）峰值 ≈ 53MB +
 * 4~4.7 × 文件大小，取 20MB 为上限。判据顺序（粗→细，**每一道都不需要先把文件读进内存**）：
 *
 * 1. `sheet_music_files.file_size`（DB 里就有，零网络成本）；
 * 2. 下载时带 `Range: bytes=0-<limit-1>` —— 超限文件**永远不会被整份读进来**；
 * 3. 响应头 `content-range` 的总长与 `content-length` 取大者；
 * 4. 读完后的实际字节数（头可以撒谎，字节数不会）。
 *
 * ## 鉴权
 *
 * 两个函数都用 `requireUser()` 自己验签；网关的 `verify_jwt` 是死配置（CI 用
 * `--no-verify-jwt` 部署，见 `compose-annotated-pdf/handler.ts` 文件头）。
 */

/** 原件所在桶（`sheet_music_files.storage_path` 的桶） */
export const SOURCE_BUCKET = "sheet-music";

/** 产物所在桶（私有；迁移在 `20261010220000_create_sheet_music_annotated_bucket.sql`） */
export const OUTPUT_BUCKET = "sheet-music-annotated";

/** 签名 URL 有效期（秒）。产物是「导出一次、马上分享」，1 小时足够。 */
export const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * 原件大小上限的默认值（20MB）。改它的判据是内存，不是产品偏好：
 * 见文件头。可用环境变量 `ANNOTATED_PDF_MAX_BYTES` 覆盖。
 */
export const DEFAULT_MAX_PDF_BYTES = 20 * 1024 * 1024;

/** 单次下载的墙钟上限。20MB 走小程序/境内链路正常几秒到几十秒，60s 是「明显不对」的界。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * 一次请求最多读多少行批注（每行 = 一页）。正常一册几十到几百页；
 * 它防的是「行多」这一类的异常，**不防「行大」**（单行的界是列上的 `pg_column_size`）。
 */
export const MAX_ANNOTATION_ROWS = 1000;

/** 从 `sheet_music_files` 里只取这两列：一个用来下载，一个用来提前判大小。 */
export const FILE_COLUMNS = "storage_path, file_size";

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

/** 这批行里有没有「至少要画一笔」的东西（没有就不必下载原件了）。 */
export function hasAnyStroke(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const strokes = (row as { strokes?: unknown } | null)?.strokes;
    return Array.isArray(strokes) && strokes.length > 0;
  });
}

/** 给日志/响应用的错误文本（异常不一定是 Error） */
export function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export type SourceDownload =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * 下载原件。**这是内存的主战场**（判据 2–4 都在这里），所以每一步都
 * 先判后读、一旦判超限就 `cancel()` 掉 body 再返回。
 */
export async function downloadSource(
  env: { url: string; key: string },
  storagePath: string,
  limit: number,
): Promise<SourceDownload> {
  // 逐段转义、保留 `/`：现在库里的 storage_path 全是 `<uuid>/<uuid>.pdf`，
  // 但文件名是人给的，将来出现空格/中文时裸拼就会把请求发成一个坏的 URL。
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
    return {
      ok: false,
      status: 502,
      body: { error: "failed to download source pdf", detail: describe(e) },
    };
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
    return {
      ok: false,
      status: 502,
      body: { error: "failed to read source pdf", detail: describe(e) },
    };
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

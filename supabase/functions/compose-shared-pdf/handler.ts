/**
 * 把**共享层**的批注烧进 PDF（P6d）：任何已登录成员都能导出「当前共享谱」。
 *
 * 输入：`{ file_id: "<uuid>" }`（`sheet_music_files.id`）
 * 输出：`{ path, url, expiresIn, bytes, pdfPages, annotatedPages, drawnStrokes,
 *          dotStrokes, skippedStrokes, outOfRangeStrokes }`
 *
 * ## 与 compose-annotated-pdf 的边界
 *
 * - 个人函数：只读**调用者本人**的 `sheet_music_annotations`（RLS + 显式 user_id 两层），
 *   产物 `<user_id>/<file_id>.pdf`；**本函数不改它**。
 * - 本函数：读 `sheet_music_shared_annotations`（RLS 允许全团已登录用户读），
 *   产物 `shared/<file_id>.pdf`。共享批注本来就是全团可见的同一份内容，所以
 *   **不需要** A2 写权，也不需要按用户过滤；显式条件只有 `file_id`。
 *
 * ## 鉴权与读路径
 *
 * `requireUser()` 自己验签（网关的 `verify_jwt` 是死配置，见 `_shared/auth.ts`）。
 * 读一律走**调用者身份**（`userClient`）—— RLS 真的会挡匿名；本函数的读路径里
 * **没有** `.eq("user_id", ...)`，这是有意的：共享层不属于某一个人。
 *
 * ## 内存 / 体积
 *
 * 与个人函数同一套四道判据（见 `_shared/pdf-annotations/export.ts` 文件头）：
 * `file_size` → Range 下载 → 响应头总长 → 实际字节数；20MB 上限，峰值约 137MB。
 * 行数上限 `MAX_ANNOTATION_ROWS` 防「行多」，不防「行大」。
 */

import { requireUser } from "../_shared/auth.ts";
import { readServiceEnv, serviceClient, userClient } from "../_shared/client.ts";
import { CORS_HEADERS, json } from "../_shared/http.ts";
import { composeAnnotatedPdf, TooManyStrokesError } from "../_shared/pdf-annotations/compose.ts";
import {
  FILE_COLUMNS,
  MAX_ANNOTATION_ROWS,
  OUTPUT_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  downloadSource,
  hasAnyStroke,
  isFileId,
  pdfSizeLimit,
} from "../_shared/pdf-annotations/export.ts";

/** 共享批注表（P5'；RLS：authenticated 可读，写只走 CAS RPC） */
const SHARED_TABLE = "sheet_music_shared_annotations";

/** 产物在桶里的路径：共享层不属于某个用户，所以没有 user 段。 */
export function sharedPdfPath(fileId: string): string {
  return `shared/${fileId}.pdf`;
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

  // 网关不验签（CI 用 --no-verify-jwt 部署），必须自己验
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

  // 读全部走调用者身份（RLS 生效）；写才用 service role
  const authorization = req.headers.get("Authorization")!;
  const asCaller = userClient(env, authorization);

  const { data: file, error: fileError } = await asCaller
    .from("sheet_music_files")
    .select(FILE_COLUMNS)
    .eq("id", fileId)
    .maybeSingle();

  if (fileError) {
    console.error("compose-shared-pdf 读文件行失败:", fileError.message);
    return json({ error: "failed to load file" }, 500, CORS_HEADERS);
  }
  if (!file) {
    return json({ error: "file not found" }, 404, CORS_HEADERS);
  }

  // ⚠️ 共享层**不按 user 过滤**（这是与个人函数的唯一读路径差异）；RLS 只给已登录用户读
  const { data: rows, error: annotationError } = await asCaller
    .from(SHARED_TABLE)
    .select("page, strokes")
    .eq("file_id", fileId)
    .limit(MAX_ANNOTATION_ROWS + 1);

  if (annotationError) {
    console.error("compose-shared-pdf 读共享批注失败:", annotationError.message);
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
  // 一笔都没有就不要下载原件：既省流量，也让这条路径在测试里可观测
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
      return json(
        { error: "too many strokes", drawn: e.drawn, limit: e.limit },
        413,
        CORS_HEADERS,
      );
    }
    console.error("compose-shared-pdf 合成失败:", e);
    return json({ error: "failed to compose pdf" }, 500, CORS_HEADERS);
  }

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

  const path = sharedPdfPath(fileId);
  const admin = serviceClient(env);

  const upload = await admin.storage.from(OUTPUT_BUCKET).upload(path, composed.bytes, {
    contentType: "application/pdf",
    upsert: true,
    // 路径固定（shared/<file_id>.pdf），CDN 若缓存上一条会静默发出过期的共享批注
    cacheControl: "0",
  });
  if (upload.error) {
    console.error("compose-shared-pdf 上传失败:", upload.error.message);
    return json({ error: "failed to upload annotated pdf" }, 500, CORS_HEADERS);
  }

  const signed = await admin.storage
    .from(OUTPUT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("compose-shared-pdf 签名失败:", signed.error?.message ?? "no signedUrl");
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

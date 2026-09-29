/**
 * 删除 Supabase Storage 中的文件。
 *
 * 调用方是数据库触发器 `function_delete_storage_on_row_delete`（挂在 `posts` /
 * `profiles` / `leave_requests` 的 BEFORE DELETE 上），它用 `net.http_post` 发请求，
 * headers 里**只有 `Content-Type`** —— 不带任何可以校验的凭据。
 *
 * 所以本函数不做鉴权。这不是疏忽，是调用方式的硬约束：
 *   - 触发器是 SECURITY INVOKER，没有能安全携带的密钥；
 *   - 把密钥写进触发器函数体也没用 —— 任何能读 `pg_proc` 的角色都能看走它
 *     （2026-09-29 实测：一句 `pg_get_functiondef` 就读到了触发器全文）。
 *
 * 因此安全模型不建立在「谁能调用」上，而建立在「**调用也删不掉什么**」上：
 *
 *   1. **bucket 白名单** —— 只认触发器真正会用到的三个 bucket；
 *      其余一律拒绝（`sheet-music`、`avatar_images` 之外的都进不来）
 *   2. **引用检查** —— 只删「已经没有任何行再引用它」的文件。
 *      触发器是 BEFORE DELETE 且 `net.http_post` 异步投递（commit 之后才发），
 *      所以正常删除走到这里时行已经没了、检查会放行；反过来，事务回滚了、
 *      或这个文件还被别的行引用着，检查会拦住。
 *
 * 两者合起来，本函数的破坏力等于它的用途：**一个垃圾回收器**。恶意调用者最多
 * 只能触发删除本来就该被删的孤儿文件 —— 而那正是它存在的理由。
 *
 * ⚠️ 这两条是**唯一**的防线。改这个文件时不要为了「简化」去掉任何一条：
 * 没有白名单，一次请求就能删空 `sheet-music` 里所有乐谱；没有引用检查，
 * 一次请求就能删掉任意一张还在用的社区图片。改动前请先看 `handler.test.ts`
 * 里对应的那几条断言。
 *
 * 输入：`{ bucket: string, paths: string[] }`
 * 输出：`{ success, deleted, skipped, errors? }`
 */

import { readServiceEnv, serviceClient } from "../_shared/client.ts";
import { CORS_HEADERS, json } from "../_shared/http.ts";

/**
 * bucket → 还会引用它的「表.列」。白名单与引用检查**共用这一份定义**：
 * 加一个受管 bucket 只需要改这里，不会出现「白名单加了、引用检查忘了加」。
 */
export const BUCKET_REFERENCING_COLUMNS: Record<
  string,
  ReadonlyArray<{ table: string; column: string }>
> = {
  "community-images": [{ table: "posts", column: "image_url" }],
  avatar_images: [{ table: "profiles", column: "avatar_url" }],
  "leave-attachments": [{ table: "leave_requests", column: "attachment_url" }],
};

/** 单次请求最多处理多少个路径。触发器一次只发 1 个；这个上限只用来挡住滥用。 */
export const MAX_PATHS = 100;

/**
 * LIKE 的通配符转义。路径里会出现 `_`（随机 id、文件名），
 * 不转义的话 `LIKE '%a_b%'` 会把 `aXb` 也当成命中 —— 引用检查会误判为「还在用」，
 * 于是该删的文件删不掉。反过来说，转义漏了不会造成误删，只会造成漏删。
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 路径合法性：拒绝空串、绝对路径、以及任何一段是 `..` 的路径。 */
export function isSafePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (path.split("/").some((seg) => seg === "..")) return false;
  return true;
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

  let bucket: unknown;
  let paths: unknown;
  try {
    ({ bucket, paths } = await req.json());
  } catch {
    return json({ error: "invalid json body" }, 400, CORS_HEADERS);
  }

  // ---- 防线 1：bucket 白名单 ----
  const columns = typeof bucket === "string" ? BUCKET_REFERENCING_COLUMNS[bucket] : undefined;
  if (!columns) {
    // 注意：这里**不**把 bucket 回显进错误里再让人猜 —— 直接说明受管的只有哪些。
    return json(
      {
        error: "bucket not managed by this function",
        managed: Object.keys(BUCKET_REFERENCING_COLUMNS),
      },
      400,
      CORS_HEADERS,
    );
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    return json({ error: "missing paths" }, 400, CORS_HEADERS);
  }
  if (paths.length > MAX_PATHS) {
    return json({ error: `too many paths (max ${MAX_PATHS})` }, 400, CORS_HEADERS);
  }

  const supabase = serviceClient(env);
  const errors: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const rawPath of paths) {
    if (!isSafePath(rawPath)) {
      errors.push(`unsafe path rejected: ${JSON.stringify(rawPath)}`);
      continue;
    }

    // ---- 防线 2：引用检查 ----
    // 「还有任何一行引用它」= 不删。任一次查询出错也**不删**（宁可漏删孤儿文件，
    // 也不能因为一次网络抖动把还在用的图片删了）。
    let stillReferenced = false;
    let checkFailed = false;
    for (const { table, column } of columns) {
      const { data, error } = await supabase
        .from(table)
        .select("id")
        .like(column, `%${escapeLike(rawPath)}%`)
        .limit(1);

      if (error) {
        checkFailed = true;
        errors.push(`reference check failed for ${rawPath} (${table}.${column}): ${error.message}`);
        break;
      }
      if (data && data.length > 0) {
        stillReferenced = true;
        break;
      }
    }

    if (checkFailed || stillReferenced) {
      skipped.push(rawPath);
      continue;
    }

    try {
      const response = await fetch(
        `${env.url}/storage/v1/object/${bucket}/${rawPath}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${env.key}`,
            apikey: env.key,
          },
        },
      );

      if (response.ok) {
        deleted.push(rawPath);
      } else {
        const errorText = await response.text();
        errors.push(`Failed to delete ${rawPath}: ${response.status} ${errorText}`);
      }
    } catch (e) {
      errors.push(`Error deleting ${rawPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // `skipped` 不算失败：它正是「这个文件还被引用着」这条防线的正常产物。
  return json({
    success: errors.length === 0,
    deleted: deleted.length,
    skipped: skipped.length,
    errors: errors.length > 0 ? errors : undefined,
  }, 200, CORS_HEADERS);
}

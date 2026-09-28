-- 客户端错误上报：把「带幂等键的写入」收进一个 SECURITY DEFINER 函数
--
-- 为什么必须有它：客户端改成 upsert(…, { onConflict: 'client_id', ignoreDuplicates: true })
-- 之后，**每一次上报都被 RLS 拒成 42501**，队列被整批丢弃。实测（同一张表、同一 anon key、
-- 同一 payload，只改 Prefer 头）：
--   无 Prefer / handling=strict / return=minimal      → 201
--   return=representation                            → 42501
--   resolution=merge-duplicates                      → 42501
--   resolution=ignore-duplicates                     → 42501（再加 return=minimal 也救不回来）
-- 原因是 PostgREST 生成 `INSERT … RETURNING $2`：minimal 时 $2 是常量（RETURNING 1），不读
-- 任何列；而 representation 与**整个 upsert 路径**会把它填成列清单——`INSERT … RETURNING <列>`
-- 在 RLS 下要求新行对 SELECT 策略可见，本表的 SELECT 策略只有 is_admin()，于是必被拒。
-- 也就是说 **upsert 在这张表上根本不可能成功**，与 payload 内容、与有没有登录都无关。
--
-- 为什么不能靠改客户端绕过去：
-- - 退回 plain insert（这次之前就是它）：队列是「至少一次投递」，插入已提交但响应丢失/中断时
--   整队会重发，而库里没有幂等键 —— 那正是这次要修的重复。
-- - 给客户端开 SELECT：本表存的是全站错误（栈、页面路径、版本），让任何登录用户读走全部records
--   不可接受。需要的是「写进去」，不是「读回来」。
-- SECURITY DEFINER 是唯一能同时满足「不读回」与「幂等」的形状。
--
-- 为什么它是安全的：
-- - 只做一件事：把参数里的行插进本表，冲突即跳过。无动态 SQL；search_path 显式钉死。
-- - user_id 由**函数**写成 auth.uid()，不从参数取（jsonb_to_recordset 的列清单里没有它，
--   多余键被忽略）。客户端因此无法把记录记到别人名下——这条保证与原 WITH CHECK 等价，
--   且不再依赖「列默认值会不会被 PostgREST 应用」这种没被验证过的行为。
-- - 表级 INSERT 权限**保留不动**：0.4.26/0.4.27 已在线上用 plain insert 直写，收走会让
--   老版本彻底无法上报。两条路径并存，新客户端走函数。
--
-- 有意保留的一个行为：整批是**一条** INSERT，某一行违反 CHECK/NOT NULL 会让整批失败并报错
-- （客户端据此记一条 console.error 并丢弃该批）。宁可响亮地丢，也不要逐行 try/catch 静默跳过
-- ——那会把「客户端造出了不合规的行」这件事藏起来。

CREATE OR REPLACE FUNCTION public.log_client_errors(rows jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.client_error_logs
    (client_id, created_at, level, source, event, message, detail,
     app_version, platform, page, user_id)
  SELECT x.client_id, x.created_at, x.level, x.source, x.event, x.message, x.detail,
         x.app_version, x.platform, x.page, (SELECT auth.uid())
    FROM jsonb_to_recordset(rows) AS x(
      client_id uuid,
      created_at timestamp with time zone,
      level text,
      source text,
      event text,
      message text,
      detail jsonb,
      app_version text,
      platform text,
      page text
    )
  ON CONFLICT (client_id) DO NOTHING;
$function$;

-- 新函数默认对 PUBLIC 开放 EXECUTE，必须先收回再按需授予
REVOKE ALL ON FUNCTION public.log_client_errors(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_client_errors(jsonb) TO anon, authenticated;

COMMENT ON FUNCTION public.log_client_errors(jsonb) IS
  '客户端错误上报入口（幂等）：按 client_id 去重，user_id 取 auth.uid()。'
  '客户端走它而不是直写 client_error_logs——直写若要幂等就得 upsert，而 upsert 需要读回插入的行，'
  '与本表「只写不读」的 RLS 相冲突（报 42501）。';

-- 回滚：DROP FUNCTION public.log_client_errors(jsonb);
-- （表级 GRANT 与既有策略均未改动，无需回滚）

-- client_error_logs：保留期 90 天 → 30 天
--
-- 为什么改：这张表的行数由网络探针主导（source='probe'，即反代的定时探测，每条腿每 15 分钟
-- 一次；2026-10-07 实测约 190 行/天、占全表约九成）。探针行的用途是「出事后回头看这几小时/
-- 这几天的链路」，30 天远超需要；真实客户端错误也很少回溯一个月以上。行宽上限 1KB（见建表
-- migration 的容量估算），所以保留期直接决定这张表的稳态大小。
--
-- 只替换函数体，别的一概不动：
-- - 调度不动。pg_cron 任务（cleanup-client-error-logs，每日 04:17）按函数名调用，保留期写在
--   函数体里，所以改它不需要碰排程。
-- - 表 / 索引 / RLS / 权限都不动。
-- - **这次迁移不删任何现存数据**：该表 2026-09-27 才建，现存行都不到 30 天。
--
-- 建表 migration（20260927120000）里那些「90 天」是历史记录，不回改已提交的文件。

CREATE OR REPLACE FUNCTION public.cleanup_client_error_logs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.client_error_logs
   WHERE created_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

-- CREATE OR REPLACE 本身不改 ACL（原有的 revoke 会保留），这一句只是让「谁能执行」
-- 在这个文件里也读得出来，不依赖读者去翻建表 migration。
REVOKE ALL ON FUNCTION public.cleanup_client_error_logs() FROM PUBLIC, anon, authenticated;

-- 回滚：把函数体里的 '30 days' 改回 '90 days' 重新执行（没有表结构变更，无需卸排程）。

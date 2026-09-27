-- 客户端错误在线收集（pkuso-mp / pkuso-web 共用一张表）
--
-- 背景：排查「少数用户无法微信登录」时，服务端三层（Edge Function / auth / PostgREST）
-- 全部正常、无一条失败记录，而失败用户那边连请求都没到达——客户端侧的失败在两端都不可见。
-- 现有手段只有：Supabase 的 function_logs（只管服务端）、以及 mp 端要手动导出文件的
-- TARO_APP_SESSION_DIAG（默认关闭）。缺一个「用户那里出错 → 自动回到库里」的通道。
--
-- 契约：
-- - 任何人（含未登录）可写：登录前产生的错误同样要能上报。未登录时 auth.uid() 为 NULL，
--   故 user_id 为空；登录后由 default auth.uid() 自动带上，且 with check 保证无法伪造他人 id。
-- - 仅管理员可读（错误正文可能含页面路径与用户标识，不进普通用户视野）。
-- - 不给 update / delete：清理走 cleanup_client_error_logs()（SECURITY DEFINER），
--   不做行级删除入口。
--
-- 容量与滥用（免费计划 500MB，故此处按 90 天保留设计）：
-- - 单条上限由 client_error_logs_len_check 与 detail 的 4096 字节上限共同约束，
--   估算约 1KB/行（含索引摊销）。
-- - anon 可写意味着理论上可被灌数据；行级无法限流，靠「字段上限 + 90 天清理 + 体积监控」
--   兜底。客户端侧另有按 (event,message) 指纹的去重限流（见 pkuso-mp src/lib/error-report.ts），
--   它防的是「循环报错把库写爆」这一最坏场景，不是恶意灌入。

CREATE TABLE public.client_error_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 登录后自动归属本人；未登录（登录前错误）为 NULL
  user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  level text NOT NULL DEFAULT 'error',
  -- 'mp' | 'web'
  source text NOT NULL,
  -- 稳定错误标识（如 'wechat_login' / 'unhandled_rejection'），便于聚合
  event text NOT NULL,
  message text,
  -- 上下文：页面路径、错误码、errMsg 等
  detail jsonb,
  app_version text,
  platform text,
  page text,
  CONSTRAINT client_error_logs_level_check CHECK (level IN ('error', 'warn', 'info')),
  CONSTRAINT client_error_logs_len_check CHECK (
    char_length(source) <= 16
    AND char_length(event) <= 64
    AND char_length(COALESCE(message, '')) <= 500
    AND char_length(COALESCE(app_version, '')) <= 32
    AND char_length(COALESCE(platform, '')) <= 64
    AND char_length(COALESCE(page, '')) <= 128
  ),
  -- 防单条膨胀：小程序里把整个响应体塞进 detail 是很容易发生的事
  CONSTRAINT client_error_logs_detail_size_check CHECK (
    detail IS NULL OR pg_column_size(detail) <= 4096
  )
);

-- 仅两个索引：一个给 90 天清理用，一个给「按人查」。索引自身也占空间，不建第三个。
CREATE INDEX client_error_logs_created_at_idx ON public.client_error_logs (created_at);
CREATE INDEX client_error_logs_user_created_idx ON public.client_error_logs (user_id, created_at DESC);

ALTER TABLE public.client_error_logs ENABLE ROW LEVEL SECURITY;

-- 写入放开给 anon：登录前的错误（如 wx.login 失败）也必须能上报。
-- with check 把 user_id 钉死在 auth.uid() 上：未登录时两者同为 NULL，登录后必须相等，
-- 因此客户端无法把错误记到别人名下。
CREATE POLICY "client_error_logs: 任何人可写入" ON public.client_error_logs
  FOR INSERT TO anon, authenticated
  WITH CHECK (user_id IS NOT DISTINCT FROM (SELECT auth.uid()));

CREATE POLICY "client_error_logs: 管理员可读" ON public.client_error_logs
  FOR SELECT TO authenticated
  USING ((SELECT is_admin()));

-- 表级权限与 RLS 是两道独立的门：anon 默认没有这张新表的 INSERT 权限，
-- 不显式 grant 的话 RLS 放行也写不进去。
GRANT INSERT ON public.client_error_logs TO anon, authenticated;
GRANT SELECT ON public.client_error_logs TO authenticated;

-- 90 天清理。用 SECURITY DEFINER 是因为 delete 不开放给任何客户端角色。
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
   WHERE created_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_client_error_logs() FROM PUBLIC, anon, authenticated;

-- 调度：pg_cron 尚未安装（线上 pg_extension 里没有）。这里尽力而为地装上并排程，
-- 失败只告警不阻断——表与清理函数本身可用，最坏情况是清理要手动/后续补调度，
-- 而 90 天内的量级远不足以撑爆免费额度。
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    CREATE EXTENSION pg_cron;
  END IF;
  PERFORM cron.schedule(
    'cleanup-client-error-logs',
    '17 4 * * *',
    $job$SELECT public.cleanup_client_error_logs()$job$
  );
  RAISE NOTICE 'client_error_logs 清理任务已排程（每日 04:17）';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_cron 不可用，client_error_logs 的 90 天清理未自动排程：%', SQLERRM;
END
$do$;

-- 回滚：DROP TABLE public.client_error_logs; DROP FUNCTION public.cleanup_client_error_logs();
-- （若 cron 任务已建：SELECT cron.unschedule('cleanup-client-error-logs');）

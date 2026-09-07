-- 合并 dataSync 轮询的 5 个查询为 1 个 RPC 调用
-- 返回各表最新版本时间戳 + 未读通知数，减少 HTTP 请求
CREATE OR REPLACE FUNCTION public.check_data_versions()
RETURNS JSONB
LANGUAGE SQL STABLE
AS $$
  SELECT jsonb_build_object(
    'rehearsals', (SELECT updated_at FROM public.rehearsals ORDER BY updated_at DESC LIMIT 1),
    'announcements', (SELECT created_at FROM public.announcements ORDER BY created_at DESC LIMIT 1),
    'leave', (SELECT updated_at FROM public.leave_requests ORDER BY updated_at DESC LIMIT 1),
    'post', (SELECT created_at FROM public.posts WHERE is_locked = false ORDER BY created_at DESC LIMIT 1),
    'notifications_unread', (SELECT count(*)::int FROM public.notifications WHERE read_at IS NULL)
  );
$$;

-- 授予 authenticated 角色调用权限
GRANT EXECUTE ON FUNCTION public.check_data_versions() TO authenticated;

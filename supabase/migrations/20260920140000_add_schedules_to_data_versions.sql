-- 添加 schedules 到 check_data_versions RPC 函数
-- 用于 dataSync 30s 轮询检测 schedules 表变化
-- 使用 created_at 因为 schedules 表无 updated_at 列

CREATE OR REPLACE FUNCTION public.check_data_versions()
RETURNS JSONB
LANGUAGE SQL STABLE
AS $$
  SELECT jsonb_build_object(
    'rehearsals', (SELECT updated_at FROM public.rehearsals ORDER BY updated_at DESC LIMIT 1),
    'announcements', (SELECT created_at FROM public.announcements ORDER BY created_at DESC LIMIT 1),
    'leave', (SELECT updated_at FROM public.leave_requests ORDER BY updated_at DESC LIMIT 1),
    'post', (SELECT created_at FROM public.posts WHERE is_locked = false ORDER BY created_at DESC LIMIT 1),
    'notifications_unread', (SELECT count(*)::int FROM public.notifications WHERE read_at IS NULL),
    'schedules', (SELECT created_at FROM public.schedules ORDER BY created_at DESC LIMIT 1)
  );
$$;

-- 授予 authenticated 角色调用权限
GRANT EXECUTE ON FUNCTION public.check_data_versions() TO authenticated;
-- 添加 reactions 到 check_data_versions RPC 函数
-- 用途：dataSync 每 30s 的心跳检测 member_reactions 表变化（成员点赞/送花计数），
-- 客户端据此静默刷新花名册与成员详情页上的计数。
-- 版本取 updated_at：add_member_reactions 每次成功累加都会刷新该列。

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
    'schedules', (SELECT created_at FROM public.schedules ORDER BY created_at DESC LIMIT 1),
    'reactions', (SELECT max(updated_at) FROM public.member_reactions)
  );
$$;

-- 授予 authenticated 角色调用权限
GRANT EXECUTE ON FUNCTION public.check_data_versions() TO authenticated;

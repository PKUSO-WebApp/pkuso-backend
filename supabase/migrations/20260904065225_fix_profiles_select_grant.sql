-- 授予 authenticated 角色对 profiles 表的 SELECT 权限
-- profiles_roster 视图使用 SECURITY INVOKER，需要调用者有底层表的 SELECT 权限
GRANT SELECT ON public.profiles TO authenticated;

-- 个人资料自我更新需要 UPDATE 权限；.select('id') 的 RETURNING 需要 id 列的 SELECT 权限。
-- 表级 SELECT 仍对 authenticated 撤销（敏感列只读经 profiles_roster 视图），仅开放 id 供 RETURNING。
GRANT UPDATE ON public.profiles TO authenticated;
GRANT SELECT (id) ON public.profiles TO authenticated;

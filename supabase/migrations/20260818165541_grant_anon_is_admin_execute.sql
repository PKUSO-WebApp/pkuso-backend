-- 修正：anon 查询 profiles_roster 需要 is_admin() 的 EXECUTE 权限（Issue #193）
--
-- 背景：视图 profiles_roster 的 WHERE/CASE 调用 is_admin()（SECURITY DEFINER，
-- 仅返回 boolean，无数据泄露）。原 EXECUTE 仅授予 authenticated（最小权限原则），
-- anon 经视图查询报 permission denied for function is_admin。
-- 授予 anon EXECUTE 是安全的：函数体只判断 auth.uid() 的 role，无参数、无数据输出。

BEGIN;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;

COMMIT;

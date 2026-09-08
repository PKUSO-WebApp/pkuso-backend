-- 修正：dev 环境函数 PUBLIC EXECUTE 授权导致 anon 仍可调用
--
-- 背景：20260908100000 中 REVOKE FROM anon 只移除了显式 anon 授权，
-- 但 dev 环境的函数还存在 PUBLIC EXECUTE 授权（{=X/postgres}），
-- 该授权允许所有角色（含 anon）执行函数。prod 环境无此 PUBLIC 授权。
--
-- 本次迁移：
--   1. REVOKE EXECUTE ... FROM PUBLIC 移除 PUBLIC 授权
--   2. 重新 GRANT EXECUTE ... TO authenticated 保证已登录用户可调用
--   3. 保留 is_admin 的 anon 权限（登录页需要）
--
-- 影响：
--   - anon 将无法调用 12 个 SECURITY DEFINER 函数（对齐 prod）
--   - authenticated 角色正常调用不受影响

BEGIN;

-- 移除 PUBLIC 授权并重新授予 authenticated（12 个函数，排除 is_admin）

REVOKE EXECUTE ON FUNCTION public.cancel_leave_on_sign_in(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_leave_on_sign_in(bigint) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.check_email_taken(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_email_taken(text, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.check_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_invitation_code(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_my_profile_entry() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_profile_entry() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_my_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_session() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.guard_leave_request_after_sign_in() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_leave_request_after_sign_in() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.guard_member_leave_request_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_member_leave_request_update() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.sign_in_attendance_location(bigint, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_in_attendance_location(bigint, double precision, double precision, double precision) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.sync_profile_to_auth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_profile_to_auth() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.touch_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_session() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.verify_and_use_invitation_code(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_and_use_invitation_code(text, uuid) TO authenticated;

COMMIT;

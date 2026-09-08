-- 修正：dev 环境 anon 角色对 SECURITY DEFINER 函数的多余 EXECUTE 权限
--
-- 背景：dev 环境从 prod 同步时（sync_from_prod stub migrations），未正确复制函数的
-- 角色权限设置，导致 anon 角色可以调用 12 个本应仅限 authenticated 的函数。
-- prod 环境已正确配置：仅 is_admin() 允许 anon 调用（登录页使用），
-- 其余函数 REVOKE FROM anon + GRANT TO authenticated。
--
-- 本次迁移：对齐 prod 的权限配置，REVOKE anon 对 12 个函数的 EXECUTE 权限。
-- 不影响 authenticated/service_role 角色的正常调用。
--
-- 安全分析（逐函数）：
--   - 触发器函数（4个）：handle_new_user / sync_profile_to_auth /
--     guard_leave_request_after_sign_in / guard_member_leave_request_update
--     → SECURITY DEFINER + REVOKE anon 是标准模式，触发器由数据库调用不受此影响
--   - 数据查询函数（3个）：get_my_profile_entry / get_my_session / touch_session
--     → 通过 auth.uid() 限制仅返回当前用户数据，REVOKE anon 防止未登录访问
--   - 业务操作函数（5个）：cancel_leave_on_sign_in / sign_in_attendance_location /
--     verify_and_use_invitation_code / check_email_taken / check_invitation_code
--     → 均有 auth.uid() 校验或参数校验，REVOKE anon 是最小权限原则
--
-- 影响：
--   - 涉及函数：12 个 SECURITY DEFINER 函数
--   - 涉及 RLS：无变更
--   - 涉及 Edge Functions：无变更
--   - 前端影响：无（所有函数均需 JWT 认证调用）

BEGIN;

-- cancel_leave_on_sign_in: 取消请假请求，需认证用户
REVOKE EXECUTE ON FUNCTION public.cancel_leave_on_sign_in(bigint) FROM anon;

-- check_email_taken: 检查邮箱是否已注册，需认证用户
REVOKE EXECUTE ON FUNCTION public.check_email_taken(text, uuid) FROM anon;

-- check_invitation_code: 检查邀请码有效性，需认证用户
REVOKE EXECUTE ON FUNCTION public.check_invitation_code(text) FROM anon;

-- get_my_profile_entry: 获取个人档案，需认证用户
REVOKE EXECUTE ON FUNCTION public.get_my_profile_entry() FROM anon;

-- get_my_session: 获取会话信息，需认证用户
REVOKE EXECUTE ON FUNCTION public.get_my_session() FROM anon;

-- guard_leave_request_after_sign_in: 请假签到守卫触发器，仅数据库调用
REVOKE EXECUTE ON FUNCTION public.guard_leave_request_after_sign_in() FROM anon;

-- guard_member_leave_request_update: 请假更新守卫触发器，仅数据库调用
REVOKE EXECUTE ON FUNCTION public.guard_member_leave_request_update() FROM anon;

-- handle_new_user: 新用户注册触发器，仅数据库调用
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;

-- sign_in_attendance_location: 定位签到，需认证用户
REVOKE EXECUTE ON FUNCTION public.sign_in_attendance_location(bigint, double precision, double precision, double precision) FROM anon;

-- sync_profile_to_auth: 同步档案到 Auth 触发器，仅数据库调用
REVOKE EXECUTE ON FUNCTION public.sync_profile_to_auth() FROM anon;

-- touch_session: 触碰会话，需认证用户
REVOKE EXECUTE ON FUNCTION public.touch_session() FROM anon;

-- verify_and_use_invitation_code: 验证并使用邀请码，需认证用户
REVOKE EXECUTE ON FUNCTION public.verify_and_use_invitation_code(text, uuid) FROM anon;

COMMIT;

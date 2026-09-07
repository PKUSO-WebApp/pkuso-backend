-- 个人信息隐私隐藏：数据层掩码（Issue #193 对抗修复）
--
-- 背景：profiles 的 SELECT 策略（"profiles: 所有人可读已通过用户"，20260814130000 管理）
-- 对 public 全列开放、无列级限制。上一轮仅在展示层掩码 hide_email/hide_phone/hide_join_date
-- 三开关，成员/匿名仍可直查他人 email/phone_number/join_date 原值，形同虚设。
-- 本迁移从数据层封堵：
--   1) REVOKE 三敏感列的 SELECT 于 anon/authenticated（PostgREST 客户端角色），
--      直查表返回 permission denied；
--   2) 新建 SECURITY DEFINER 视图 profiles_roster 作为统一读取入口：行过滤等价原
--      SELECT 策略（status='approved' OR auth.uid()=id OR is_admin()），敏感三列按
--      身份掩码（本人/管理员/未开启隐藏 → 原值，否则 NULL）；
--   3) 列级 ACL 一旦存在即遮蔽表级授权（pg_attribute.attacl 非空后不再回退
--      pg_class.relacl），故需对 service_role / authenticated 逐列补授，保持
--      service role 路径（api routes/e2e）与本人编辑（INSERT/UPDATE 自己的档案）
--      能力不变，REVOKE 实际只影响 anon/authenticated 的 SELECT；
--   4) 视图 SELECT 授权 anon/authenticated：非敏感列读取行为与原策略一致。
--
-- 视图列清单（profiles_roster）：
--   id, email, full_name, instrument, status, role, college,
--   phone_number, join_date, created_at, is_section_leader,
--   hide_email, hide_phone, hide_join_date
--   其中 email / phone_number / join_date 为 CASE 掩码列。
--
-- 回滚：DROP VIEW public.profiles_roster; 后恢复表级授权（见仓库 docs/issue-193 相关记录），
--   GRANT SELECT ON public.profiles TO anon, authenticated; 即可还原全列开放。

BEGIN;

-- ==================== 1. 收紧敏感列 SELECT 权限 ====================
-- 仅 anon / authenticated 失去 SELECT；service_role 与 postgres（表所有者）不受影响
REVOKE SELECT (email, phone_number, join_date) ON public.profiles FROM anon, authenticated;

-- ==================== 2. 补偿列级授权 ====================
-- attacl 遮蔽 relacl：一旦存在列级 ACL，表级授权对这三列失效，需逐列补授保持既有能力
GRANT SELECT, INSERT, UPDATE (email, phone_number, join_date) ON public.profiles TO service_role;
GRANT INSERT, UPDATE (email, phone_number, join_date) ON public.profiles TO authenticated;

-- ==================== 3. 统一读取入口视图 ====================
-- security definer（security_invoker=off）：视图所有者 postgres 直读原表，不受 RLS 限制，
-- 因此行过滤与列掩码全部内置于视图；auth.uid()/is_admin() 读取的是会话 claim 与表数据，
-- 与执行角色无关，PostgREST 客户端身份在此正确生效
CREATE VIEW public.profiles_roster
WITH (security_invoker = off) AS
SELECT
  profiles.id,
  CASE
    WHEN auth.uid() = profiles.id OR is_admin() OR NOT profiles.hide_email
    THEN profiles.email
    ELSE NULL
  END AS email,
  profiles.full_name,
  profiles.instrument,
  profiles.status,
  profiles.role,
  profiles.college,
  CASE
    WHEN auth.uid() = profiles.id OR is_admin() OR NOT profiles.hide_phone
    THEN profiles.phone_number
    ELSE NULL
  END AS phone_number,
  CASE
    WHEN auth.uid() = profiles.id OR is_admin() OR NOT profiles.hide_join_date
    THEN profiles.join_date
    ELSE NULL
  END AS join_date,
  profiles.created_at,
  profiles.is_section_leader,
  profiles.hide_email,
  profiles.hide_phone,
  profiles.hide_join_date
FROM public.profiles
WHERE profiles.status = 'approved'::"profileStatus"
   OR auth.uid() = profiles.id
   OR is_admin();

COMMENT ON VIEW public.profiles_roster IS '成员花名册统一读取视图（Issue #193）：敏感列 email/phone_number/join_date 按身份掩码（本人/管理员/未开启隐藏 → 原值，否则 NULL），行过滤等价原 profiles SELECT 策略';

-- ==================== 4. 视图读取授权 ====================
-- anon 保持"所有人可读已通过用户"语义（仅敏感列被掩码），authenticated 含 admin
GRANT SELECT ON public.profiles_roster TO anon, authenticated;

COMMIT;

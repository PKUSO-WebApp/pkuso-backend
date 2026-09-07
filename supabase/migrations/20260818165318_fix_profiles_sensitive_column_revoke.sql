-- 修正：profiles 敏感列 SELECT 收紧方式（Issue #193 数据层掩码）
--
-- 背景：20260818165128 中 REVOKE SELECT (email, phone_number, join_date) ON profiles
-- FROM anon, authenticated 实际无效——PostgreSQL 列权限与表权限按 grantee 取并集，
-- anon/authenticated 的表级 SELECT（GRANT ALL ON ALL TABLES 遗留）依然赋予其读敏感列能力，
-- 该 REVOKE 只是 no-op（attacl 未产生负向条目，实证 has_column_privilege 仍为 true）。
--
-- 正确做法：撤销表级 SELECT 后，仅对非敏感列做列级补授。敏感三列（email / phone_number /
-- join_date）无任何列级 SELECT 授权 → anon/authenticated 直查返回 permission denied；
-- 非敏感列（含 hide_* 三开关）保持原读取行为不变（花名册、join 路径、useAuth 身份字段）。
--
-- service_role：表级 ALL 依然有效（表级 REVOKE 只针对 anon/authenticated），且补授敏感列
-- 显式列级 SELECT/INSERT（防未来表级 REVOKE 误伤），service role 路径（api routes/e2e）不变。
-- authenticated：列级 UPDATE 已在 20260818165128 授予（attacl 现存 authenticated=w），
-- 本人编辑 email/phone_number/join_date 能力保留。

BEGIN;

-- ==================== 1. 撤销表级 SELECT（仅 anon/authenticated） ====================
REVOKE SELECT ON public.profiles FROM anon, authenticated;

-- ==================== 2. 非敏感列逐列补授 ====================
-- 含 hide_email/hide_phone/hide_join_date 开关（前端 maskedValue 逻辑读取），
-- 不含 email/phone_number/join_date
GRANT SELECT (id, full_name, instrument, status, role, college, created_at,
              is_section_leader, hide_email, hide_phone, hide_join_date)
ON public.profiles TO anon, authenticated;

-- ==================== 3. service_role 敏感列显式列级授权 ====================
-- 语法说明：PG 列级 GRANT 需每个权限单独带列列表（GRANT SELECT (cols), INSERT (cols), ...）
GRANT SELECT (email, phone_number, join_date),
      INSERT (email, phone_number, join_date),
      UPDATE (email, phone_number, join_date)
ON public.profiles TO service_role;

COMMIT;

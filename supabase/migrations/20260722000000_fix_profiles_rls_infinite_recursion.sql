-- 迁移说明：修复 profiles / schedules 表 admin RLS 策略的无限递归 bug，
--           并补全 is_admin() SECURITY DEFINER 函数的访问控制（REVOKE）。
--
-- 背景：
--   1. 20260721180000_add_admin_rls_policies.sql 中的 profiles_admin_all 策略
--      在 USING 子句中查询 profiles 表本身 → RLS 自引用 → Postgres 抛出
--      "infinite recursion detected in policy for relation profiles"。
--      schedules_admin_all 也在 schedules 上查询 profiles，间接触发 profiles RLS，
--      同样会递归。
--   2. 20260721200000_fix_admin_rls_recursion.sql 已用 is_admin() SECURITY DEFINER
--      函数打破递归，但遗漏了 REVOKE ALL FROM PUBLIC, ANONYMOUS ——
--      Postgres 默认对新建函数 GRANT EXECUTE TO PUBLIC，意味着 anon 角色也能
--      直接调用 is_admin() 探测任意 user_id 是否为 admin（信息泄露），属于
--      安全漏洞。本迁移补全这一修复。
--
-- 修复方案（与 20260721200000 的差异）：
--   1. CREATE OR REPLACE FUNCTION public.is_admin() —— 幂等替换远端已有函数，
--      函数体不变（STABLE + SECURITY DEFINER + 固定 search_path）。
--   2. 显式 REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, ANONYMOUS，
--      关闭默认的 PUBLIC EXECUTE 权限。
--   3. GRANT EXECUTE TO authenticated —— 只允许已登录用户调用
--      （RLS 策略在用户会话上下文中执行此函数）。
--   4. DROP POLICY IF EXISTS + CREATE POLICY 重建 profiles_admin_all 与
--      schedules_admin_all 两条策略，USING/WITH CHECK 改为 public.is_admin()。
--      幂等：远端已存在的策略会被 DROP 后重建，语义不变但确保形态一致。
--   5. profiles_self 与 schedules_self 保持不变（无递归问题，不动）。
--
-- 幂等性：
--   - CREATE OR REPLACE FUNCTION：可重复执行。
--   - DROP POLICY IF EXISTS + CREATE POLICY：可重复执行。
--   - REVOKE / GRANT：可重复执行。
--   整个文件可在已应用 20260721200000 的远端安全重放。
--
-- 回滚说明（down 方向）：
--   -- 不建议回滚到递归策略（会重新触发 infinite recursion bug）。
--   -- 如必须回滚到 20260721200000 的状态（保留 is_admin 但不 REVOKE）：
--   GRANT EXECUTE ON FUNCTION public.is_admin() TO PUBLIC;
--   -- 如彻底回滚到 20260721180000 的递归策略（会导致递归 bug 重现，谨慎）：
--   DROP POLICY IF EXISTS profiles_admin_all ON profiles;
--   DROP POLICY IF EXISTS schedules_admin_all ON schedules;
--   CREATE POLICY profiles_admin_all ON profiles FOR ALL USING (
--     EXISTS (SELECT 1 FROM profiles p
--             WHERE p.id = (select auth.uid()) AND p.role = 'admin'::"profileRole"));
--   CREATE POLICY schedules_admin_all ON schedules FOR ALL USING (
--     EXISTS (SELECT 1 FROM profiles p
--             WHERE p.id = (select auth.uid()) AND p.role = 'admin'::"profileRole"));
--   DROP FUNCTION IF EXISTS public.is_admin();
--
-- 中途状态推演：
--   本迁移在单事务中执行：CREATE OR REPLACE FUNCTION → REVOKE → GRANT →
--   DROP POLICY → CREATE POLICY（×2）。Postgres DDL 事务保证全部成功或全部回滚，
--   不存在中间残留状态。若执行失败回滚，远端 schema 与本文件落地前完全一致，
--   无需人工清理。

BEGIN;

-- ==================== 1. SECURITY DEFINER 函数 is_admin() ====================
-- 以定义者（postgres，绕过 RLS）权限查询 profiles，避免在 RLS 策略中
-- 直接查询 profiles 表导致的自引用递归。
-- STABLE：函数只读，结果在同一事务内稳定。
-- SET search_path = public：固定搜索路径，防止 search_path 劫持。
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'::"profileRole"
  );
$$;

-- 关键安全修复：撤销默认的 PUBLIC EXECUTE 权限
-- Postgres 默认对新建函数 GRANT EXECUTE TO PUBLIC，意味着 anon 角色也能调用
-- is_admin() 探测任意会话是否为 admin。REVOKE 后只有显式 GRANT 的角色可调用。
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM anon;

-- 只允许已登录用户调用（RLS 策略在 authenticated 会话上下文中执行此函数）
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ==================== 2. profiles 表 admin 策略重建 ====================
-- 幂等：远端若已有同名策略，先 DROP 再 CREATE，确保 USING/WITH CHECK 形态一致
DROP POLICY IF EXISTS profiles_admin_all ON profiles;

CREATE POLICY profiles_admin_all
ON profiles
FOR ALL
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- ==================== 3. schedules 表 admin 策略重建 ====================
DROP POLICY IF EXISTS schedules_admin_all ON schedules;

CREATE POLICY schedules_admin_all
ON schedules
FOR ALL
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMIT;

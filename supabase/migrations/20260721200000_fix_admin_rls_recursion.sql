-- 迁移说明：修复 profiles / schedules 表 admin RLS 策略的无限递归 bug
-- 问题根因：
--   profiles_admin_all 策略的 USING 子句在 profiles 表上又查询 profiles 本身，
--   触发 RLS 自引用，Postgres 抛出 "infinite recursion detected in policy for relation profiles"。
--   schedules_admin_all 策略在 schedules 上查询 profiles，会触发 profiles 的 RLS，
--   间接产生同样的递归。
-- 修复方案：
--   1. 新建 SECURITY DEFINER 函数 public.is_admin()，函数体以定义者（postgres）权限
--      查询 profiles，绕过 RLS，打破递归链。
--   2. 删除并重建 profiles_admin_all 与 schedules_admin_all 两条策略，
--      USING 子句改为直接调用 public.is_admin()。
--   3. profiles_self 与 schedules_self 保持不变（无递归问题）。
-- 幂等性：使用 CREATE OR REPLACE FUNCTION、DROP POLICY IF EXISTS，可重复执行。
-- 回滚说明（down 方向）：
--   DROP POLICY IF EXISTS profiles_admin_all ON profiles;
--   DROP POLICY IF EXISTS schedules_admin_all ON schedules;
--   -- 恢复旧递归策略（仅作回滚参考，回滚后会重新触发递归 bug，请谨慎）
--   CREATE POLICY profiles_admin_all ON profiles FOR ALL USING (
--     EXISTS (SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND p.role = 'admin'::"profileRole"));
--   CREATE POLICY schedules_admin_all ON schedules FOR ALL USING (
--     EXISTS (SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND p.role = 'admin'::"profileRole"));
--   DROP FUNCTION IF EXISTS public.is_admin();
-- 中途状态推演：
--   本迁移在单事务中执行：CREATE OR REPLACE FUNCTION → DROP POLICY → CREATE POLICY。
--   事务保证函数与策略要么全部成功要么全部回滚，不存在中间残留状态。
--   若执行失败回滚，远端 schema 与本文件落地前完全一致，无需人工清理。

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

-- 允许已登录用户调用（RLS 策略会在用户会话上下文中执行此函数）
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ==================== 2. profiles 表 admin 策略重建 ====================
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

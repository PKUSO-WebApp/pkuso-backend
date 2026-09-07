-- 迁移说明：修复 profiles 表 "profiles: 管理员可更新所有" RLS 策略的无限递归（Issue #118）。
--
-- 背景：
--   线上策略 "profiles: 管理员可更新所有"（FOR UPDATE TO public）的 USING 表达式为
--   内联 EXISTS 子查询：
--     EXISTS (SELECT 1 FROM profiles profiles_1
--             WHERE profiles_1.id = auth.uid() AND profiles_1.role = 'admin'::"profileRole")
--   该子查询引用 profiles 表自身。RLS 策略中的子查询访问 profiles 时同样受 RLS 约束，
--   规划器检测到同关系递归 → 抛出 42P17 "infinite recursion detected in policy for
--   relation profiles"。任何 member 的 UPDATE（如编辑个人信息）在策略求值时触发
--   递归，返回 500。
--
-- 修复方案：
--   改用 public.is_admin()（SECURITY DEFINER、owner=postgres、STABLE、
--   SET search_path TO 'public'，内部查询 public.profiles 以定义者权限执行，
--   绕过 RLS，无递归）。该函数由 20260721200000 / 20260722000000 系列 migration
--   管理，已存在且 EXECUTE 仅授予 authenticated（anon 不可探测）。
--   USING (is_admin()) 的求值上下文为策略所在角色的会话（authenticated），
--   满足函数调用权限。
--
-- 幂等性：DROP POLICY IF EXISTS + CREATE POLICY，可重复执行。
--
-- 回滚说明（down 方向）：
--   恢复到内联 EXISTS 子查询形态（注意：会重新触发 42P17 递归 bug，仅作记录）：
--   DROP POLICY IF EXISTS "profiles: 管理员可更新所有" ON profiles;
--   CREATE POLICY "profiles: 管理员可更新所有" ON profiles
--     FOR UPDATE TO public
--     USING (EXISTS (SELECT 1 FROM profiles profiles_1
--             WHERE profiles_1.id = auth.uid()
--               AND profiles_1.role = 'admin'::"profileRole"));
--
-- 中途状态推演：
--   本迁移在单事务中执行：DROP POLICY + CREATE POLICY。
--   Postgres DDL 事务保证全部成功或全部回滚，不存在中间残留状态。

BEGIN;

-- ==================== 1. 重建"管理员可更新所有"策略 ====================
-- 原 USING 内联 EXISTS 子查询引用 profiles 自身 → 同关系递归（42P17）
-- 改用 is_admin()（SECURITY DEFINER，内部查询绕过 RLS，打破递归）
DROP POLICY IF EXISTS "profiles: 管理员可更新所有" ON profiles;

CREATE POLICY "profiles: 管理员可更新所有"
ON profiles
FOR UPDATE
TO public
USING (is_admin());

COMMIT;

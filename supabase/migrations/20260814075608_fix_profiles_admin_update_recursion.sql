-- 修复 profiles RLS 策略无限递归（Issue #118）
-- 原 USING 内联 EXISTS 子查询引用 profiles 自身，规划器检测同关系递归（42P17）
-- 改用 is_admin()（SECURITY DEFINER，内部查询绕过 RLS）
BEGIN;
DROP POLICY IF EXISTS "profiles: 管理员可更新所有" ON profiles;
CREATE POLICY "profiles: 管理员可更新所有" ON profiles
  FOR UPDATE TO public
  USING (is_admin());
COMMIT;

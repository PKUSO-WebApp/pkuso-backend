-- 迁移说明：修复 20260722000000 引入的 anon 角色查询 profiles 表失败的回归。
--
-- 回归根因：
--   20260722000000 在 is_admin() 上执行了 REVOKE ALL FROM PUBLIC, anon，
--   只保留 GRANT EXECUTE TO authenticated。这是必要的安全加固（防止 anon 探测），
--   但 profiles_admin_all 与 schedules_admin_all 策略没有加 TO authenticated 子句，
--   默认对 PUBLIC（含 anon）生效。RLS 评估时 anon 角色会调用 is_admin()，
--   触发 "permission denied for function is_admin" 错误，导致 anon 查询 profiles 表
--   整体失败 —— 即使其他 permissive 策略（如 "所有人可读已通过用户"）本应允许
--   anon 读取 status='approved' 的 profiles。
--
--   schedules 表侥幸未受影响，因为存在 USING(true) 的 "Anyone can view all schedules"
--   策略，Postgres 优化器对其短路；但这是优化器行为不可依赖，且对 INSERT/UPDATE/DELETE
--   不生效，仍存在潜在风险。
--
-- 修复方案：
--   1. DROP POLICY profiles_admin_all + 重建为 `TO authenticated`，仅对 authenticated
--      角色评估 is_admin()，anon 不再触发该策略。
--   2. DROP POLICY schedules_admin_all + 重建为 `TO authenticated`，对称修复，
--      避免 schedules 表未来因策略调整而踩同样的坑。
--   3. is_admin() 函数本身的 REVOKE/GRANT 保持不变（仍只 authenticated 可调用）。
--   4. profiles_self 与 schedules_self 保持不变。
--
--   这也符合 Supabase 安全建议：`TO authenticated alone` 是 authentication without
--   authorization（BOLA / IDOR），正确做法是 `TO authenticated` + USING 中的所有权
--   谓词。我们的 USING 已有 is_admin() 谓词，加上 TO authenticated 完美。
--
-- 幂等性：DROP POLICY IF EXISTS + CREATE POLICY，可重复执行。
--
-- 回滚说明（down 方向）：
--   -- 回滚到 20260722000000 的状态（会重新引入 anon 角色查询 profiles 失败的回归，
--   -- 仅作参考，不建议回滚）：
--   DROP POLICY IF EXISTS profiles_admin_all ON profiles;
--   DROP POLICY IF EXISTS schedules_admin_all ON schedules;
--   CREATE POLICY profiles_admin_all ON profiles FOR ALL
--     USING (public.is_admin()) WITH CHECK (public.is_admin());
--   CREATE POLICY schedules_admin_all ON schedules FOR ALL
--     USING (public.is_admin()) WITH CHECK (public.is_admin());
--
-- 中途状态推演：
--   本迁移在单事务中执行：DROP POLICY × 2 + CREATE POLICY × 2。
--   Postgres DDL 事务保证全部成功或全部回滚，不存在中间残留状态。
--   若执行失败回滚，远端 schema 与本文件落地前完全一致（即 20260722000000 应用后的状态）。

BEGIN;

-- ==================== 1. profiles 表 admin 策略：加 TO authenticated ====================
DROP POLICY IF EXISTS profiles_admin_all ON profiles;

-- TO authenticated：仅 authenticated 角色评估此策略，anon 不再调用 is_admin()，
-- 避免权限错误连带导致 anon 查询 profiles 整体失败。
-- 注意：Postgres CREATE POLICY 语法要求 FOR 子句在 TO 子句之前。
CREATE POLICY profiles_admin_all
ON profiles
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- ==================== 2. schedules 表 admin 策略：对称修复 ====================
DROP POLICY IF EXISTS schedules_admin_all ON schedules;

CREATE POLICY schedules_admin_all
ON schedules
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMIT;

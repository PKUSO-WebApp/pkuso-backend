-- 迁移说明：补齐 profiles 表 4 条中文名 RLS 策略的 migration 历史（migration 与线上 DB 漂移修复）。
--
-- 背景：
--   线上 DB 存在 4 条中文名 RLS 策略，但从未写入 migration 历史（推测由 SQL Editor
--   手动创建），导致 `supabase db push` / db reset 重建的 schema 与线上不一致：
--     1. "profiles: 可插入自己的档案"     INSERT  TO authenticated
--     2. "profiles: 可更新自己的档案"     UPDATE  TO authenticated
--     3. "profiles: 所有人可读已通过用户" SELECT  TO public
--     4. "profiles: 管理员可更新所有"     UPDATE  TO public
--   另两条（profiles_admin_all、profiles_self）已由 20260721180000 系列 migration 管理，本文件不动。
--
-- 定义以线上 pg_policies 实际存储为准（roles 已逐一核对）：
--   - 策略 3、4 的 roles 为 {public}（TO public），非 authenticated。
--   - 策略 4 使用内联子查询（profiles_1 自引用 EXISTS），而非 is_admin() 函数，
--     与线上定义保持一致。该子查询作为 UPDATE USING 谓词执行时触发 SELECT 策略
--     （permissive 策略 OR 合并），不构成无限递归。
--   - 枚举比较显式转型：'approved'::"profileStatus"、'admin'::"profileRole"。
--
-- 幂等性：DROP POLICY IF EXISTS + CREATE POLICY，可重复执行；线上已存在同名策略时
--   DROP 后按相同定义重建，语义不变。
--
-- 回滚说明（down 方向）：
--   DROP POLICY IF EXISTS "profiles: 可插入自己的档案" ON profiles;
--   DROP POLICY IF EXISTS "profiles: 可更新自己的档案" ON profiles;
--   DROP POLICY IF EXISTS "profiles: 所有人可读已通过用户" ON profiles;
--   DROP POLICY IF EXISTS "profiles: 管理员可更新所有" ON profiles;
--
-- 中途状态推演：
--   本迁移在单事务中执行：DROP POLICY × 4 + CREATE POLICY × 4。
--   Postgres DDL 事务保证全部成功或全部回滚，不存在中间残留状态。

BEGIN;

-- ==================== 1. 可插入自己的档案 ====================
-- 注册/首次登录时用户插入自己的档案行
DROP POLICY IF EXISTS "profiles: 可插入自己的档案" ON profiles;

CREATE POLICY "profiles: 可插入自己的档案"
ON profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);

-- ==================== 2. 可更新自己的档案 ====================
-- 用户只能更新自己的档案行
DROP POLICY IF EXISTS "profiles: 可更新自己的档案" ON profiles;

CREATE POLICY "profiles: 可更新自己的档案"
ON profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = id);

-- ==================== 3. 所有人可读已通过用户 ====================
-- 已登录用户可读 status='approved' 的档案（花名册等场景），且可读自己的档案行
DROP POLICY IF EXISTS "profiles: 所有人可读已通过用户" ON profiles;

CREATE POLICY "profiles: 所有人可读已通过用户"
ON profiles
FOR SELECT
TO public
USING ((status = 'approved'::"profileStatus") OR (auth.uid() = id));

-- ==================== 4. 管理员可更新所有 ====================
-- 管理员（role='admin'）可更新任意档案行；内联子查询定义与线上一致
DROP POLICY IF EXISTS "profiles: 管理员可更新所有" ON profiles;

CREATE POLICY "profiles: 管理员可更新所有"
ON profiles
FOR UPDATE
TO public
USING (
  EXISTS (
    SELECT 1
    FROM profiles profiles_1
    WHERE profiles_1.id = auth.uid()
      AND profiles_1.role = 'admin'::"profileRole"
  )
);

COMMIT;

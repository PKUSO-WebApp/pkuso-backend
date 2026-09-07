-- 迁移说明：为profiles和schedules表添加RLS策略，解决admin数据访问权限问题
-- 当前问题：admin页面使用浏览器端supabase客户端（anon key），受RLS约束，无法查看所有profiles和schedules
-- 变更内容：
-- 1. 为profiles表启用RLS并添加策略：
--    - 允许role为admin的用户查看和操作所有profiles
--    - 允许普通用户查看自己的profile
-- 2. 为schedules表启用RLS并添加策略：
--    - 允许role为admin的用户查看和操作所有schedules
--    - 允许普通用户查看和操作自己创建的schedules
-- 回滚说明：
-- DROP POLICY profiles_admin_all ON profiles;
-- DROP POLICY profiles_self ON profiles;
-- ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
-- DROP POLICY schedules_admin_all ON schedules;
-- DROP POLICY schedules_self ON schedules;
-- ALTER TABLE schedules DISABLE ROW LEVEL SECURITY;

BEGIN;

-- ==================== profiles表 RLS策略 ====================

-- 启用profiles表的RLS（如果尚未启用）
ALTER TABLE IF EXISTS profiles ENABLE ROW LEVEL SECURITY;

-- 策略1：允许admin角色查看和操作所有profiles
-- 使用 (select auth.uid()) 避免每行重复评估，提升性能
CREATE POLICY profiles_admin_all
ON profiles
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = (select auth.uid()) AND p.role = 'admin'::"profileRole"
  )
);

-- 策略2：允许普通用户查看自己的profile
-- 使用 (select auth.uid()) 避免每行重复评估，提升性能
CREATE POLICY profiles_self
ON profiles
FOR SELECT
USING (
  id = (select auth.uid())
);

-- ==================== schedules表 RLS策略 ====================

-- 启用schedules表的RLS（如果尚未启用）
ALTER TABLE IF EXISTS schedules ENABLE ROW LEVEL SECURITY;

-- 策略1：允许admin角色查看和操作所有schedules
-- 使用 (select auth.uid()) 避免每行重复评估，提升性能
CREATE POLICY schedules_admin_all
ON schedules
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = (select auth.uid()) AND p.role = 'admin'::"profileRole"
  )
);

-- 策略2：允许普通用户查看和操作自己创建的schedules
-- 使用 (select auth.uid()) 避免每行重复评估，提升性能
CREATE POLICY schedules_self
ON schedules
FOR ALL
USING (
  author_id = (select auth.uid())
);

COMMIT;
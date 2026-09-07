-- 迁移说明：优化admin RLS策略的性能，使用(select auth.uid())避免每行重复评估
-- 当前问题：之前的RLS策略使用auth.uid()会导致每行重复评估，产生性能警告
-- 修复内容：将auth.uid()替换为(select auth.uid())
-- 回滚说明：DROP POLICY profiles_admin_all ON profiles; DROP POLICY profiles_self ON profiles;
--           DROP POLICY schedules_admin_all ON schedules; DROP POLICY schedules_self ON schedules;
--           然后重新创建使用auth.uid()的策略

BEGIN;

-- ==================== profiles表 RLS策略优化 ====================

-- 删除旧策略
DROP POLICY IF EXISTS profiles_admin_all ON profiles;
DROP POLICY IF EXISTS profiles_self ON profiles;

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

-- ==================== schedules表 RLS策略优化 ====================

-- 删除旧策略
DROP POLICY IF EXISTS schedules_admin_all ON schedules;
DROP POLICY IF EXISTS schedules_self ON schedules;

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
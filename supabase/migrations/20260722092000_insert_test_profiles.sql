-- ============================================
-- 删除测试用户并重建 profiles 外键约束
-- 回滚说明: ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
-- 
-- 注意: 
--   1. profiles 表启用了 RLS,迁移时需要临时禁用以允许删除数据。
--   2. 测试用户没有对应的 auth.users 记录,需要先删除才能重建外键约束。
--   3. 本迁移在单事务中执行,若失败则所有状态自动恢复。
-- ============================================

BEGIN;

-- 临时禁用 RLS 以允许迁移删除数据
ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;

-- 删除所有测试用户（email 以 @example.com 结尾）
DELETE FROM profiles WHERE email LIKE '%@example.com';

-- 重建外键约束
ALTER TABLE profiles
ADD CONSTRAINT profiles_id_fkey
FOREIGN KEY (id) REFERENCES auth.users(id);

-- 重新启用 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

COMMIT;
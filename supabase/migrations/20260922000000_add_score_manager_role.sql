-- 添加 score_manager 角色到 profileRole 枚举
-- 必须在单独的 migration 中执行，因为 PostgreSQL 不允许在同一事务中使用刚添加的枚举值

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'profileRole' AND e.enumlabel = 'score_manager'
  ) THEN
    ALTER TYPE "profileRole" ADD VALUE 'score_manager';
  END IF;
END $$;

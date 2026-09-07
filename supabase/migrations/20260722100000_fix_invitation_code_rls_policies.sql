-- ============================================
-- 更新 invitation_codes 表的 RLS 策略，添加使用次数检查
-- 回滚说明: 
--   DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;
--   DROP POLICY IF EXISTS invitation_codes_authenticated_update ON invitation_codes;
--   CREATE POLICY invitation_codes_anon_update ON invitation_codes FOR UPDATE TO anon USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));
--   CREATE POLICY invitation_codes_authenticated_update ON invitation_codes FOR UPDATE TO authenticated USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));
-- 
-- 变更内容:
--   1. 更新 invitation_codes_anon_update 策略，添加 max_uses IS NULL OR used_count < max_uses 条件
--   2. 更新 invitation_codes_authenticated_update 策略，添加 max_uses IS NULL OR used_count < max_uses 条件
-- ============================================

BEGIN;

-- 删除旧的 anon UPDATE 策略
DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;

-- 创建新的 anon UPDATE 策略，添加使用次数检查
CREATE POLICY invitation_codes_anon_update
ON invitation_codes
FOR UPDATE
TO anon
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (max_uses IS NULL OR used_count < max_uses)
);

-- 删除旧的 authenticated UPDATE 策略
DROP POLICY IF EXISTS invitation_codes_authenticated_update ON invitation_codes;

-- 创建新的 authenticated UPDATE 策略，添加使用次数检查
CREATE POLICY invitation_codes_authenticated_update
ON invitation_codes
FOR UPDATE
TO authenticated
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (max_uses IS NULL OR used_count < max_uses)
);

COMMIT;
-- Migration: Fix invitation code atomic update and RLS policies
-- Issue: Fix TOCTOU race condition and used_by update RLS policy
-- Changes:
-- 1. Update invitation_codes_anon_update policy to check used_count < max_uses
-- 2. Update invitation_codes_authenticated_update_used_by policy to allow updating used_by regardless of used_count
-- Rollback:
--   DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;
--   DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;
--   CREATE POLICY invitation_codes_anon_update ON invitation_codes FOR UPDATE TO anon USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()) AND (max_uses IS NULL OR used_count < max_uses));
--   CREATE POLICY invitation_codes_authenticated_update_used_by ON invitation_codes FOR UPDATE TO authenticated USING (used = TRUE) WITH CHECK (used = TRUE);

BEGIN;

-- 更新 anon UPDATE 策略，添加使用次数检查（用于原子验证操作）
DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;

CREATE POLICY invitation_codes_anon_update
ON invitation_codes
FOR UPDATE
TO anon
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (max_uses IS NULL OR used_count < max_uses)
);

-- 更新 authenticated UPDATE 策略，允许在 used = TRUE 时更新 used_by
-- 移除对 used_count 的限制，因为注册成功后 used_count 可能已达到上限
DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;

CREATE POLICY invitation_codes_authenticated_update_used_by
ON invitation_codes
FOR UPDATE
TO authenticated
USING (
  used = TRUE
)
WITH CHECK (
  used = TRUE
);

-- 更新 authenticated UPDATE 策略，添加使用次数检查
DROP POLICY IF EXISTS invitation_codes_authenticated_update ON invitation_codes;

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
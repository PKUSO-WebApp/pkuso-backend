-- Migration: Fix invitation_codes RLS security vulnerabilities
-- Issue: #69
-- Changes:
--   1. DROP invitation_codes_authenticated_select — 防止普通成员枚举所有未使用邀请码（信息泄露）
--   2. DROP invitation_codes_authenticated_update — 防止普通成员随意标记邀请码为已使用（拒绝服务攻击）
--   3. 重建 invitation_codes_authenticated_update_used_by — 增加 used_by = auth.uid() 限制，
--      确保用户只能更新自己使用的那条邀请码，且只能把 used_by 设为自己的 uid
-- Rollback:
--   CREATE POLICY invitation_codes_authenticated_select ON invitation_codes
--     FOR SELECT TO authenticated
--     USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));
--   CREATE POLICY invitation_codes_authenticated_update ON invitation_codes
--     FOR UPDATE TO authenticated
--     USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));
--   DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;
--   CREATE POLICY invitation_codes_authenticated_update_used_by ON invitation_codes
--     FOR UPDATE TO authenticated
--     USING (used = TRUE)
--     WITH CHECK (used = TRUE);

BEGIN;

-- 1. 删除普通成员的 SELECT 权限，防止枚举所有未使用邀请码
DROP POLICY IF EXISTS invitation_codes_authenticated_select ON invitation_codes;

-- 2. 删除普通成员的 UPDATE 权限，防止随意标记邀请码为已使用
DROP POLICY IF EXISTS invitation_codes_authenticated_update ON invitation_codes;

-- 3. 重建 authenticated_update_used_by 策略，增加 used_by = auth.uid() 限制
DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;

CREATE POLICY invitation_codes_authenticated_update_used_by
ON invitation_codes
FOR UPDATE
TO authenticated
USING (
  used = TRUE
  AND used_by = auth.uid()
)
WITH CHECK (
  used = TRUE
  AND used_by = auth.uid()
);

COMMIT;

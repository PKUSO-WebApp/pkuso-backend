-- Migration: Fix invitation_codes authenticated update_used_by RLS policy
-- Issue: #69
-- Problem:
--   现有策略 invitation_codes_authenticated_update_used_by 使用 USING (used_by = auth.uid())，
--   但注册成功时 used_by 仍为 NULL，用户无法自行更新，必须通过 service role。
-- Changes:
--   重建 invitation_codes_authenticated_update_used_by 策略：
--   - USING: used = TRUE AND used_by IS NULL（邀请码已被使用但未设置使用者）
--   - WITH CHECK: used = TRUE AND used_by = auth.uid()（更新后 used_by 必须是当前用户）
--   效果：用户可以把"已使用但未设置使用者"的邀请码标记为自己使用的
-- Rollback:
--   DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;
--   CREATE POLICY invitation_codes_authenticated_update_used_by
--     ON invitation_codes
--     FOR UPDATE
--     TO authenticated
--     USING (used = TRUE AND used_by = auth.uid())
--     WITH CHECK (used = TRUE AND used_by = auth.uid());

BEGIN;

DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;

CREATE POLICY invitation_codes_authenticated_update_used_by
ON invitation_codes
FOR UPDATE
TO authenticated
USING (
  used = TRUE
  AND used_by IS NULL
)
WITH CHECK (
  used = TRUE
  AND used_by = auth.uid()
);

COMMIT;

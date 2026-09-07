-- Migration: Fix invitation code security issues
-- Issue: #70
-- Changes:
-- 1. Restrict RLS policy invitation_codes_authenticated_update_used_by to only allow users to update their own used invitation codes
-- 2. Add SET search_path = public; to verify_and_use_invitation_code function to prevent SQL injection via search path manipulation
-- 3. Add p_user_id parameter to verify_and_use_invitation_code for atomic verification and user registration
-- Rollback: 
--   DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;
--   CREATE POLICY invitation_codes_authenticated_update_used_by ON invitation_codes FOR UPDATE TO authenticated USING (used = TRUE) WITH CHECK (used = TRUE);
--   DROP FUNCTION IF EXISTS verify_and_use_invitation_code(TEXT, UUID);
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code TEXT) RETURNS TABLE (success BOOLEAN, message TEXT, expires_at TIMESTAMP WITH TIME ZONE) AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER;

BEGIN;

-- Fix RLS policy: Only allow users to update their own used invitation codes
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

-- Fix verify_and_use_invitation_code function:
-- 1. Add p_user_id parameter for atomic verification and user registration
-- 2. Add SET search_path = public; to prevent search path manipulation attacks
-- 3. Record used_by immediately upon successful verification
CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code TEXT, p_user_id UUID)
RETURNS TABLE (success BOOLEAN, message TEXT, expires_at TIMESTAMP WITH TIME ZONE) AS $$
DECLARE
  v_used BOOLEAN;
  v_expires_at TIMESTAMP WITH TIME ZONE;
  v_max_uses INTEGER;
  v_used_count INTEGER;
BEGIN
  -- Use FOR UPDATE to lock the row and prevent concurrent modifications
  SELECT used, expires_at, max_uses, used_count
  INTO v_used, v_expires_at, v_max_uses, v_used_count
  FROM invitation_codes
  WHERE code = p_code
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, '邀请码无效或已被使用', NULL;
    RETURN;
  END IF;
  
  IF v_used THEN
    RETURN QUERY SELECT FALSE, '邀请码已被使用', v_expires_at;
    RETURN;
  END IF;
  
  IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
    RETURN QUERY SELECT FALSE, '邀请码已过期', v_expires_at;
    RETURN;
  END IF;
  
  IF v_max_uses IS NOT NULL AND v_used_count >= v_max_uses THEN
    RETURN QUERY SELECT FALSE, '邀请码已被使用完毕', v_expires_at;
    RETURN;
  END IF;
  
  -- Atomic update: increment used_count, set used_by, and mark as used when limit reached
  UPDATE invitation_codes
  SET 
    used_count = used_count + 1,
    used = CASE WHEN (max_uses IS NOT NULL AND used_count + 1 >= max_uses) THEN TRUE ELSE FALSE END,
    used_by = p_user_id
  WHERE code = p_code;
  
  RETURN QUERY SELECT TRUE, '验证成功', v_expires_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- Grant execute permissions to anon and authenticated users
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT, UUID) TO authenticated;

COMMIT;
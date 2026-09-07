-- Migration: Fix invitation code final security issues
-- Issue: #70
-- Changes:
-- 1. Remove invitation_codes_anon_update policy - rely entirely on RPC function for verification
-- 2. Add p_user_id validation in verify_and_use_invitation_code function to ensure it's a valid auth.users ID
-- Rollback:
--   CREATE POLICY invitation_codes_anon_update ON invitation_codes FOR UPDATE TO anon USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()) AND (max_uses IS NULL OR used_count < max_uses));
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code TEXT, p_user_id UUID) RETURNS TABLE (success BOOLEAN, message TEXT, expires_at TIMESTAMP WITH TIME ZONE) AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

BEGIN;

-- 1. Remove anonymous UPDATE RLS policy - completely rely on RPC function for verification
DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;

-- 2. Update verify_and_use_invitation_code function to validate p_user_id against auth.users
CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code TEXT, p_user_id UUID)
RETURNS TABLE (success BOOLEAN, message TEXT, expires_at TIMESTAMP WITH TIME ZONE) AS $$
DECLARE
  v_used BOOLEAN;
  v_expires_at TIMESTAMP WITH TIME ZONE;
  v_max_uses INTEGER;
  v_used_count INTEGER;
BEGIN
  -- Validate p_user_id is a valid auth.users ID
  PERFORM 1 FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, '邀请码验证失败', NULL;
    RETURN;
  END IF;
  
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

-- Grant execute permissions to anon and authenticated users (already exists, kept for clarity)
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT, UUID) TO authenticated;

COMMIT;

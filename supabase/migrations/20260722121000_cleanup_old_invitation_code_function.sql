-- Migration: Cleanup old version of verify_and_use_invitation_code function
-- Issue: #70
-- Changes:
-- 1. Drop the old version of verify_and_use_invitation_code function (only p_code parameter)
-- 2. Ensure only the new version (with p_user_id parameter) remains
-- Rollback: 
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code TEXT) 
--   RETURNS TABLE (success BOOLEAN, message TEXT, expires_at TIMESTAMP WITH TIME ZONE) AS $$
--   ... (original function body without p_user_id)
--   $$ LANGUAGE plpgsql SECURITY DEFINER;
--   GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT) TO anon;
--   GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT) TO authenticated;

BEGIN;

-- Drop the old version of the function (only p_code parameter)
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(TEXT);

COMMIT;
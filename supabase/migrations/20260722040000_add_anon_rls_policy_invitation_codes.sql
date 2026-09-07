-- Migration: Add RLS policy for anon users to query invitation_codes
-- Issue: #69
-- Rollback: DROP POLICY IF EXISTS invitation_codes_anon_select ON invitation_codes;

BEGIN;

CREATE POLICY invitation_codes_anon_select
ON invitation_codes
FOR SELECT
TO anon
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
);

COMMIT;
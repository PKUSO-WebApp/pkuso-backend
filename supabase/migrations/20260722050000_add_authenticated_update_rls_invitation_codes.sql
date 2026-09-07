-- Migration: Add RLS policy for authenticated users to update invitation_codes
-- Issue: Allow authenticated users to mark invitation codes as used after successful registration
-- Rollback: DROP POLICY IF EXISTS invitation_codes_authenticated_update ON invitation_codes;

BEGIN;

CREATE POLICY invitation_codes_authenticated_update
ON invitation_codes
FOR UPDATE
TO authenticated
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
);

COMMIT;
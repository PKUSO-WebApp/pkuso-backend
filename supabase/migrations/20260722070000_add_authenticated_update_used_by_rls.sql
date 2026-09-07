-- Migration: Add RLS policy for authenticated users to update used_by field
-- Issue: Allow authenticated users to update used_by after invitation code is marked as used
-- Rollback: DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;

BEGIN;

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

COMMIT;
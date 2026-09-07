-- Migration: Add max_uses and used_count fields to invitation_codes table
-- Issue: Support multi-use invitation codes
-- Changes:
-- 1. Add max_uses column (integer, default 1, NULL means unlimited)
-- 2. Add used_count column (integer, default 0)
-- 3. Create indexes on used_count and max_uses
-- 4. Update invitation_codes_authenticated_select policy to check usage limit
-- Rollback:
--   DROP INDEX IF EXISTS idx_invitation_codes_used_count;
--   DROP INDEX IF EXISTS idx_invitation_codes_max_uses;
--   ALTER TABLE invitation_codes DROP COLUMN IF EXISTS used_count, DROP COLUMN IF EXISTS max_uses;
--   CREATE POLICY invitation_codes_authenticated_select ON invitation_codes FOR SELECT TO authenticated USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));

BEGIN;

-- Add max_uses column (default 1, NULL means unlimited)
ALTER TABLE invitation_codes
ADD COLUMN max_uses INTEGER DEFAULT 1;

-- Add used_count column (default 0)
ALTER TABLE invitation_codes
ADD COLUMN used_count INTEGER DEFAULT 0;

-- Create index on used_count for efficient queries checking usage limit
CREATE INDEX idx_invitation_codes_used_count ON invitation_codes(used_count);

-- Create index on max_uses for efficient queries filtering by max_uses
CREATE INDEX idx_invitation_codes_max_uses ON invitation_codes(max_uses);

-- Update authenticated SELECT policy to check usage limit
DROP POLICY IF EXISTS invitation_codes_authenticated_select ON invitation_codes;

CREATE POLICY invitation_codes_authenticated_select
ON invitation_codes
FOR SELECT
TO authenticated
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (max_uses IS NULL OR used_count < max_uses)
);

COMMIT;
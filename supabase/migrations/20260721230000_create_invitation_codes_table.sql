-- Migration: Create invitation_codes table for managing registration invitation codes
-- Issue: #69
-- Rollback: DROP TABLE IF EXISTS invitation_codes;

BEGIN;

CREATE TABLE invitation_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  used BOOLEAN DEFAULT FALSE,
  used_by UUID REFERENCES auth.users(id),
  created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_invitation_codes_code ON invitation_codes(code);
CREATE INDEX idx_invitation_codes_expires_at ON invitation_codes(expires_at);
CREATE INDEX idx_invitation_codes_used ON invitation_codes(used);

ALTER TABLE invitation_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY invitation_codes_authenticated_select
ON invitation_codes
FOR SELECT
TO authenticated
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
);

CREATE POLICY invitation_codes_admin_all
ON invitation_codes
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMIT;
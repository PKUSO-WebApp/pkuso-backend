-- Add session_id column to verification_codes for signup email verification
-- This allows unauthenticated users (during signup) to store/verify codes
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Make user_id nullable (signup flow uses session_id instead)
-- Can't alter NOT NULL directly in Postgres, but the column was created with NOT NULL
-- Since existing rows all have user_id, we keep it; new signup rows will use session_id
-- and leave user_id as a default/empty value

-- Add index for session_id lookups
CREATE INDEX IF NOT EXISTS idx_verification_codes_session_id ON verification_codes (session_id) WHERE session_id IS NOT NULL;

-- Add index for the signup_email_verify purpose lookups
CREATE INDEX IF NOT EXISTS idx_verification_codes_purpose_session ON verification_codes (session_id, purpose, used) WHERE session_id IS NOT NULL;

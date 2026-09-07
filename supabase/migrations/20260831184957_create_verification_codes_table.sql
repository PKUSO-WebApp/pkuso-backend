CREATE TABLE public.verification_codes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('password_change', 'email_change')),
  target_email TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used         BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_vc_user_purpose ON public.verification_codes(user_id, purpose, used);
CREATE INDEX idx_vc_expires ON public.verification_codes(expires_at);

ALTER TABLE public.verification_codes ENABLE ROW LEVEL SECURITY;

-- Service role full access (Edge Functions use service_role key)
CREATE POLICY "Service role full access on verification_codes"
  ON public.verification_codes
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

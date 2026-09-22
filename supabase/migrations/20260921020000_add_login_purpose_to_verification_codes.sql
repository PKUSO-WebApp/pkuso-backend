-- 将 verification_codes.purpose 的 CHECK 约束扩展为包含 'login'
-- 原因：send-login-code Edge Function 插入 purpose='login' 的验证码时违反约束
-- 兼容：dev 环境可能没有该约束，prod 环境有

DO $$
BEGIN
  -- 如果约束存在则先删除
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_codes'::regclass
      AND conname = 'verification_codes_purpose_check'
  ) THEN
    ALTER TABLE verification_codes
      DROP CONSTRAINT verification_codes_purpose_check;
  END IF;
END $$;

ALTER TABLE verification_codes
  ADD CONSTRAINT verification_codes_purpose_check
    CHECK (purpose = ANY (ARRAY['password_change'::text, 'email_change'::text, 'login'::text]));

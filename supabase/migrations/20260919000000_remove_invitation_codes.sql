-- 删除邀请码相关函数
DROP FUNCTION IF EXISTS public.check_invitation_code(text);
DROP FUNCTION IF EXISTS public.verify_and_use_invitation_code(text, uuid);

-- 删除邀请码表（CASCADE 自动清理 RLS 策略、FK、索引）
DROP TABLE IF EXISTS public.invitation_codes CASCADE;
-- Migration: Drop old version of verify_and_use_invitation_code function
-- Issue: #69
-- Reason: 旧版本函数签名为 (p_code text, p_user_id text)，与新版本 (p_code text) 形成重载
--         旧版本不再使用，需清理以避免混淆
-- Rollback:
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text, p_user_id text)
--   RETURNS TABLE (expires_at timestamptz, message text, success boolean)
--   ... (旧函数实现，此处省略，如需完整回滚请参考历史版本)

BEGIN;

-- 删除旧版本的函数（两个参数：p_code, p_user_id）
-- 尝试多种参数类型组合，因为 gen-types 显示 p_user_id 是 string，但实际可能是 uuid
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text, text);
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text, uuid);
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(varchar, uuid);

COMMIT;

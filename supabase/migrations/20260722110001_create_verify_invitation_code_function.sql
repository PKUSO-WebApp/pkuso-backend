-- Migration: Create verify_and_use_invitation_code function for atomic validation
-- Issue: Fix TOCTOU race condition in invitation code validation
-- Changes:
-- 1. Create a PL/pgSQL function that atomically verifies and increments invitation code usage
-- 2. The function handles expiration check, usage limit check, and atomic increment in a single transaction
-- Rollback: DROP FUNCTION IF EXISTS verify_and_use_invitation_code(TEXT);

BEGIN;

-- 创建原子验证邀请码的函数
-- 使用 FOR UPDATE 锁定行，防止并发修改
-- 验证通过后自动递增 used_count，当达到上限时设置 used = TRUE
CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT, expires_at TIMESTAMP WITH TIME ZONE) AS $$
DECLARE
    v_used BOOLEAN;
    v_expires_at TIMESTAMP WITH TIME ZONE;
    v_max_uses INTEGER;
    v_used_count INTEGER;
BEGIN
    -- 使用 FOR UPDATE 锁定行，防止并发修改
    SELECT used, expires_at, max_uses, used_count
    INTO v_used, v_expires_at, v_max_uses, v_used_count
    FROM invitation_codes
    WHERE code = p_code
    FOR UPDATE;

    -- 检查邀请码是否存在
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, '邀请码无效或已被使用', NULL;
        RETURN;
    END IF;

    -- 检查邀请码是否已被使用
    IF v_used THEN
        RETURN QUERY SELECT FALSE, '邀请码已被使用', NULL;
        RETURN;
    END IF;

    -- 检查邀请码是否过期
    IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
        RETURN QUERY SELECT FALSE, '邀请码已过期', NULL;
        RETURN;
    END IF;

    -- 检查使用次数是否已达上限
    IF v_max_uses IS NOT NULL AND v_used_count >= v_max_uses THEN
        RETURN QUERY SELECT FALSE, '邀请码已被使用完毕', NULL;
        RETURN;
    END IF;

    -- 原子更新：递增 used_count，当达到上限时设置 used = TRUE
    UPDATE invitation_codes
    SET 
        used_count = used_count + 1,
        used = CASE WHEN (max_uses IS NOT NULL AND used_count + 1 >= max_uses) THEN TRUE ELSE FALSE END
    WHERE code = p_code;

    RETURN QUERY SELECT TRUE, '验证成功', v_expires_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 设置函数执行权限，允许 anon 用户调用
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(TEXT) TO authenticated;

COMMIT;
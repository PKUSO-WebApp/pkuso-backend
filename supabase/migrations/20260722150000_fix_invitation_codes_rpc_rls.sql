-- Migration: Fix invitation codes RLS with RPC function and remove anon direct UPDATE
-- Issue: #69
-- Changes:
--   1. 创建 SECURITY DEFINER 的 RPC 函数 verify_and_use_invitation_code
--      - 原子地验证邀请码有效性并标记为已使用
--      - 返回邀请码信息（id, code, expires_at, used）
--      - 仅授予 anon 角色执行权限
--   2. 移除 invitation_codes_anon_update RLS 策略
--      （不再需要 anon 直接 UPDATE 表，统一通过 RPC 访问）
--   3. 撤销 anon 对 invitation_codes 的 UPDATE 权限（双重保险）
-- 安全说明：
--   - 函数设置 search_path 防止 SQL 注入
--   - 撤销 PUBLIC 执行权限，仅授予 anon
--   - 使用行锁（FOR UPDATE）防止并发竞争
-- Rollback:
--   DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text);
--   CREATE POLICY invitation_codes_anon_update ON invitation_codes
--     FOR UPDATE TO anon
--     USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));
--   GRANT UPDATE ON invitation_codes TO anon;

BEGIN;

-- ============================================================
-- 1. 创建 RPC 函数：verify_and_use_invitation_code
-- ============================================================
-- 功能：原子地验证邀请码并标记为已使用，返回邀请码信息
-- 输入：p_code text - 邀请码
-- 输出：TABLE(id, code, expires_at, used) - 验证成功返回邀请码行，失败返回空
-- 权限：SECURITY DEFINER（以函数创建者权限执行，绕过 RLS）
-- 安全：SET search_path 防止 SQL 注入；仅授予 anon 角色

CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text)
RETURNS TABLE (
  id UUID,
  code VARCHAR(20),
  expires_at TIMESTAMP WITH TIME ZONE,
  used BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code text := UPPER(TRIM(p_code));
BEGIN
  -- 参数校验：空码直接返回空结果
  IF v_code IS NULL OR v_code = '' THEN
    RETURN;
  END IF;

  -- 原子查找并更新：使用 CTE 在一条语句中完成查找 + 条件更新 + 返回
  -- 只有满足 used=FALSE 且未过期的邀请码才会被标记为已使用
  -- 使用 FOR UPDATE 行锁防止并发竞争
  RETURN QUERY
  WITH target AS (
    SELECT ic.id, ic.code, ic.expires_at, ic.used
    FROM invitation_codes ic
    WHERE ic.code = v_code
      AND ic.used = FALSE
      AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
    FOR UPDATE
    LIMIT 1
  ),
  updated AS (
    UPDATE invitation_codes ic
    SET used = TRUE
    FROM target t
    WHERE ic.id = t.id
    RETURNING ic.id, ic.code, ic.expires_at, ic.used
  )
  SELECT u.id, u.code, u.expires_at, u.used
  FROM updated u;

  RETURN;
END;
$$;

-- 撤销 PUBLIC 的执行权限，仅授予 anon
REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text) TO anon;

-- ============================================================
-- 2. 移除 anon 的 UPDATE RLS 策略（不再需要直接 UPDATE 表）
-- ============================================================
DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;

-- ============================================================
-- 3. 撤销 anon 对 invitation_codes 的 UPDATE 权限（双重保险）
-- ============================================================
REVOKE UPDATE ON invitation_codes FROM anon;

COMMIT;

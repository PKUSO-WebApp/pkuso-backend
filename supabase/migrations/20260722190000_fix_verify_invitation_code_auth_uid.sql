-- Migration: 修复 verify_and_use_invitation_code 越权漏洞，移除 p_user_id 参数，改用 auth.uid()
-- Issue: #69
-- 安全问题：
--   双参数版本 verify_and_use_invitation_code(p_code text, p_user_id uuid) 是 SECURITY DEFINER，
--   直接信任客户端传入的 p_user_id，恶意 authenticated 用户可将任意邀请码绑定到任意用户 ID（拒绝服务攻击）。
-- 修复方案：
--   1. 删除双参数版本 verify_and_use_invitation_code(text, uuid)
--   2. 创建单参数版本 verify_and_use_invitation_code(p_code text)
--      - SECURITY DEFINER，search_path = public, pg_temp
--      - 原子验证 + 消耗 + 绑定 used_by
--      - used_by 设置为 auth.uid()（函数内部获取，不可由客户端指定）
--      - 返回 TABLE(id uuid, code varchar, expires_at timestamptz, used boolean, used_by uuid)
--      - 权限：REVOKE PUBLIC，GRANT EXECUTE TO authenticated
-- Rollback:
--   DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text);
--   -- 恢复双参数版本（需重新创建，以下为简化版回滚说明）
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text, p_user_id uuid)
--     RETURNS TABLE (id UUID, code VARCHAR(20), expires_at TIMESTAMP WITH TIME ZONE, used BOOLEAN, used_by UUID)
--     ... （实现见 20260722180000_add_check_invitation_code_and_update_rpc.sql）
--   REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text, uuid) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text, uuid) TO authenticated;

BEGIN;

-- ============================================================
-- 1. 删除双参数版本 verify_and_use_invitation_code(text, uuid)
-- ============================================================
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text, uuid);

-- ============================================================
-- 2. 创建单参数版本 verify_and_use_invitation_code(p_code text)
-- ============================================================
-- 功能：原子验证 + 消耗邀请码 + 绑定当前登录用户（used_by = auth.uid()）
-- 输入：p_code text - 邀请码
-- 输出：TABLE(id, code, expires_at, used, used_by) - 成功返回邀请码行，失败返回空
-- 验证条件：used = FALSE AND (expires_at IS NULL OR expires_at > NOW())
-- 绑定用户：used_by = auth.uid()（函数内部获取，不可由客户端指定）
-- 权限：SECURITY DEFINER，仅 authenticated 可执行

CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text)
RETURNS TABLE (
  id UUID,
  code VARCHAR(20),
  expires_at TIMESTAMP WITH TIME ZONE,
  used BOOLEAN,
  used_by UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code text := UPPER(TRIM(p_code));
  v_uid uuid := auth.uid();
BEGIN
  -- 参数校验：空码或未登录直接返回空结果
  IF v_code IS NULL OR v_code = '' OR v_uid IS NULL THEN
    RETURN;
  END IF;

  -- 原子查找并更新：使用 CTE 在一条语句中完成查找 + 条件更新 + 返回
  -- 只有满足 used=FALSE 且未过期的邀请码才会被标记为已使用并绑定当前用户
  -- 使用 FOR UPDATE 行锁防止并发竞争
  RETURN QUERY
  WITH target AS (
    SELECT ic.id, ic.code, ic.expires_at, ic.used, ic.used_by
    FROM invitation_codes ic
    WHERE ic.code = v_code
      AND ic.used = FALSE
      AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
    FOR UPDATE
    LIMIT 1
  ),
  updated AS (
    UPDATE invitation_codes ic
    SET used = TRUE,
        used_by = v_uid
    FROM target t
    WHERE ic.id = t.id
    RETURNING ic.id, ic.code, ic.expires_at, ic.used, ic.used_by
  )
  SELECT u.id, u.code, u.expires_at, u.used, u.used_by
  FROM updated u;

  RETURN;
END;
$$;

-- 撤销 PUBLIC 的执行权限，仅授予 authenticated
REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text) TO authenticated;

COMMIT;

-- Migration: 新增 check_invitation_code 只读验证函数 + 修改 verify_and_use_invitation_code 为双参数版本
-- Issue: #69
-- Changes:
--   1. 新增 check_invitation_code(p_code text) —— 只读验证邀请码有效性（不消耗）
--      - SECURITY DEFINER，search_path = public, pg_temp
--      - 返回 TABLE(id, code, expires_at, used)，有效返回一行，无效返回空
--      - 权限：REVOKE PUBLIC，GRANT EXECUTE TO anon
--   2. 删除旧的单参数 verify_and_use_invitation_code(text)
--   3. 新增双参数 verify_and_use_invitation_code(p_code text, p_user_id uuid)
--      - 原子验证 + 消耗 + 绑定使用者（used_by = p_user_id）
--      - 返回 TABLE(id, code, expires_at, used, used_by)
--      - SECURITY DEFINER，search_path = public, pg_temp
--      - 权限：REVOKE PUBLIC，GRANT EXECUTE TO authenticated
-- Rollback:
--   DROP FUNCTION IF EXISTS check_invitation_code(text);
--   DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text, uuid);
--   -- 恢复旧的单参数版本（需重新创建，以下为简化版回滚说明）
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text)
--     RETURNS TABLE (id UUID, code VARCHAR(20), expires_at TIMESTAMP WITH TIME ZONE, used BOOLEAN)
--     ... （实现见 20260722150000_fix_invitation_codes_rpc_rls.sql）
--   REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text) TO anon;

BEGIN;

-- ============================================================
-- 1. 新增 check_invitation_code 只读验证函数
-- ============================================================
-- 功能：只读验证邀请码是否有效（不消耗、不修改任何数据）
-- 输入：p_code text - 邀请码
-- 输出：TABLE(id, code, expires_at, used) - 有效返回一行，无效返回空
-- 验证条件：used = FALSE AND (expires_at IS NULL OR expires_at > NOW())
-- 权限：SECURITY DEFINER，仅 anon 可执行

CREATE OR REPLACE FUNCTION check_invitation_code(p_code text)
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

  -- 只读查询：验证邀请码是否有效（不修改任何数据）
  RETURN QUERY
  SELECT ic.id, ic.code, ic.expires_at, ic.used
  FROM invitation_codes ic
  WHERE ic.code = v_code
    AND ic.used = FALSE
    AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
  LIMIT 1;

  RETURN;
END;
$$;

-- 撤销 PUBLIC 的执行权限，仅授予 anon
REVOKE ALL ON FUNCTION check_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_invitation_code(text) TO anon;

-- ============================================================
-- 2. 删除旧的单参数 verify_and_use_invitation_code(text)
-- ============================================================
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text);

-- ============================================================
-- 3. 新增双参数 verify_and_use_invitation_code(p_code text, p_user_id uuid)
-- ============================================================
-- 功能：原子验证 + 消耗邀请码 + 绑定使用者
-- 输入：
--   p_code text - 邀请码
--   p_user_id uuid - 使用者用户 ID
-- 输出：TABLE(id, code, expires_at, used, used_by) - 成功返回邀请码行，失败返回空
-- 验证条件：used = FALSE AND (expires_at IS NULL OR expires_at > NOW())
-- 更新操作：设置 used = true, used_by = p_user_id
-- 权限：SECURITY DEFINER，仅 authenticated 可执行

CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text, p_user_id uuid)
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
BEGIN
  -- 参数校验：空码或空用户 ID 直接返回空结果
  IF v_code IS NULL OR v_code = '' OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- 原子查找并更新：使用 CTE 在一条语句中完成查找 + 条件更新 + 返回
  -- 只有满足 used=FALSE 且未过期的邀请码才会被标记为已使用并绑定用户
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
        used_by = p_user_id
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
REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text, uuid) TO authenticated;

COMMIT;

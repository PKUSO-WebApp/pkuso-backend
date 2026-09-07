-- Migration: Refactor invitation_codes table schema for multi-use support
-- Issue: #90
-- Changes:
--   1. DROP 依赖 used 字段的 RLS 策略 invitation_codes_authenticated_update_used_by
--   2. DROP COLUMN used（冗余字段，可通过 used_count >= max_uses 判断）
--   3. DROP 外键约束 invitation_codes_used_by_fkey（数组类型无法直接引用）
--   4. ALTER COLUMN used_by TYPE UUID[]，将单个使用者改为数组
--   5. 更新 verify_and_use_invitation_code 函数，使用 array_append 追加使用者
--   6. 重建 RLS 策略 invitation_codes_authenticated_update_used_by
-- Rollback:
--   ALTER TABLE invitation_codes ADD COLUMN used BOOLEAN DEFAULT FALSE;
--   UPDATE invitation_codes SET used = (array_length(used_by, 1) >= max_uses);
--   ALTER TABLE invitation_codes ALTER COLUMN used_by TYPE UUID USING used_by[1];
--   ALTER TABLE invitation_codes ADD CONSTRAINT invitation_codes_used_by_fkey
--     FOREIGN KEY (used_by) REFERENCES auth.users(id);
--   DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;
--   CREATE POLICY invitation_codes_authenticated_update_used_by ON invitation_codes
--     FOR UPDATE TO authenticated
--     USING (used = TRUE AND used_by = auth.uid())
--     WITH CHECK (used = TRUE AND used_by = auth.uid());
--   CREATE OR REPLACE FUNCTION verify_and_use_invitation_code(p_code text) ... （恢复旧版本）

BEGIN;

-- ============================================================
-- 1. 删除依赖 used 字段的 RLS 策略
-- ============================================================
DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;

-- ============================================================
-- 2. DROP COLUMN used（冗余字段）
-- ============================================================
-- used 字段可通过 used_count >= max_uses 推导，无需冗余存储
-- 同时删除索引 idx_invitation_codes_used
DROP INDEX IF EXISTS idx_invitation_codes_used;
ALTER TABLE invitation_codes DROP COLUMN IF EXISTS used;

-- ============================================================
-- 3. 删除 used_by 外键约束（数组类型无法直接引用 auth.users）
-- ============================================================
-- 注意：数据完整性由 verify_and_use_invitation_code 函数保证
-- 函数内部使用 auth.uid() 获取当前用户 ID，确保只有有效用户
ALTER TABLE invitation_codes DROP CONSTRAINT IF EXISTS invitation_codes_used_by_fkey;

-- ============================================================
-- 4. 将 used_by 从 UUID 改为 UUID[] 数组类型
-- ============================================================
-- 存量数据转换规则：
--   - NULL → NULL
--   - 单个 UUID → ARRAY[UUID]
ALTER TABLE invitation_codes
ALTER COLUMN used_by TYPE UUID[]
USING CASE
  WHEN used_by IS NULL THEN NULL
  ELSE ARRAY[used_by]
END;

-- ============================================================
-- 4. 更新 verify_and_use_invitation_code 函数
-- ============================================================
-- 修改点：
--   1. 移除 used 字段引用，改用 used_count 和 max_uses 判断可用性
--   2. 使用 array_append(used_by, auth.uid()) 追加新使用者
--   3. 移除返回结果中的 used 字段（已删除）
--   4. 返回值调整为 TABLE(id, code, expires_at, used_by, used_count)
-- 注意：必须先删除旧函数，因为返回类型变更
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text);

CREATE FUNCTION verify_and_use_invitation_code(p_code text)
RETURNS TABLE (
  id UUID,
  code VARCHAR(20),
  expires_at TIMESTAMP WITH TIME ZONE,
  used_by UUID[],
  used_count INTEGER
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

  -- 原子查找并更新：
  -- 1. 使用 FOR UPDATE 行锁防止并发竞争
  -- 2. 条件：未过期 + 未达使用上限
  -- 3. 更新：递增 used_count + 追加 used_by 数组
  RETURN QUERY
  WITH target AS (
    SELECT ic.id, ic.code, ic.expires_at, ic.used_by, ic.used_count, ic.max_uses
    FROM invitation_codes ic
    WHERE ic.code = v_code
      AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
      AND (ic.max_uses IS NULL OR ic.used_count < ic.max_uses)
    FOR UPDATE
    LIMIT 1
  ),
  updated AS (
    UPDATE invitation_codes ic
    SET used_count = ic.used_count + 1,
        used_by = CASE
          WHEN ic.used_by IS NULL THEN ARRAY[v_uid]
          ELSE array_append(ic.used_by, v_uid)
        END
    FROM target t
    WHERE ic.id = t.id
    RETURNING ic.id, ic.code, ic.expires_at, ic.used_by, ic.used_count
  )
  SELECT u.id, u.code, u.expires_at, u.used_by, u.used_count
  FROM updated u;

  RETURN;
END;
$$;

-- 撤销 PUBLIC 的执行权限，仅授予 authenticated
REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text) TO authenticated;

-- ============================================================
-- 5. 重建 RLS 策略 invitation_codes_authenticated_update_used_by
-- ============================================================
-- 语义：普通成员只能更新自己使用的邀请码（用于补全 used_by 字段）
-- 条件：当前用户在 used_by 数组中
CREATE POLICY invitation_codes_authenticated_update_used_by
ON invitation_codes
FOR UPDATE
TO authenticated
USING (
  used_by IS NOT NULL
  AND auth.uid() = ANY(used_by)
)
WITH CHECK (
  used_by IS NOT NULL
  AND auth.uid() = ANY(used_by)
);

COMMIT;
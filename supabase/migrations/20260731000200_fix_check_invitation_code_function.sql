-- Migration: 修复 check_invitation_code 函数引用已删除字段 used 的问题
-- Issue: #91
-- 背景：
--   20260731000000_invitation_codes_schema_refactor.sql 删除了 invitation_codes.used 列
--   （改用 used_count / max_uses 判断可用性），并同步更新了 verify_and_use_invitation_code。
--   但 check_invitation_code 函数（定义于 20260722180000）漏改，函数体仍引用 ic.used，
--   导致 anon 调用 check_invitation_code 时运行时报错（HTTP 400）。
-- 变更内容：
--   1. DROP FUNCTION check_invitation_code(text) —— 因返回类型列集合变化（移除 used、新增
--      used_count / max_uses），CREATE OR REPLACE 无法改变返回列集合，必须先 DROP 再 CREATE
--   2. 重建 check_invitation_code(p_code text)
--      - SECURITY DEFINER，search_path = public, pg_temp
--      - 只读验证邀请码是否有效（不消耗、不修改任何数据）
--      - 验证条件：(max_uses IS NULL OR used_count < max_uses) AND (expires_at IS NULL OR expires_at > NOW())
--      - 返回 TABLE(id, code, expires_at, used_count, max_uses)
--        （不返回 used_by 数组，避免向未登录用户泄露已使用者列表）
--      - 权限：REVOKE ALL FROM PUBLIC，GRANT EXECUTE TO anon
-- 受影响面声明（供 implementer / adversary / tester 参考）：
--   - check_invitation_code RPC 返回类型变化：移除 used: boolean，新增 used_count: number、max_uses: number | null
--   - 业务代码 src/app/(auth)/signup/page.tsx 调用处仅读取 data.length，不读取字段，
--     返回类型变化不破坏现有逻辑；但 implementer 应复核是否需要展示 used_count/max_uses 信息
--   - 权限模型未变：anon 可调用（注册前邀请码预校验），不消耗邀请码
--   - RLS 策略未变：本 migration 不修改任何 RLS 策略
-- 中途状态推演：
--   - 整个 migration 包在单事务中，DROP FUNCTION 与 CREATE FUNCTION 一起成功或一起回滚
--   - 失败时不会残留半成品函数；旧函数定义在事务回滚后保持原样（仍是坏的定义，但与
--     migration 应用前状态一致，不会更糟）
--   - DROP 期间若有并发调用 check_invitation_code 会短暂报 "function does not exist"，
--     但该函数当前已不可用（运行时报错），并发影响可忽略
-- Rollback（回滚说明）：
--   本 migration 是修复，回滚等于撤销修复，不推荐。如确需回滚：
--   DROP FUNCTION IF EXISTS check_invitation_code(text);
--   CREATE OR REPLACE FUNCTION check_invitation_code(p_code text)
--     RETURNS TABLE (id UUID, code VARCHAR(20), expires_at TIMESTAMP WITH TIME ZONE, used BOOLEAN)
--     LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
--     DECLARE v_code text := UPPER(TRIM(p_code));
--     BEGIN
--       IF v_code IS NULL OR v_code = '' THEN RETURN; END IF;
--       -- 注意：回滚后函数体引用 used 列，但 used 列已被 20260731000000 删除，
--       --       因此回滚后函数仍不可用。完整回滚需先回滚 20260731000000。
--       RETURN QUERY SELECT ic.id, ic.code, ic.expires_at, ic.used
--         FROM invitation_codes ic
--         WHERE ic.code = v_code AND ic.used = FALSE
--           AND (ic.expires_at IS NULL OR ic.expires_at > NOW()) LIMIT 1;
--     END; $$;
--   REVOKE ALL ON FUNCTION check_invitation_code(text) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION check_invitation_code(text) TO anon;

BEGIN;

-- ============================================================
-- 1. 删除旧的 check_invitation_code(text)
-- ============================================================
-- 必须先 DROP 再 CREATE：CREATE OR REPLACE 不允许改变返回列集合
-- （从 used BOOLEAN 改为 used_count INTEGER + max_uses INTEGER）
DROP FUNCTION IF EXISTS check_invitation_code(text);

-- ============================================================
-- 2. 重建 check_invitation_code(p_code text)
-- ============================================================
-- 功能：只读验证邀请码是否有效（不消耗、不修改任何数据）
-- 输入：p_code text - 邀请码
-- 输出：TABLE(id, code, expires_at, used_count, max_uses) - 有效返回一行，无效返回空
-- 验证条件：
--   1. 未达使用上限：max_uses IS NULL OR used_count < max_uses
--   2. 未过期：expires_at IS NULL OR expires_at > NOW()
-- 权限：SECURITY DEFINER，仅 anon 可执行（用于注册前预校验）

CREATE FUNCTION check_invitation_code(p_code text)
RETURNS TABLE (
  id UUID,
  code VARCHAR(20),
  expires_at TIMESTAMP WITH TIME ZONE,
  used_count INTEGER,
  max_uses INTEGER
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
  -- 可用性判断：未达使用上限（max_uses 为 NULL 表示不限次数）
  RETURN QUERY
  SELECT ic.id, ic.code, ic.expires_at, ic.used_count, ic.max_uses
  FROM invitation_codes ic
  WHERE ic.code = v_code
    AND (ic.max_uses IS NULL OR ic.used_count < ic.max_uses)
    AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
  LIMIT 1;

  RETURN;
END;
$$;

-- 撤销 PUBLIC 的执行权限，仅授予 anon
REVOKE ALL ON FUNCTION check_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_invitation_code(text) TO anon;

COMMIT;

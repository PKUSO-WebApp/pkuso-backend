-- Migration: verify_and_use_invitation_code 改为显式接收 p_user_id 参数
-- Issue: #94 - 邀请码 used_by 记录错误用户
-- 背景：
--   当前函数 verify_and_use_invitation_code(p_code text) 使用 auth.uid() 获取当前用户 ID
--   写入 used_by 数组。但注册流程中存在两类问题：
--   1. signUp() 后调用此 RPC 时，新用户可能无 session（邮箱确认开启），
--      auth.uid() 返回 NULL，函数直接 RETURN，used_by 不更新，丢失使用者记录
--   2. admin 登录态下测试时，auth.uid() 返回 admin ID，
--      used_by 数组被填入 admin 的 ID，无法追溯真实使用者
--   根因：注册流程中"实际使用者"与"当前 session 用户"不一致
-- 变更内容：
--   1. DROP FUNCTION verify_and_use_invitation_code(text)
--   2. CREATE FUNCTION verify_and_use_invitation_code(p_code text, p_user_id uuid)
--      - 使用 p_user_id 替代 auth.uid() 写入 used_by（array_append）
--      - 返回类型不变：TABLE(id, code, expires_at, used_by UUID[], used_count)
--      - SECURITY DEFINER，SET search_path = public, pg_temp
--      - 保留 FOR UPDATE 行锁 + 原子 CTE 结构（与 20260731000000 一致）
--      - 保留可用性判断：(expires_at IS NULL OR expires_at > NOW())
--                       AND (max_uses IS NULL OR used_count < max_uses)
--                       AND (used_by IS NULL OR NOT (p_user_id = ANY(used_by)))  -- 同一 p_user_id 去重
--   3. 安全校验（关键）：
--      - p_user_id 必须存在于 auth.users 表（函数 SECURITY DEFINER 可访问）
--      - p_user_id 对应用户 created_at 必须在最近 10 分钟内（NOW() - INTERVAL '10 minutes'）
--      - 任一校验失败直接 RETURN（空结果，不消耗邀请码）
--   4. 权限变化：REVOKE ALL FROM PUBLIC；GRANT EXECUTE TO anon
--      这是修正旧设计的错误——旧设计 GRANT TO authenticated，但注册流程的新用户
--      可能无 authenticated session，恰恰需要 anon 调用
-- 重新引入 p_user_id 的安全考量（vs Issue #69 旧 DoS 顾虑）：
--   migration 20260722190000 曾移除双参数版本，理由是"恶意 authenticated 用户可将任意
--   邀请码绑定到任意用户 ID（DoS）"。本次重新引入 p_user_id 的安全保障：
--   1. p_user_id 必须在 auth.users 表存在（函数 SECURITY DEFINER 可访问）
--   2. p_user_id.created_at 必须在最近 10 分钟内（仅允许绑定刚注册的新用户）
--   3. 邀请码本身是 secret（8 位字符，32^12 ≈ 10^12 空间，不可枚举）
--   4. GRANT TO anon 是必要的，因为注册流程的新用户无 session
--   缓解的攻击面：
--   - 攻击者无法将邀请码绑定到老用户（created_at > 10 分钟前 → RETURN）
--   - 攻击者无法枚举邀请码（需先知道 8 位 secret）
--   - 攻击者无法 DoS 新用户（新用户本身 created_at < 10 分钟，可正常绑定）
--   - 攻击者无法用同一 user_id 重复消耗共享码（CTE WHERE 去重，见下文受影响面声明第 9 条）
-- 受影响面声明（供 implementer / adversary / tester 参考）：
--   1. 函数签名变化：verify_and_use_invitation_code(text) → verify_and_use_invitation_code(text, uuid)
--      前端调用处 src/app/(auth)/signup/page.tsx 必须同步传 p_user_id 参数
--      （从 signUp 响应 signUpData.user.id 获取，而非依赖 session）
--   2. 权限变化：authenticated → anon
--      anon 角色现在可调用此 RPC（注册流程必需）
--      authenticated 失去调用权限：实际无影响，注册流程是唯一调用方且由 anon 触发
--   3. gen-types 产物：verify_and_use_invitation_code.Args 新增 p_user_id: string
--      （src/types/database.types.ts 第 359-368 行附近）
--   4. RLS 策略无变化（invitation_codes 表 RLS 未修改）
--   5. 返回类型未变化（TABLE(id, code, expires_at, used_by UUID[], used_count)）
--   6. check_invitation_code 函数未变化（仍只读预校验，不消耗码，不需 p_user_id）
--   7. adversary 应关注：anon 可调用 + p_user_id 校验是否能被绕过（如 created_at 边界、
--      用户存在性校验是否在 CTE 之前执行、并发场景下两个不同新用户争抢最后一个名额）
--   8. tester 应设计用例：新用户正常绑定、不存在用户 RETURN、老用户 RETURN、
--      重复绑定同一新用户（CTE 不命中，返回空结果，used_count 不递增）、并发竞争
--   9. 【返工修复 Issue #94 问题2】CTE WHERE 新增去重条件：
--      AND (ic.used_by IS NULL OR NOT (p_user_id = ANY(ic.used_by)))
--      - 修复前：同一 p_user_id 在 10 分钟窗口内可重复调用 N 次，对 max_uses>1 的共享码
--        实施 DoS（耗尽 used_count，used_by 数组含重复 ID）
--      - 修复后：CTE 不命中 → 返回空结果 → 前端提示失败 → used_count 不会虚假递增
--      - 函数签名/权限/返回类型均未变，gen-types 产物无变化
-- 中途状态推演：
--   - 整个 migration 包在单事务中，DROP 与 CREATE 一起成功或一起回滚
--   - 失败时不会残留半成品函数；旧函数定义在事务回滚后保持原样
--   - DROP 期间若有并发调用 verify_and_use_invitation_code 会短暂报 "function does not exist"
--   - 权限变化影响：authenticated 失去调用权限。但前端注册流程由 anon 触发
--     （signUp 后无 session），故无实际影响
--   - auth.users 查询在函数体内执行，依赖 SECURITY DEFINER 上下文访问 auth schema，
--     不会因 RLS 拦截 anon 角色而失败
-- Rollback（回滚说明）：
--   DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text, uuid);
--   CREATE FUNCTION verify_and_use_invitation_code(p_code text)
--     RETURNS TABLE (
--       id UUID, code VARCHAR(20), expires_at TIMESTAMP WITH TIME ZONE,
--       used_by UUID[], used_count INTEGER
--     )
--     LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
--     DECLARE
--       v_code text := UPPER(TRIM(p_code));
--       v_uid uuid := auth.uid();
--     BEGIN
--       IF v_code IS NULL OR v_code = '' OR v_uid IS NULL THEN RETURN; END IF;
--       RETURN QUERY
--       WITH target AS (
--         SELECT ic.id, ic.code, ic.expires_at, ic.used_by, ic.used_count, ic.max_uses
--         FROM invitation_codes ic
--         WHERE ic.code = v_code
--           AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
--           AND (ic.max_uses IS NULL OR ic.used_count < ic.max_uses)
--         FOR UPDATE LIMIT 1
--       ),
--       updated AS (
--         UPDATE invitation_codes ic
--         SET used_count = ic.used_count + 1,
--             used_by = CASE WHEN ic.used_by IS NULL THEN ARRAY[v_uid]
--                            ELSE array_append(ic.used_by, v_uid) END
--         FROM target t WHERE ic.id = t.id
--         RETURNING ic.id, ic.code, ic.expires_at, ic.used_by, ic.used_count
--       )
--       SELECT u.id, u.code, u.expires_at, u.used_by, u.used_count FROM updated u;
--       RETURN;
--     END; $$;
--   REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text) TO authenticated;

BEGIN;

-- ============================================================
-- 1. 删除旧的单参数版本 verify_and_use_invitation_code(text)
-- ============================================================
-- 签名变化（新增 p_user_id 参数），CREATE OR REPLACE 无法改变参数列表，必须先 DROP 再 CREATE
DROP FUNCTION IF EXISTS verify_and_use_invitation_code(text);

-- ============================================================
-- 2. 创建新双参数版本 verify_and_use_invitation_code(p_code text, p_user_id uuid)
-- ============================================================
-- 功能：原子验证 + 消耗邀请码 + 追加使用者到 used_by 数组
-- 输入：
--   p_code text - 邀请码
--   p_user_id uuid - 新注册用户 ID（前端从 signUp 响应 signUpData.user.id 获取）
-- 输出：TABLE(id, code, expires_at, used_by UUID[], used_count) - 成功返回一行，失败返回空
-- 安全校验（在 CTE 之前执行，校验失败直接 RETURN，不消耗邀请码）：
--   1. p_user_id 必须存在于 auth.users 表
--   2. p_user_id 对应用户 created_at 必须在最近 10 分钟内（防止绑定到老用户实施 DoS）
-- 可用性判断（在 CTE 内的 WHERE 子句中）：
--   1. (expires_at IS NULL OR expires_at > NOW()) - 未过期
--   2. (max_uses IS NULL OR used_count < max_uses) - 未达使用上限
--   3. (used_by IS NULL OR NOT (p_user_id = ANY(used_by))) - 同一 p_user_id 去重，防 DoS
-- 权限：SECURITY DEFINER，仅 anon 可执行
--   （注册流程新用户可能无 authenticated session，必须允许 anon 调用）

CREATE FUNCTION verify_and_use_invitation_code(p_code text, p_user_id uuid)
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
  v_user_created_at timestamptz;
BEGIN
  -- 参数校验：空码或空用户 ID 直接返回空结果
  IF v_code IS NULL OR v_code = '' OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- 安全校验：p_user_id 必须在 auth.users 表存在 + created_at 在最近 10 分钟内
  -- 防止恶意用户将邀请码绑定到任意老用户实施 DoS（Issue #69 的旧顾虑）
  -- 函数 SECURITY DEFINER 以所有者（postgres）权限运行，可访问 auth schema
  -- 若 p_user_id 不存在，SELECT 不返回行，v_user_created_at 保持 NULL，
  -- 下面的 IF 条件成立直接 RETURN（不消耗邀请码）
  SELECT au.created_at INTO v_user_created_at
  FROM auth.users au
  WHERE au.id = p_user_id;

  -- 用户不存在（v_user_created_at IS NULL）或创建时间早于 10 分钟前，直接返回空结果
  -- 边界：created_at == NOW() - INTERVAL '10 minutes' 视为有效（< 才 RETURN）
  IF v_user_created_at IS NULL OR v_user_created_at < NOW() - INTERVAL '10 minutes' THEN
    RETURN;
  END IF;

  -- 原子查找并更新：
  -- 1. 使用 FOR UPDATE 行锁防止并发竞争
  -- 2. 条件：未过期 + 未达使用上限 + 同一 p_user_id 去重
  -- 3. 更新：递增 used_count + 追加 used_by 数组
  -- 注意：WHERE 中已显式去重 —— AND (ic.used_by IS NULL OR NOT (p_user_id = ANY(ic.used_by)))
  --       若同一新用户在 10 分钟窗口内重复调用，CTE 不命中，返回空结果，
  --       used_count 不会递增，used_by 不会重复追加（修复 adversary 击破的 Issue #94 问题2）
  --       此前版本仅靠前端注册流程保证只调用一次，存在 DoS 风险：
  --       恶意用户用同一 user_id 连续调用 N 次，可耗尽 max_uses>1 的共享邀请码
  RETURN QUERY
  WITH target AS (
    SELECT ic.id, ic.code, ic.expires_at, ic.used_by, ic.used_count, ic.max_uses
    FROM invitation_codes ic
    WHERE ic.code = v_code
      AND (ic.expires_at IS NULL OR ic.expires_at > NOW())
      AND (ic.max_uses IS NULL OR ic.used_count < ic.max_uses)
      AND (ic.used_by IS NULL OR NOT (p_user_id = ANY(ic.used_by)))
    FOR UPDATE
    LIMIT 1
  ),
  updated AS (
    UPDATE invitation_codes ic
    SET used_count = ic.used_count + 1,
        used_by = CASE
          WHEN ic.used_by IS NULL THEN ARRAY[p_user_id]
          ELSE array_append(ic.used_by, p_user_id)
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

-- 撤销 PUBLIC 的执行权限，仅授予 anon
-- 注册流程的新用户可能无 authenticated session，必须允许 anon 调用
-- authenticated 角色失去调用权限：实际无影响，注册流程是唯一调用方且由 anon 触发
REVOKE ALL ON FUNCTION verify_and_use_invitation_code(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_and_use_invitation_code(text, uuid) TO anon;

COMMIT;

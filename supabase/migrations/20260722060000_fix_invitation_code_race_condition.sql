-- Migration: Fix invitation code race condition and security issues
-- Issue: #69
-- Changes:
-- 1. Remove anon SELECT policy (prevents enumeration attacks)
-- 2. Add anon UPDATE policy with returning clause (atomic validation + update)
-- Rollback: 
--   DROP POLICY IF EXISTS invitation_codes_anon_update ON invitation_codes;
--   CREATE POLICY invitation_codes_anon_select ON invitation_codes FOR SELECT TO anon USING (used = FALSE AND (expires_at IS NULL OR expires_at > NOW()));

BEGIN;

-- 移除 anon 用户的 SELECT 权限，防止枚举查询有效邀请码
DROP POLICY IF EXISTS invitation_codes_anon_select ON invitation_codes;

-- 添加 anon 用户的 UPDATE 权限，支持原子验证操作
-- 注册时直接尝试 UPDATE 设置 used = true，利用数据库原子性保证竞态安全
CREATE POLICY invitation_codes_anon_update
ON invitation_codes
FOR UPDATE
TO anon
USING (
  used = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
);

COMMIT;
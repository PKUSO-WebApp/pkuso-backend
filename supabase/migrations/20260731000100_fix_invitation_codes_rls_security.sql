-- Migration: Fix RLS policy security vulnerability for invitation_codes
-- Issue: #90 - Adversary 批评报告问题 2
-- Problem:
--   invitation_codes_authenticated_update_used_by 策略允许成员修改 used_by、
--   used_count、max_uses 等关键字段，存在安全风险：
--   1. 成员可删除 used_by 数组中的其他用户
--   2. 成员可重置 used_count，使已用完的邀请码重新可用
-- Solution:
--   删除不安全的 RLS 策略，因为 verify_and_use_invitation_code 函数
--   （SECURITY DEFINER）已处理 used_by 更新，普通成员不应有直接 UPDATE 权限
-- Rollback:
--   CREATE POLICY invitation_codes_authenticated_update_used_by ON invitation_codes
--     FOR UPDATE TO authenticated
--     USING (used_by IS NOT NULL AND auth.uid() = ANY(used_by))
--     WITH CHECK (used_by IS NOT NULL AND auth.uid() = ANY(used_by));

BEGIN;

-- ============================================================
-- 删除不安全的 RLS 策略
-- ============================================================
-- 普通成员不应有 invitation_codes 的 UPDATE 权限
-- used_by 字段更新由 verify_and_use_invitation_code 函数处理
DROP POLICY IF EXISTS invitation_codes_authenticated_update_used_by ON invitation_codes;

COMMIT;
BEGIN;

-- 删除匿名用户的 SELECT RLS 策略，防止枚举攻击
-- 回滚：需要重新创建该策略，参考之前的 migration 文件
DROP POLICY IF EXISTS invitation_codes_anon_select ON invitation_codes;

COMMIT;
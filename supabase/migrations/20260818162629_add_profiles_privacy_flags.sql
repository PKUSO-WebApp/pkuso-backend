-- 个人信息隐私隐藏（Issue #193）
-- profiles 表新增三个隐私布尔开关：成员可自主隐藏邮箱、手机号、入团时间
-- 均为 NOT NULL DEFAULT false（默认不隐藏），在成员花名册/详情弹窗按开关过滤展示
-- RLS 无需新策略：现有「profiles: 可更新自己的档案」UPDATE 策略（USING auth.uid() = id）
-- 无列级限制，新列随行更新自动在策略覆盖范围内

ALTER TABLE profiles
ADD COLUMN hide_email boolean NOT NULL DEFAULT false,
ADD COLUMN hide_phone boolean NOT NULL DEFAULT false,
ADD COLUMN hide_join_date boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.hide_email IS '隐藏邮箱：为 true 时在成员花名册/详情弹窗不展示 email';
COMMENT ON COLUMN profiles.hide_phone IS '隐藏手机号：为 true 时在成员花名册/详情弹窗不展示 phone_number';
COMMENT ON COLUMN profiles.hide_join_date IS '隐藏入团时间：为 true 时在成员花名册/详情弹窗不展示 join_date';

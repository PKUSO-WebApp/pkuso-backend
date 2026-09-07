-- 迁移说明：创建 app_settings 应用设置键值表（Issue #122：邮件签名等全局设置）。
--
-- 背景：
--   邮件签名等全局设置需要一处可被 API route 经 service role 读写、但客户端
--   （anon/authenticated）完全不可访问的存储。设计为通用键值表（key/value），
--   便于后续扩展更多全局设置而无需反复加列。
--
-- 安全设计：
--   - 启用 RLS 但不创建任何策略：无策略 = 所有客户端角色（anon/authenticated）
--     对全表操作被拒（RLS 默认 deny）。该表仅由 API route 通过
--     supabase-server（service role，绕过 RLS）访问，符合项目
--     "service role 只在 API route 中用于管理员操作" 的约定。
--   - service role 属于 table owner（postgres），不受 RLS 限制，读写不受影响。
--
-- 幂等性：CREATE TABLE 不幂等，重复执行会报 already exists，属预期行为。
--
-- 回滚方案：
--   DROP TABLE IF EXISTS app_settings;

BEGIN;

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

COMMIT;

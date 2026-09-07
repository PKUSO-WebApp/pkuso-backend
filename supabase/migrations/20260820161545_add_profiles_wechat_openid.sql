-- 微信登录桥接：profiles 增加微信 openid 映射列（规划 §6 微信登录方案）。
-- Edge Function wechat-auth 经 jscode2session 换得 openid 后：
--   * 查 wechat_openid 命中 → 已有账号直接登录；
--   * 未命中 → admin API 创建 auth 用户（合成邮箱 wechat_<openid>@placeholder.local），
--     handle_new_user 触发器自动建 profile，本列写入 openid 完成映射。
-- 老成员绑定策略（规划 §6 方案 A 一次性绑定码）后续实现时复用本列。
-- 唯一性：一个 openid 只映射一个账号（部分索引跳过 NULL，与既有习惯一致）。
BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS wechat_openid text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_wechat_openid_key
  ON public.profiles (wechat_openid)
  WHERE wechat_openid IS NOT NULL;

COMMENT ON COLUMN public.profiles.wechat_openid IS
  '微信小程序 openid 映射（wechat-auth Edge Function 写入；NULL = 未绑定微信）';

COMMIT;

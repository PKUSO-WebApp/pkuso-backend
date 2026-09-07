-- 1. 撤销表级 SELECT（表级授权会覆盖列级 REVOKE）
REVOKE SELECT ON profiles FROM anon, authenticated;

-- 2. 仅授予安全列的 SELECT（敏感三列 email/phone_number/join_date 不授权，
--    强制通过 profiles_roster 视图读取，由视图 CASE 掩码控制可见性）
GRANT SELECT (id, full_name, instrument, college, avatar_url,
              status, role, is_in_orchestra, is_section_leader,
              hide_email, hide_phone, hide_join_date, hide_college,
              session_started_at, session_token, wechat_openid, created_at)
  ON profiles
  TO authenticated;

-- anon 只需读 approved 行的基本信息（成员列表页公开视图）
GRANT SELECT (id, full_name, instrument, college, avatar_url,
              is_in_orchestra, is_section_leader)
  ON profiles
  TO anon;

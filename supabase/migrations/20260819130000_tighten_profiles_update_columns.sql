-- Issue #197：profiles 表级 UPDATE 收紧为列级白名单
--
-- 背景：authenticated 对 profiles 保留表级 UPDATE（GRANT ALL 遗留），配合 RLS
-- 「可更新自己的档案」（auth.uid() = id）后，成员可 PATCH 自己行的 status/role——
-- 自改 status 可绕过入团审批、自改 role 有提权风险（无法改他人行，但语义不当）。
--
-- 收紧方式（#193 教训：列级 REVOKE 对表级授权无效，须表级 REVOKE + 逐列补授）：
--   撤销 authenticated 的表级 UPDATE，按前端写路径逐列授予。
--   白名单列的唯一来源是 src/hooks/useProfiles.ts 的 ProfileUpdatePayload 类型
--   （成员个人信息编辑弹窗与 admin 成员详情弹窗保存共用），共 10 列。
--   status/role 不授——admin 浏览器端同样被收紧（入团审批走 service role API，
--   不受影响）。
--   INSERT 未收紧：无浏览器端生产调用方（注册经 handle_new_user 触发器）。
--   service_role 保留表级 ALL，不受影响。
--
-- 回滚：GRANT UPDATE ON public.profiles TO authenticated;

BEGIN;

REVOKE UPDATE ON public.profiles FROM authenticated;

GRANT UPDATE (
  full_name,
  instrument,
  college,
  email,
  phone_number,
  join_date,
  hide_email,
  hide_phone,
  hide_join_date,
  is_section_leader
) ON public.profiles TO authenticated;

COMMIT;

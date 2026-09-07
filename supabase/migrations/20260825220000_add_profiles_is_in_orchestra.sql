-- profiles 新增可选布尔列：是否在团（探讨定名 is_in_orchestra，2026-08-25）
-- NULL = 未设置（admin 不做设置）；true = 在团；false = 已离团
-- 注意：profiles.status 已被入团审批枚举占用，本列与其正交
alter table public.profiles add column is_in_orchestra boolean;

-- 存量数据：除 admin 以外的用户全部标记为在团；admin 保持 NULL
update public.profiles
set is_in_orchestra = true
where role is distinct from 'admin'::"profileRole";

-- 列级授权（对齐 Issue #193 列权限模式）：花名册可见 → 开放 SELECT；
-- 与既有列一致开放 INSERT/UPDATE（行级由 RLS 管控）
grant select (is_in_orchestra) on public.profiles to anon, authenticated;
grant insert (is_in_orchestra) on public.profiles to anon, authenticated;
grant update (is_in_orchestra) on public.profiles to anon, authenticated;

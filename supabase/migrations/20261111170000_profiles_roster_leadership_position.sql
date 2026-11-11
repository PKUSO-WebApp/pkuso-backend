-- ============================================
-- profiles_roster 增加团级职位列
-- ============================================
--
-- 成员页要显示团长/副团长徽章。mp 的 useProfiles 与 web 花名册都读
-- profiles_roster；把职位并进这个视图，避免两端各写一套查询。
-- 只追加一列（视图列顺序保持不变），权限/掩码逻辑原样保留。
--
-- 回滚：恢复 20261110130000 之前的 profiles_roster 定义（去掉 leadership_position 与 join）。

BEGIN;

CREATE OR REPLACE VIEW public.profiles_roster AS
SELECT
  p.id,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_email
    THEN p.email
    ELSE NULL::text
  END AS email,
  p.full_name,
  p.instrument,
  p.status,
  p.role,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_college
    THEN p.college
    ELSE NULL::text
  END AS college,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_phone
    THEN p.phone_number
    ELSE NULL::text
  END AS phone_number,
  p.join_date,
  p.created_at,
  p.is_section_leader,
  p.hide_email,
  p.hide_phone,
  p.hide_join_date,
  p.hide_college,
  p.is_in_orchestra,
  p.avatar_url,
  p.is_principal,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_birthday
    THEN p.birthday
    ELSE NULL::date
  END AS birthday,
  p.hide_birthday,
  lp.position AS leadership_position
FROM public.profiles p
LEFT JOIN public.leadership_positions lp ON lp.user_id = p.id
WHERE p.status = 'approved'::public."profileStatus"
   OR (SELECT auth.uid()) = p.id
   OR (SELECT public.is_admin());

COMMIT;

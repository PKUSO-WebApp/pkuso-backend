-- ============================================
-- 角色判据函数 + 管理 RPC（P0b-3）
-- ============================================
--
-- 设计依据：`声部长功能-数据模型与常量.md` §2.5–§2.6 + §12.7。
--
-- 三条不变量：
--   1. 声部归属只由这里的函数回答；前端不复制「谁管哪个声部」的组展开逻辑。
--   2. 公开函数一律以 auth.uid() 为调用者，不接受 user 参数，避免伪造。
--   3. 管理 RPC 只给 service_role；p_actor_id 必须是 admin（防御性；route 已验一次）。
--
-- 团长开口：`has_capability()` = is_admin() OR president_capabilities 命中。
-- 本版能力表为空，所以除 admin 外没有人命中；以后团长功能直接复用这些判据。
--
-- 回滚：DROP FUNCTION ...（见各函数签名）；本迁移不删数据。

BEGIN;

-- ---------------------------------------------------------------------------
-- 内部 helper：actor 必须是 admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_admin_actor(p_actor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor_id
      AND role = 'admin'::public."profileRole"
      AND status = 'approved'::public."profileStatus"
  ) THEN
    RAISE EXCEPTION 'actor_not_admin' USING ERRCODE = '42501';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------
-- 内部：声部长作用域展开 / 首席乐器
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.led_sections(p_leader uuid)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT sl.section
  FROM public.section_leaders sl
  JOIN public.sections s ON s.name = sl.section
  WHERE sl.leader_id = p_leader AND s.kind = 'instrument'
  UNION
  SELECT sgm.member_name
  FROM public.section_leaders sl
  JOIN public.section_group_members sgm ON sgm.group_name = sl.section
  WHERE sl.leader_id = p_leader
$function$;

CREATE OR REPLACE FUNCTION public.principal_instruments(p_principal uuid)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT instrument
  FROM public.instrument_principals
  WHERE principal_id = p_principal
$function$;

-- ---------------------------------------------------------------------------
-- 团长能力开口
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_capability(p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1 FROM public.president_capabilities c
    WHERE c.user_id = auth.uid() AND c.capability = p_capability
  )
$function$;

CREATE OR REPLACE FUNCTION public.my_capabilities()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT capability
  FROM public.president_capabilities
  WHERE user_id = auth.uid()
$function$;

-- ---------------------------------------------------------------------------
-- 公开权限函数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_leadership_roles()
RETURNS TABLE (scope text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT section, 'section_leader'::text
  FROM public.section_leaders
  WHERE leader_id = auth.uid()
  UNION ALL
  SELECT instrument, 'principal'::text
  FROM public.instrument_principals
  WHERE principal_id = auth.uid()
$function$;

CREATE OR REPLACE FUNCTION public.my_managed_sections()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT * FROM public.led_sections(auth.uid())
  UNION
  SELECT * FROM public.principal_instruments(auth.uid())
  UNION
  SELECT s.name
  FROM public.sections s
  WHERE s.kind = 'instrument' AND public.has_capability('attendance')
$function$;

CREATE OR REPLACE FUNCTION public.can_view_member_attendance(p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.has_capability('attendance') OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_member
      AND btrim(coalesce(p.instrument, '')) IN (
        SELECT * FROM public.my_managed_sections()
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.can_view_rehearsal_attendance(p_rehearsal_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN public.has_capability('attendance') THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.rehearsals r
      WHERE r.id = p_rehearsal_id
        AND NOT (r.type = 'section' AND coalesce(cardinality(r.target_section), 0) = 0)
        AND (
          coalesce(cardinality(r.target_section), 0) = 0
          OR EXISTS (
            SELECT 1 FROM unnest(r.target_section) t(section)
            WHERE t.section IN (SELECT * FROM public.my_managed_sections())
          )
        )
    )
  END
$function$;

CREATE OR REPLACE FUNCTION public.can_manage_member_attendance(p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.can_view_member_attendance(p_member)
$function$;

CREATE OR REPLACE FUNCTION public.can_manage_rehearsal_attendance(p_rehearsal_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.can_view_rehearsal_attendance(p_rehearsal_id)
$function$;

-- ---------------------------------------------------------------------------
-- 管理 RPC：声部长
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_section_leader(
  p_section text,
  p_leader_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_kind text;
  v_instrument text;
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

  SELECT kind INTO v_kind
  FROM public.sections
  WHERE name = p_section AND can_lead;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'invalid_scope: %', p_section USING ERRCODE = '22023';
  END IF;

  SELECT btrim(coalesce(instrument, '')) INTO v_instrument
  FROM public.profiles
  WHERE id = p_leader_id
    AND status = 'approved'::public."profileStatus"
    AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole";
  IF v_instrument IS NULL OR v_instrument = '' THEN
    RAISE EXCEPTION 'target_not_eligible' USING ERRCODE = '22023';
  END IF;

  IF v_kind = 'instrument' THEN
    IF v_instrument <> p_section THEN
      RAISE EXCEPTION 'target_not_in_scope' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.section_group_members
      WHERE group_name = p_section AND member_name = v_instrument
    ) THEN
      RAISE EXCEPTION 'target_not_in_scope' USING ERRCODE = '22023';
    END IF;

    -- 组内已有乐器部长 ⇒ 不再设组
    IF EXISTS (
      SELECT 1 FROM public.section_group_members sgm
      JOIN public.section_leaders sl ON sl.section = sgm.member_name
      WHERE sgm.group_name = p_section
    ) THEN
      RAISE EXCEPTION 'scope_overlap' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 乐器已在某个可作部长作用域的组里有部长 ⇒ 不再设该乐器
  IF v_kind = 'instrument' AND EXISTS (
    SELECT 1
    FROM public.section_group_members sgm
    JOIN public.sections g ON g.name = sgm.group_name AND g.can_lead
    JOIN public.section_leaders sl ON sl.section = sgm.group_name
    WHERE sgm.member_name = p_section
  ) THEN
    RAISE EXCEPTION 'scope_overlap' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.section_leaders (section, leader_id, assigned_by, assigned_at)
  VALUES (p_section, p_leader_id, p_actor_id, now())
  ON CONFLICT (section) DO UPDATE
    SET leader_id = EXCLUDED.leader_id,
        assigned_by = EXCLUDED.assigned_by,
        assigned_at = EXCLUDED.assigned_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_section_leader(
  p_section text,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  DELETE FROM public.section_leaders WHERE section = p_section;
END
$function$;

-- ---------------------------------------------------------------------------
-- 管理 RPC：首席
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_principal(
  p_instrument text,
  p_principal_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_instrument text;
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.sections
    WHERE name = p_instrument AND kind = 'instrument' AND can_principal
  ) THEN
    RAISE EXCEPTION 'invalid_scope: %', p_instrument USING ERRCODE = '22023';
  END IF;

  SELECT btrim(coalesce(instrument, '')) INTO v_instrument
  FROM public.profiles
  WHERE id = p_principal_id
    AND status = 'approved'::public."profileStatus"
    AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole";
  IF v_instrument IS NULL OR v_instrument = '' THEN
    RAISE EXCEPTION 'target_not_eligible' USING ERRCODE = '22023';
  END IF;
  IF v_instrument <> p_instrument THEN
    RAISE EXCEPTION 'target_not_in_scope' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.instrument_principals (instrument, principal_id, assigned_by, assigned_at)
  VALUES (p_instrument, p_principal_id, p_actor_id, now())
  ON CONFLICT (instrument) DO UPDATE
    SET principal_id = EXCLUDED.principal_id,
        assigned_by = EXCLUDED.assigned_by,
        assigned_at = EXCLUDED.assigned_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_principal(
  p_instrument text,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  DELETE FROM public.instrument_principals WHERE instrument = p_instrument;
END
$function$;

-- ---------------------------------------------------------------------------
-- 管理 RPC：团长能力（本版只落开口，UI/能力清单后续）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_grant_capability(
  p_user_id uuid,
  p_capability text,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_capability text := btrim(coalesce(p_capability, ''));
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

  IF v_capability = '' THEN
    RAISE EXCEPTION 'invalid_capability' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id
      AND status = 'approved'::public."profileStatus"
      AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole"
  ) THEN
    RAISE EXCEPTION 'target_not_eligible' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.president_capabilities (user_id, capability, granted_by, granted_at)
  VALUES (p_user_id, v_capability, p_actor_id, now())
  ON CONFLICT (user_id, capability) DO UPDATE
    SET granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_revoke_capability(
  p_user_id uuid,
  p_capability text,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_capability text := btrim(coalesce(p_capability, ''));
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

  IF v_capability = '' THEN
    RAISE EXCEPTION 'invalid_capability' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.president_capabilities
  WHERE user_id = p_user_id AND capability = v_capability;
END
$function$;

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.assert_admin_actor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.led_sections(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.principal_instruments(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.has_capability(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_capability(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.my_capabilities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_capabilities() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.my_leadership_roles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_leadership_roles() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.my_managed_sections() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_managed_sections() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_view_member_attendance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_member_attendance(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_view_rehearsal_attendance(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_rehearsal_attendance(bigint) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_manage_member_attendance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_member_attendance(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_manage_rehearsal_attendance(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_rehearsal_attendance(bigint) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_set_section_leader(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_section_leader(text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_section_leader(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_section_leader(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_principal(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_principal(text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_principal(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_principal(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_grant_capability(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_capability(uuid, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_revoke_capability(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_capability(uuid, text, uuid) TO service_role;

COMMIT;

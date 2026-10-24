-- ============================================
-- 团长能力矩阵固定 + 任命 bundle + 团长/声部长互斥（P9 前端基座）
-- ============================================
--
-- 用户 2026-10-25 固定团长 mp 能力为六项：
--   rehearsal / leave_approval / membership_approval /
--   attendance / attendance_approval / attendance_export
--
-- 本迁移只做「能力管理」和冲突 guard，不做 mp 页面、也不放开任何读策略：
--   · president_capability_keys()：六项能力的单一事实来源；
--   · admin_set_president / admin_remove_president：web 团长 tab 用，原子 grant/revoke 六项；
--   · admin_grant_capability：只允许六项之一，且目标是声部长时拒绝；
--   · admin_set_section_leader：目标已有团长能力时拒绝。
--
-- 团长与首席可以共存；团长与声部长互斥。首席表不参与这里的 guard。
--
-- 锁：沿用 20261025000000 的 `public.section_leaders` advisory lock，作为所有
-- 「团长能力 / 声部长」写路径的共享领导权锁，避免互斥检查的并发窗口。
--
-- 回滚：DROP 两个新函数，并恢复 20261023130200 / 20261025000000 中
-- admin_set_section_leader 与 admin_grant_capability 的原定义。

BEGIN;

CREATE OR REPLACE FUNCTION public.president_capability_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT ARRAY[
    'rehearsal',
    'leave_approval',
    'membership_approval',
    'attendance',
    'attendance_approval',
    'attendance_export'
  ]::text[]
$function$;

COMMENT ON FUNCTION public.president_capability_keys() IS
  '团长 mp 能力矩阵（2026-10-25 固定六项）。修改这里必须同步 web P0c 的展示与 backend 判据。';

-- ---------------------------------------------------------------------------
-- 团长 bundle：一次性授予六项 / 全部撤销
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_president(
  p_user_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id
      AND status = 'approved'::public."profileStatus"
      AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole"
  ) THEN
    RAISE EXCEPTION 'target_not_eligible' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.section_leaders WHERE leader_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'section_leader_cannot_be_president' USING ERRCODE = '22023';
  END IF;

  -- 固定矩阵：先清空再写六项，避免历史/手工能力的残留。
  DELETE FROM public.president_capabilities WHERE user_id = p_user_id;
  INSERT INTO public.president_capabilities (user_id, capability, granted_by, granted_at)
  SELECT p_user_id, t.capability, p_actor_id, now()
  FROM unnest(public.president_capability_keys()) AS t(capability);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_president(
  p_user_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);
  DELETE FROM public.president_capabilities WHERE user_id = p_user_id;
END
$function$;

-- ---------------------------------------------------------------------------
-- 低层能力 RPC：只允许固定矩阵，且拒绝声部长
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
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

  IF v_capability = '' OR NOT (v_capability = any(public.president_capability_keys())) THEN
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

  IF EXISTS (SELECT 1 FROM public.section_leaders WHERE leader_id = p_user_id) THEN
    RAISE EXCEPTION 'section_leader_cannot_be_president' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.president_capabilities (user_id, capability, granted_by, granted_at)
  VALUES (p_user_id, v_capability, p_actor_id, now())
  ON CONFLICT (user_id, capability) DO UPDATE
    SET granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at;
END
$function$;

-- ---------------------------------------------------------------------------
-- 声部长任命：拒绝已有团长能力的人
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
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

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

  IF EXISTS (SELECT 1 FROM public.president_capabilities WHERE user_id = p_leader_id) THEN
    RAISE EXCEPTION 'president_cannot_be_section_leader' USING ERRCODE = '22023';
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

    IF EXISTS (
      SELECT 1 FROM public.section_group_members sgm
      JOIN public.section_leaders sl ON sl.section = sgm.member_name
      WHERE sgm.group_name = p_section
    ) THEN
      RAISE EXCEPTION 'scope_overlap' USING ERRCODE = '22023';
    END IF;
  END IF;

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

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.president_capability_keys() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_capability_keys() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_set_president(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_president(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_president(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_president(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_grant_capability(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_capability(uuid, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_section_leader(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_section_leader(text, uuid, uuid) TO service_role;

COMMIT;

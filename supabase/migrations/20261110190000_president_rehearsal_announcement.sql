-- ============================================
-- 团长：排练编辑/删除、公告管理、审批待处理计数
-- ============================================
--
-- 本次在既有六项能力上新增第七项 `announcement`（2026-11-10 用户确认）：
-- 团长需要管理公告；公告写权限不能复用 admin 表策略，也不适合塞进 rehearsal
-- 能力，因此单独成项。`admin_set_president` 仍按 `president_capability_keys()`
-- 一次性授予全部能力，新增项会自动进入任命 bundle。
--
-- 同时补：
--   · 排练编辑/删除（user JWT；web 仍是 admin 直写表）；
--   · 公告发布/编辑/删除（user JWT；保持「同一时间只有一条有效公告」）；
--   · `president_pending_counts()`：我的页三个审批徽章的一次请求来源。
--
-- 排练编辑的时间/类型/曲目更新顺序：先改非时间字段、替换曲目，最后写
-- start_time/end_time。补名单触发器挂在 start_time/end_time 上，这样它会按
-- **新的曲目**补缺失行；已有考勤行不动（用户 2026-11-10 定的口径）。
--
-- 回滚：恢复 20261025010000 的 president_capability_keys；DROP 本次新增函数；
-- 删除本次插入的 announcement 能力行（若确实要回滚）。

BEGIN;

-- ---------------------------------------------------------------------------
-- 能力矩阵：六项 → 七项
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_capability_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT ARRAY[
    'rehearsal',
    'leave_approval',
    'membership_approval',
    'announcement',
    'attendance',
    'attendance_approval',
    'attendance_export'
  ]::text[]
$function$;

COMMENT ON FUNCTION public.president_capability_keys() IS
  '团长 mp 能力矩阵（2026-11-10 起七项）。改这里必须同步 web P0c 的展示与 mp 的 useMyCapabilities。';

-- 已有团长（只要原先有任意能力）补发公告能力。当前 dev/prod 均为 0 行，
-- 这段是给未来环境/分支上的存量数据兜底。
INSERT INTO public.president_capabilities (user_id, capability)
SELECT DISTINCT c.user_id, 'announcement'
FROM public.president_capabilities c
ON CONFLICT (user_id, capability) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 审批徽章计数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_pending_counts()
RETURNS TABLE (
  leave_pending             integer,
  membership_pending        integer,
  attendance_change_pending integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    CASE WHEN public.has_capability('leave_approval') THEN (
      SELECT count(*)::integer
      FROM public.leave_requests lr
      WHERE lr.status = 'pending'::public."leaveStatus"
        AND lr.user_id <> auth.uid()
    ) ELSE 0 END,
    CASE WHEN public.has_capability('membership_approval') THEN (
      SELECT count(*)::integer
      FROM public.profiles p
      WHERE p.status = 'pending'::public."profileStatus"
        AND p.id <> auth.uid()
    ) ELSE 0 END,
    CASE WHEN public.has_capability('attendance_approval') THEN (
      SELECT count(*)::integer
      FROM public.attendance_change_requests acr
      WHERE acr.status = 'pending'::public."attendanceChangeRequestStatus"
        AND acr.requested_by <> auth.uid()
    ) ELSE 0 END;
END
$function$;

COMMENT ON FUNCTION public.president_pending_counts() IS
  '我的页审批徽章：只统计当前用户有对应能力、且不是自己提交的待处理项。';

-- ---------------------------------------------------------------------------
-- 公告管理
-- ---------------------------------------------------------------------------
-- 同时只允许一条有效公告（end_time > now()）。用户已经确认沿用 web 规则。
-- 写路径全部经 SECURITY DEFINER RPC，公告表本身仍只给 authenticated SELECT。
CREATE OR REPLACE FUNCTION public.president_publish_announcement(
  p_title text,
  p_content text,
  p_end_time timestamptz,
  p_replace_active boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_title  text := nullif(btrim(coalesce(p_title, '')), '');
  v_body   text := nullif(btrim(coalesce(p_content, '')), '');
  v_active public.announcements%ROWTYPE;
  v_id     uuid;
BEGIN
  PERFORM public.president_require_capability('announcement');

  IF v_title IS NULL OR v_body IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'content_required');
  END IF;
  IF p_end_time IS NULL OR p_end_time <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_end_time');
  END IF;

  -- 串行化「查有效公告 → 结束旧公告 → 插入新公告」
  PERFORM pg_advisory_xact_lock(hashtext('public.announcements.active')::bigint);

  SELECT * INTO v_active
  FROM public.announcements
  WHERE end_time > now()
  ORDER BY end_time DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND NOT coalesce(p_replace_active, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'active_exists',
      'active_id', v_active.id,
      'active_title', v_active.title,
      'active_end_time', v_active.end_time
    );
  END IF;

  IF FOUND THEN
    UPDATE public.announcements
    SET end_time = now()
    WHERE end_time > now();
  END IF;

  INSERT INTO public.announcements (title, content, end_time)
  VALUES (v_title, v_body, p_end_time)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.president_update_announcement(
  p_id uuid,
  p_title text,
  p_content text,
  p_end_time timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_title  text := nullif(btrim(coalesce(p_title, '')), '');
  v_body   text := nullif(btrim(coalesce(p_content, '')), '');
  v_active public.announcements%ROWTYPE;
BEGIN
  PERFORM public.president_require_capability('announcement');

  IF v_title IS NULL OR v_body IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'content_required');
  END IF;
  IF p_end_time IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_end_time');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.announcements.active')::bigint);

  IF NOT EXISTS (SELECT 1 FROM public.announcements WHERE id = p_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  -- 把一条过期公告改回有效时，不允许制造第二条有效公告。
  IF p_end_time > now() THEN
    SELECT * INTO v_active
    FROM public.announcements
    WHERE id <> p_id AND end_time > now()
    ORDER BY end_time DESC, created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'active_exists',
        'active_id', v_active.id,
        'active_title', v_active.title,
        'active_end_time', v_active.end_time
      );
    END IF;
  END IF;

  UPDATE public.announcements
  SET title = v_title,
      content = v_body,
      end_time = p_end_time
  WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'id', p_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.president_delete_announcement(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted uuid;
BEGIN
  PERFORM public.president_require_capability('announcement');

  PERFORM pg_advisory_xact_lock(hashtext('public.announcements.active')::bigint);

  DELETE FROM public.announcements
  WHERE id = p_id
  RETURNING id INTO v_deleted;

  IF v_deleted IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_deleted);
END
$function$;

-- ---------------------------------------------------------------------------
-- 排练编辑 / 删除
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_update_rehearsal(
  p_rehearsal_id bigint,
  p_rehearsal jsonb,
  p_pieces jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_old            public.rehearsals%ROWTYPE;
  v_location_id    uuid := NULLIF(p_rehearsal->>'location_id', '')::uuid;
  v_location_name  text;
  v_lat            double precision;
  v_lng            double precision;
  v_radius_m       integer;
  v_type           text;
  v_target_section text[];
  v_location       text;
  v_repertoire     text;
  v_sign_in_code   text;
  v_start          text;
  v_end            text;
BEGIN
  PERFORM public.president_require_capability('rehearsal');

  IF jsonb_typeof(p_pieces) <> 'array' THEN
    RAISE EXCEPTION 'pieces_must_be_array' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old
  FROM public.rehearsals
  WHERE id = p_rehearsal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_location_id IS NOT NULL THEN
    SELECT l.name, l.lat, l.lng, l.radius_m
      INTO v_location_name, v_lat, v_lng, v_radius_m
    FROM public.rehearsal_locations l
    WHERE l.id = v_location_id AND l.active;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'location_not_found');
    END IF;
  END IF;

  v_type := coalesce(nullif(p_rehearsal->>'type', ''), v_old.type, 'full');

  IF p_rehearsal ? 'target_section' THEN
    SELECT coalesce(array_agg(value), '{}'::text[])
      INTO v_target_section
    FROM jsonb_array_elements_text(p_rehearsal->'target_section') AS t(value);
  ELSE
    v_target_section := v_old.target_section;
  END IF;

  v_location := coalesce(v_location_name, p_rehearsal->>'location', v_old.location);
  v_repertoire := coalesce(p_rehearsal->>'repertoire', v_old.repertoire);

  IF p_rehearsal ? 'sign_in_code' THEN
    v_sign_in_code := NULLIF(p_rehearsal->>'sign_in_code', '');
  ELSE
    v_sign_in_code := v_old.sign_in_code;
  END IF;

  v_start := coalesce(p_rehearsal->>'start_time', v_old.start_time);
  v_end := coalesce(p_rehearsal->>'end_time', v_old.end_time);

  -- 第 1 步：先改非时间字段（这一步不会触发补名单）
  UPDATE public.rehearsals
  SET type = v_type,
      target_section = v_target_section,
      location = v_location,
      repertoire = v_repertoire,
      sign_in_code = v_sign_in_code,
      checkin_lat = coalesce(v_lat, (p_rehearsal->>'checkin_lat')::double precision, v_old.checkin_lat),
      checkin_lng = coalesce(v_lng, (p_rehearsal->>'checkin_lng')::double precision, v_old.checkin_lng),
      checkin_radius_m = coalesce(v_radius_m, (p_rehearsal->>'checkin_radius_m')::integer, v_old.checkin_radius_m)
  WHERE id = p_rehearsal_id;

  -- 第 2 步：替换曲目
  DELETE FROM public.rehearsal_repertoire WHERE rehearsal_id = p_rehearsal_id;

  INSERT INTO public.rehearsal_repertoire (rehearsal_id, sheet_music_id, title, content, sort_order)
  SELECT
    p_rehearsal_id,
    NULLIF(elem->>'sheet_music_id', '')::uuid,
    btrim(elem->>'title'),
    NULLIF(btrim(elem->>'content'), ''),
    coalesce((elem->>'sort_order')::integer, (ord - 1)::integer)
  FROM jsonb_array_elements(p_pieces) WITH ORDINALITY AS t(elem, ord);

  -- 第 3 步：最后写时间；补名单触发器此时按新曲目补缺失行，已有行不动
  UPDATE public.rehearsals
  SET start_time = v_start,
      end_time = v_end
  WHERE id = p_rehearsal_id;

  RETURN jsonb_build_object('ok', true, 'rehearsal_id', p_rehearsal_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.president_delete_rehearsal(p_rehearsal_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  PERFORM public.president_require_capability('rehearsal');

  DELETE FROM public.rehearsals
  WHERE id = p_rehearsal_id
  RETURNING id INTO v_deleted;

  IF v_deleted IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'rehearsal_id', v_deleted);
END
$function$;

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.president_capability_keys() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_capability_keys() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_pending_counts() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_publish_announcement(text, text, timestamptz, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_publish_announcement(text, text, timestamptz, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_update_announcement(uuid, text, text, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_update_announcement(uuid, text, text, timestamptz)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_delete_announcement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_delete_announcement(uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_update_rehearsal(bigint, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_update_rehearsal(bigint, jsonb, jsonb)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_delete_rehearsal(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_delete_rehearsal(bigint)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.president_publish_announcement(text, text, timestamptz, boolean) IS
  '团长发布公告（announcement）；默认拒绝覆盖有效公告，p_replace_active 为真时先结束旧的。';
COMMENT ON FUNCTION public.president_update_announcement(uuid, text, text, timestamptz) IS
  '团长编辑公告（announcement）；不允许制造第二条有效公告。';
COMMENT ON FUNCTION public.president_delete_announcement(uuid) IS
  '团长删除公告（announcement）。';
COMMENT ON FUNCTION public.president_update_rehearsal(bigint, jsonb, jsonb) IS
  '团长编辑排练（rehearsal）；已有考勤保留，补名单按新曲目只补缺失行。';
COMMENT ON FUNCTION public.president_delete_rehearsal(bigint) IS
  '团长删除排练（rehearsal）；attendances / leave_requests 等按既有级联处理。';

COMMIT;

-- ============================================
-- 团长后端 RPC（batch 1）
-- ============================================
--
-- 小程序端团长用**用户 JWT**直接调用这些 RPC（不是 service_role）：
--   · 请假审批（leave_approval）
--   · 入团审批（membership_approval）
--   · 考勤修改申请审批（attendance_approval）
--   · 直接修改考勤（attendance）
--   · 考勤导出数据（attendance_export）
--
-- 授权一律走 `has_capability()`（admin 也在它的返回里），不放开宽 RLS。
--
-- 几个刻意保留的语义：
--   · 审批人不能处理**自己提出**的申请（请假 / 考勤修改；入团审批排除自己）；
--   · 请假通过联动考勤时，沿用 web 的「已签到 / exempt 不覆盖」守卫；
--   · 入团审批改 `profiles.status` 时，用**事务级 GUC 窄口**放行
--     `guard_profile_privileged_columns`，只允许 pending → approved/rejected 的
--     那一次更新，`role` 仍必须保持不变；不把 `has_capability` 写进表级触发器，
--     否则任何能调用该能力的人都能绕过触发器改 role；
--   · 团长直改考勤只接受 present/absent/excused，不写通知（产品口径）；
--   · 导出只返回行，CSV 由小程序生成，服务端不落文件。

BEGIN;

-- ---------------------------------------------------------------------------
-- 通用能力校验
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_require_capability(p_capability text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_capability(p_capability) THEN
    RAISE EXCEPTION 'capability_required' USING ERRCODE = '42501';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------
-- 请假审批
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_list_leave_requests()
RETURNS TABLE (
  request_id            uuid,
  rehearsal_id          bigint,
  user_id               uuid,
  user_name             text,
  user_instrument       text,
  target_status         public."attendanceStatus",
  status                public."leaveStatus",
  reason                text,
  attachment_url        text,
  reject_reason         text,
  created_at            timestamptz,
  rehearsal_type        text,
  rehearsal_title       text,
  rehearsal_repertoire  text,
  rehearsal_location    text,
  rehearsal_start       text,
  rehearsal_end         text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.president_require_capability('leave_approval');

  RETURN QUERY
  SELECT
    lr.id,
    lr.rehearsal_id,
    lr.user_id,
    p.full_name,
    p.instrument,
    lr.target_status,
    lr.status,
    lr.reason,
    lr.attachment_url,
    lr.reject_reason,
    lr.created_at,
    r.type,
    r.title,
    r.repertoire,
    r.location,
    r.start_time,
    r.end_time
  FROM public.leave_requests lr
  LEFT JOIN public.profiles p ON p.id = lr.user_id
  LEFT JOIN public.rehearsals r ON r.id = lr.rehearsal_id
  ORDER BY lr.created_at DESC;
END
$function$;

CREATE OR REPLACE FUNCTION public.president_decide_leave_request(
  p_request_id uuid,
  p_approve boolean,
  p_reject_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_req         public.leave_requests%ROWTYPE;
  v_att_status  public."attendanceStatus";
  v_sign_in     timestamp;
  v_reason      text := nullif(btrim(coalesce(p_reject_reason, '')), '');
  v_warning     text;
  v_start       text;
  v_type        text;
  v_repertoire  text;
  v_rehearsal_title text;
  v_date        text := '';
  v_type_word   text := '';
  v_name        text;
  v_content     text;
BEGIN
  PERFORM public.president_require_capability('leave_approval');

  SELECT * INTO v_req
  FROM public.leave_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_req.status <> 'pending'::public."leaveStatus" THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;
  -- 审批人不处理自己的申请
  IF v_req.user_id = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval_not_allowed');
  END IF;

  SELECT r.start_time, r.type, r.repertoire, r.title
    INTO v_start, v_type, v_repertoire, v_rehearsal_title
  FROM public.rehearsals r
  WHERE r.id = v_req.rehearsal_id;

  IF p_approve THEN
    SELECT a.status, a.sign_in_time
      INTO v_att_status, v_sign_in
    FROM public.attendances a
    WHERE a.rehearsal_id = v_req.rehearsal_id
      AND a.user_id = v_req.user_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_sign_in IS NOT NULL THEN
        -- 已实际签到：不覆盖签到记录，申请照常通过
        v_warning := 'signed_in';
      ELSIF v_att_status = 'exempt'::public."attendanceStatus" THEN
        -- 无需出勤：保持原状态，申请照常通过
        v_warning := 'exempt';
      ELSE
        UPDATE public.attendances
        SET status = v_req.target_status,
            updated_by = auth.uid()
        WHERE rehearsal_id = v_req.rehearsal_id
          AND user_id = v_req.user_id;
      END IF;
    ELSE
      INSERT INTO public.attendances (rehearsal_id, user_id, status, updated_by)
      VALUES (v_req.rehearsal_id, v_req.user_id, v_req.target_status, auth.uid());
    END IF;

    UPDATE public.leave_requests
    SET status = 'approved'::public."leaveStatus"
    WHERE id = p_request_id;

    -- 通知文案与 web 的 insertLeaveNotification 保持一致（best-effort）
    IF v_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      v_date := ltrim(substring(v_start from 6 for 2), '0') || '月'
                || ltrim(substring(v_start from 9 for 2), '0') || '日';
    END IF;
    v_type_word := CASE v_type
      WHEN 'full' THEN '合排'
      WHEN 'section' THEN '分排'
      ELSE ''
    END;
    v_name := coalesce(
      nullif(btrim(v_repertoire), ''),
      nullif(btrim(v_rehearsal_title), ''),
      '排练'
    );
    v_content := v_date || '《' || v_name || '》的' || v_type_word || '请假申请已通过';

    BEGIN
      INSERT INTO public.notifications (user_id, category, title, content)
      VALUES (
        v_req.user_id,
        'attendance'::public."notificationCategory",
        '请假申请已通过',
        v_content
      );
    EXCEPTION WHEN OTHERS THEN
      -- 通知失败不阻断审批主操作
      NULL;
    END;

    RETURN jsonb_build_object(
      'ok', true,
      'request_id', p_request_id,
      'status', 'approved',
      'warning', v_warning
    );
  ELSE
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'reject_reason_required');
    END IF;

    UPDATE public.leave_requests
    SET status = 'rejected'::public."leaveStatus",
        reject_reason = v_reason
    WHERE id = p_request_id;

    IF v_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      v_date := ltrim(substring(v_start from 6 for 2), '0') || '月'
                || ltrim(substring(v_start from 9 for 2), '0') || '日';
    END IF;
    v_type_word := CASE v_type
      WHEN 'full' THEN '合排'
      WHEN 'section' THEN '分排'
      ELSE ''
    END;
    v_name := coalesce(
      nullif(btrim(v_repertoire), ''),
      nullif(btrim(v_rehearsal_title), ''),
      '排练'
    );
    v_content := v_date || '《' || v_name || '》的' || v_type_word
                 || '请假申请已被驳回，原因：' || v_reason;

    BEGIN
      INSERT INTO public.notifications (user_id, category, title, content)
      VALUES (
        v_req.user_id,
        'attendance'::public."notificationCategory",
        '请假申请被驳回',
        v_content
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'ok', true,
      'request_id', p_request_id,
      'status', 'rejected'
    );
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------
-- 入团审批
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_list_membership_requests()
RETURNS TABLE (
  user_id     uuid,
  full_name   text,
  instrument  text,
  email       text,
  created_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.president_require_capability('membership_approval');

  RETURN QUERY
  SELECT p.id, p.full_name, p.instrument, p.email, p.created_at
  FROM public.profiles p
  WHERE p.status = 'pending'::public."profileStatus"
  ORDER BY p.created_at ASC;
END
$function$;

CREATE OR REPLACE FUNCTION public.president_decide_membership_request(
  p_user_id uuid,
  p_approve boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile    public.profiles%ROWTYPE;
  v_info       public.member_info%ROWTYPE;
  v_norm       text;
  v_instrument text;
BEGIN
  PERFORM public.president_require_capability('membership_approval');

  IF p_user_id = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval_not_allowed');
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_profile.status <> 'pending'::public."profileStatus" THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;

  IF p_approve THEN
    -- 与 web 的 /api/admin/approve 一致：按姓名从 member_info 预填空字段（best-effort）
    IF nullif(btrim(v_profile.full_name), '') IS NOT NULL THEN
      SELECT * INTO v_info
      FROM public.member_info
      WHERE full_name = v_profile.full_name
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1;
    END IF;

    IF v_info.id IS NOT NULL
       AND nullif(btrim(v_profile.instrument), '') IS NULL
       AND nullif(btrim(v_info.instrument_name), '') IS NOT NULL THEN
      v_norm := lower(btrim(v_info.instrument_name));
      v_instrument := CASE v_norm
        WHEN '一提' THEN '第一小提琴'
        WHEN '一小' THEN '第一小提琴'
        WHEN '第一小提琴' THEN '第一小提琴'
        WHEN '1st violin' THEN '第一小提琴'
        WHEN '二提' THEN '第二小提琴'
        WHEN '二小' THEN '第二小提琴'
        WHEN '第二小提琴' THEN '第二小提琴'
        WHEN '2nd violin' THEN '第二小提琴'
        WHEN '中提' THEN '中提琴'
        WHEN '中提琴' THEN '中提琴'
        WHEN 'viola' THEN '中提琴'
        WHEN '大提' THEN '大提琴'
        WHEN '大提琴' THEN '大提琴'
        WHEN 'cello' THEN '大提琴'
        WHEN '低音提' THEN '低音提琴'
        WHEN '低音提琴' THEN '低音提琴'
        WHEN 'double bass' THEN '低音提琴'
        WHEN '贝斯' THEN '低音提琴'
        WHEN 'bass' THEN '低音提琴'
        WHEN '长笛' THEN '长笛'
        WHEN 'flute' THEN '长笛'
        WHEN '双簧管' THEN '双簧管'
        WHEN 'oboe' THEN '双簧管'
        WHEN '欧宝' THEN '双簧管'
        WHEN '单簧管' THEN '单簧管'
        WHEN '黑管' THEN '单簧管'
        WHEN 'clarinet' THEN '单簧管'
        WHEN '大管' THEN '大管'
        WHEN '巴松' THEN '大管'
        WHEN 'bassoon' THEN '大管'
        WHEN '圆号' THEN '圆号'
        WHEN 'horn' THEN '圆号'
        WHEN '小号' THEN '小号'
        WHEN 'trumpet' THEN '小号'
        WHEN '长号' THEN '长号'
        WHEN 'trombone' THEN '长号'
        WHEN '大号' THEN '大号'
        WHEN 'tuba' THEN '大号'
        WHEN '打击乐' THEN '打击乐'
        WHEN '打击' THEN '打击乐'
        WHEN 'percussion' THEN '打击乐'
        WHEN '键盘' THEN '键盘'
        WHEN '钢琴' THEN '键盘'
        WHEN 'keyboard' THEN '键盘'
        WHEN '竖琴' THEN '竖琴'
        WHEN 'harp' THEN '竖琴'
        WHEN '其他' THEN '其他'
        ELSE CASE
          WHEN EXISTS (
            SELECT 1 FROM public.sections s
            WHERE s.name = btrim(v_info.instrument_name)
              AND s.kind = 'instrument'
          ) THEN btrim(v_info.instrument_name)
          ELSE '其他'
        END
      END;
    END IF;

    -- 窄口：只放行这一次 pending → approved 的更新；触发器仍要求 role 不变
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'on', true);
    BEGIN
      UPDATE public.profiles
      SET status = 'approved'::public."profileStatus",
          email = coalesce(nullif(btrim(email), ''), nullif(btrim(v_info.email), '')),
          college = coalesce(nullif(btrim(college), ''), nullif(btrim(v_info.college), '')),
          instrument = coalesce(nullif(btrim(instrument), ''), v_instrument)
      WHERE id = p_user_id;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);
      RAISE;
    END;
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);

    RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', 'approved');
  ELSE
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'on', true);
    BEGIN
      UPDATE public.profiles
      SET status = 'rejected'::public."profileStatus"
      WHERE id = p_user_id;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);
      RAISE;
    END;
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);

    RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', 'rejected');
  END IF;
END
$function$;

-- 现有触发器加上事务级 GUC 窄口。role 的任何变化仍然被拒绝。
CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- service_role 走的是 API route / Edge Function / CI，它们本来就有权写这两列
  IF auth.role() = 'service_role' OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- 入团审批 RPC 在事务内打开的一次性窄口：只允许 pending → approved/rejected，
  -- 且 role 必须保持不变。客户端无法设置这个 GUC（set_config 可用但没有暴露的
  -- SECURITY DEFINER 入口），因此不能拿它绕过 role 守卫。
  IF TG_OP = 'UPDATE'
     AND pg_catalog.current_setting('pkuso.allow_membership_decision', true) = 'on'
     AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND OLD.status = 'pending'::public."profileStatus"
     AND NEW.status IN (
       'approved'::public."profileStatus",
       'rejected'::public."profileStatus"
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'member'::public."profileRole"
       OR NEW.status IS DISTINCT FROM 'pending'::public."profileStatus" THEN
      RAISE EXCEPTION 'cannot self-assign profile.role or profile.status on insert'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'cannot modify profile.role'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'cannot modify profile.status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 考勤修改申请审批
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_list_attendance_change_requests()
RETURNS TABLE (
  request_id             uuid,
  rehearsal_id           bigint,
  target_user_id         uuid,
  target_name            text,
  target_instrument      text,
  requested_by           uuid,
  requester_name         text,
  requester_instrument   text,
  from_status            public."attendanceStatus",
  to_status              public."attendanceStatus",
  reason                 text,
  status                 public."attendanceChangeRequestStatus",
  reject_reason          text,
  created_at             timestamptz,
  decided_at             timestamptz,
  rehearsal_type         text,
  rehearsal_title        text,
  rehearsal_repertoire   text,
  rehearsal_location     text,
  rehearsal_start        text,
  rehearsal_end          text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.president_require_capability('attendance_approval');

  RETURN QUERY
  SELECT
    acr.id,
    acr.rehearsal_id,
    acr.target_user_id,
    tp.full_name,
    tp.instrument,
    acr.requested_by,
    rp.full_name,
    rp.instrument,
    acr.from_status,
    acr.to_status,
    acr.reason,
    acr.status,
    acr.reject_reason,
    acr.created_at,
    acr.decided_at,
    r.type,
    r.title,
    r.repertoire,
    r.location,
    r.start_time,
    r.end_time
  FROM public.attendance_change_requests acr
  LEFT JOIN public.profiles tp ON tp.id = acr.target_user_id
  LEFT JOIN public.profiles rp ON rp.id = acr.requested_by
  LEFT JOIN public.rehearsals r ON r.id = acr.rehearsal_id
  WHERE acr.status IN (
    'pending'::public."attendanceChangeRequestStatus",
    'approved'::public."attendanceChangeRequestStatus",
    'rejected'::public."attendanceChangeRequestStatus"
  )
  ORDER BY acr.created_at DESC;
END
$function$;

-- 审批核心：从原 admin_decide_attendance_change_request 抽出，调用方负责鉴权。
CREATE OR REPLACE FUNCTION public.decide_attendance_change_request_core(
  p_request_id uuid,
  p_approve boolean,
  p_reject_reason text,
  p_force boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_req     public.attendance_change_requests%ROWTYPE;
  v_current public."attendanceStatus";
  v_reason  text := nullif(btrim(coalesce(p_reject_reason, '')), '');
BEGIN
  SELECT * INTO v_req
  FROM public.attendance_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_req.status <> 'pending'::public."attendanceChangeRequestStatus" THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;

  IF p_approve THEN
    SELECT status INTO v_current
    FROM public.attendances
    WHERE rehearsal_id = v_req.rehearsal_id AND user_id = v_req.target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'attendance_missing');
    END IF;
    IF v_current IS DISTINCT FROM v_req.from_status AND NOT p_force THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'stale',
        'current_status', v_current::text
      );
    END IF;

    UPDATE public.attendances
    SET status = v_req.to_status,
        updated_by = p_actor_id
    WHERE rehearsal_id = v_req.rehearsal_id AND user_id = v_req.target_user_id;

    UPDATE public.attendance_change_requests
    SET status = 'approved'::public."attendanceChangeRequestStatus",
        decided_by = p_actor_id,
        decided_at = now()
    WHERE id = p_request_id;

    INSERT INTO public.notifications (user_id, category, title, content, kind, meta)
    VALUES (
      v_req.requested_by,
      'attendance'::public."notificationCategory",
      '考勤修改申请已通过',
      '你的考勤修改申请已通过。',
      'attendance_change_request',
      jsonb_build_object('request_id', p_request_id)
    );

    RETURN jsonb_build_object('ok', true, 'request_id', p_request_id, 'status', 'approved');
  ELSE
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'reject_reason_required');
    END IF;

    UPDATE public.attendance_change_requests
    SET status = 'rejected'::public."attendanceChangeRequestStatus",
        decided_by = p_actor_id,
        decided_at = now(),
        reject_reason = v_reason
    WHERE id = p_request_id;

    INSERT INTO public.notifications (user_id, category, title, content, kind, meta)
    VALUES (
      v_req.requested_by,
      'attendance'::public."notificationCategory",
      '考勤修改申请已驳回',
      '驳回原因：' || v_reason,
      'attendance_change_request',
      jsonb_build_object('request_id', p_request_id)
    );

    RETURN jsonb_build_object('ok', true, 'request_id', p_request_id, 'status', 'rejected');
  END IF;
END
$function$;

-- 保留管理员入口，行为不变
CREATE OR REPLACE FUNCTION public.admin_decide_attendance_change_request(
  p_request_id uuid,
  p_approve boolean,
  p_reject_reason text,
  p_force boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  RETURN public.decide_attendance_change_request_core(
    p_request_id, p_approve, p_reject_reason, p_force, p_actor_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.president_decide_attendance_change_request(
  p_request_id uuid,
  p_approve boolean,
  p_reject_reason text DEFAULT NULL,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_requested_by uuid;
BEGIN
  PERFORM public.president_require_capability('attendance_approval');

  SELECT requested_by INTO v_requested_by
  FROM public.attendance_change_requests
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_requested_by = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval_not_allowed');
  END IF;

  RETURN public.decide_attendance_change_request_core(
    p_request_id, p_approve, p_reject_reason, p_force, auth.uid()
  );
END
$function$;

-- ---------------------------------------------------------------------------
-- 团长直改考勤
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_update_attendance(
  p_rehearsal_id bigint,
  p_user_id uuid,
  p_status public."attendanceStatus"
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_current public."attendanceStatus";
  v_sign_in timestamp;
  v_id      bigint;
  v_created boolean := false;
BEGIN
  PERFORM public.president_require_capability('attendance');

  IF p_status IS NULL
     OR p_status NOT IN (
       'present'::public."attendanceStatus",
       'absent'::public."attendanceStatus",
       'excused'::public."attendanceStatus"
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_status');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.rehearsals r WHERE r.id = p_rehearsal_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'rehearsal_not_found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user_id
      AND p.status = 'approved'::public."profileStatus"
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'member_not_found');
  END IF;

  SELECT a.status, a.sign_in_time
    INTO v_current, v_sign_in
  FROM public.attendances a
  WHERE a.rehearsal_id = p_rehearsal_id AND a.user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_current = 'exempt'::public."attendanceStatus" THEN
      RETURN jsonb_build_object('ok', false, 'code', 'exempt_not_editable');
    END IF;

    UPDATE public.attendances
    SET status = p_status,
        updated_by = auth.uid()
    WHERE rehearsal_id = p_rehearsal_id AND user_id = p_user_id;
  ELSE
    INSERT INTO public.attendances (rehearsal_id, user_id, status, updated_by)
    VALUES (p_rehearsal_id, p_user_id, p_status, auth.uid())
    RETURNING id INTO v_id;
    v_created := true;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'rehearsal_id', p_rehearsal_id,
    'user_id', p_user_id,
    'status', p_status::text,
    'created', v_created
  );
END
$function$;

-- ---------------------------------------------------------------------------
-- 考勤导出数据（CSV 由小程序生成）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_attendance_export(
  p_rehearsal_id bigint DEFAULT NULL,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL
)
RETURNS TABLE (
  rehearsal_id          bigint,
  rehearsal_start       text,
  rehearsal_end         text,
  rehearsal_type        text,
  rehearsal_title       text,
  rehearsal_repertoire  text,
  rehearsal_location    text,
  user_id               uuid,
  full_name             text,
  email                 text,
  instrument            text,
  is_in_orchestra       boolean,
  status                public."attendanceStatus",
  sign_in_time          timestamp,
  updated_at            timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.president_require_capability('attendance_export');

  RETURN QUERY
  SELECT
    a.rehearsal_id,
    r.start_time,
    r.end_time,
    r.type,
    r.title,
    r.repertoire,
    r.location,
    a.user_id,
    p.full_name,
    p.email,
    p.instrument,
    p.is_in_orchestra,
    a.status,
    a.sign_in_time,
    a.updated_at
  FROM public.attendances a
  JOIN public.rehearsals r ON r.id = a.rehearsal_id
  LEFT JOIN public.profiles p ON p.id = a.user_id
  WHERE (p_rehearsal_id IS NULL OR a.rehearsal_id = p_rehearsal_id)
    AND (
      p_start_date IS NULL
      OR (
        CASE
          WHEN left(r.start_time, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN left(r.start_time, 10)::date
        END
      ) >= p_start_date
    )
    AND (
      p_end_date IS NULL
      OR (
        CASE
          WHEN left(r.start_time, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN left(r.start_time, 10)::date
        END
      ) <= p_end_date
    )
  ORDER BY r.start_time DESC NULLS LAST, p.full_name NULLS LAST;
END
$function$;

-- ---------------------------------------------------------------------------
-- 请假附件：团长审批可读（storage 签名 URL 需要 SELECT 权限）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "leave-attachments: 团长审批可读" ON storage.objects;
CREATE POLICY "leave-attachments: 团长审批可读"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'leave-attachments'
    AND public.has_capability('leave_approval')
  );

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.president_require_capability(text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.president_list_leave_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_list_leave_requests() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_decide_leave_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_decide_leave_request(uuid, boolean, text)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_list_membership_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_list_membership_requests()
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_decide_membership_request(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_decide_membership_request(uuid, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_list_attendance_change_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_list_attendance_change_requests()
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.decide_attendance_change_request_core(uuid, boolean, text, boolean, uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_decide_attendance_change_request(uuid, boolean, text, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decide_attendance_change_request(uuid, boolean, text, boolean, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.president_decide_attendance_change_request(uuid, boolean, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_decide_attendance_change_request(uuid, boolean, text, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_update_attendance(bigint, uuid, public."attendanceStatus")
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_update_attendance(bigint, uuid, public."attendanceStatus")
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_attendance_export(bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_attendance_export(bigint, date, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.president_list_leave_requests() IS
  '团长请假审批列表（leave_approval）。';
COMMENT ON FUNCTION public.president_decide_leave_request(uuid, boolean, text) IS
  '团长通过/驳回请假（leave_approval）；通过时联动考勤并保留已签到/exempt 守卫。';
COMMENT ON FUNCTION public.president_list_membership_requests() IS
  '团长入团审批列表（membership_approval）。';
COMMENT ON FUNCTION public.president_decide_membership_request(uuid, boolean) IS
  '团长通过/驳回入团（membership_approval）；通过时 best-effort 从 member_info 预填。';
COMMENT ON FUNCTION public.president_list_attendance_change_requests() IS
  '团长考勤修改申请列表（attendance_approval）。';
COMMENT ON FUNCTION public.president_decide_attendance_change_request(uuid, boolean, text, boolean) IS
  '团长审批考勤修改申请（attendance_approval）；复用 admin 核心，排除自己的申请。';
COMMENT ON FUNCTION public.president_update_attendance(bigint, uuid, public."attendanceStatus") IS
  '团长直接修改考勤（attendance）；只接受 present/absent/excused，exempt 不可编辑。';
COMMENT ON FUNCTION public.president_attendance_export(bigint, date, date) IS
  '团长考勤导出数据（attendance_export）；CSV 由客户端生成。';

COMMIT;

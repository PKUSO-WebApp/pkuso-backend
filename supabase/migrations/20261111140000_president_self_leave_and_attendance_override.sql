-- ============================================
-- 团长权限放宽：可审批自己的请假；可改所有考勤状态
-- ============================================
--
-- 用户 2026-11-11 决定：
--   1. 团长可以审批自己的请假申请（原来沿用了「审批人不处理自己的申请」的通用规则，
--      但本组织可能只有一位团长，导致自己的请假永远无人审批）；
--   2. 团长直改考勤应当「什么都能改」，包括无需出勤（exempt）与存量迟到（late）。
--      原来的直改 RPC 只接受 present/absent/excused，是从「修改申请可选项」抄来的；
--      exempt 被视为系统计算值，不允许手动覆盖。现在团长按管理员口径覆盖。
--
-- 同时把审批徽章的 leave 计数改为包含自己的待处理申请。
-- 入团审批仍排除自己（团长不可能有待审批的入团申请）。
--
-- 回滚：恢复 20261110190000 中 president_decide_leave_request 的自审拦截、
-- president_pending_counts 的 leave requested_by 过滤，以及
-- 20261110160000 中 president_update_attendance 的三状态白名单与 exempt 拦截。

BEGIN;

-- ---------------------------------------------------------------------------
-- 请假审批：不再排除自己的申请
-- ---------------------------------------------------------------------------
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
  -- 不排除 v_req.user_id = auth.uid()：团长可以审批自己的请假申请。

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
-- 考勤直改：允许所有状态（含 exempt / late）
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
  v_id      bigint;
  v_created boolean := false;
BEGIN
  PERFORM public.president_require_capability('attendance');

  IF p_status IS NULL THEN
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

  SELECT a.status
    INTO v_current
  FROM public.attendances a
  WHERE a.rehearsal_id = p_rehearsal_id AND a.user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    -- 团长可以覆盖任何状态，包括系统计算的 exempt
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
-- 审批徽章：请假计数包含自己的待处理申请
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
    ) ELSE 0 END;
END
$function$;

REVOKE ALL ON FUNCTION public.president_decide_leave_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_decide_leave_request(uuid, boolean, text)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_update_attendance(bigint, uuid, public."attendanceStatus")
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_update_attendance(bigint, uuid, public."attendanceStatus")
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_pending_counts() TO authenticated, service_role;

COMMENT ON FUNCTION public.president_decide_leave_request(uuid, boolean, text) IS
  '团长通过/驳回请假（leave_approval）；允许审批自己的申请。';
COMMENT ON FUNCTION public.president_update_attendance(bigint, uuid, public."attendanceStatus") IS
  '团长直接修改考勤（attendance）；允许所有状态，包括 exempt / late。';
COMMENT ON FUNCTION public.president_pending_counts() IS
  '我的页审批徽章；请假/考勤修改包含自己，入团仍排除自己。';

COMMIT;

-- ============================================
-- 出勤修改申请：审计列 + P1 声部请假 RPC + 成员/审批 RPC（P3-2）
-- ============================================
--
-- 本迁移接 `20261023140000` 的表，落：
--   · `attendances.updated_by/updated_at` + BEFORE 审计触发器；
--   · `get_section_leave_requests`（P1，跨排练、含取消、可按排练筛、无理由/附件）；
--   · `create/cancel_attendance_change_request`（成员 RPC；理由可选；to_status 含 exempt）；
--   · `admin_decide_attendance_change_request`（service_role；stale/force；通知申请人）；
--   · Realtime publication 加表。
--
-- 团长审批：本版只留 service_role 的 admin RPC；团长（mp，用户 JWT）的审批 RPC
-- 等团长功能开发时再加，函数内用 has_capability('approval') 或等价判据。

BEGIN;

-- ---------------------------------------------------------------------------
-- 考勤审计列
-- ---------------------------------------------------------------------------
ALTER TABLE public.attendances
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

CREATE OR REPLACE FUNCTION public.touch_attendance_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  -- service_role 下 auth.uid() 为空；管理员 RPC 会显式传 p_actor_id，coalesce 保留它
  NEW.updated_by := coalesce(auth.uid(), NEW.updated_by);
  RETURN NEW;
END
$function$;

CREATE TRIGGER attendances_audit
  BEFORE INSERT OR UPDATE ON public.attendances
  FOR EACH ROW EXECUTE FUNCTION public.touch_attendance_audit();

-- ---------------------------------------------------------------------------
-- P1：声部请假列表
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_section_leave_requests(
  p_rehearsal_id bigint DEFAULT NULL,
  p_include_canceled boolean DEFAULT false
)
RETURNS TABLE (
  request_id   uuid,
  user_id      uuid,
  rehearsal_id bigint,
  status       public."leaveStatus",
  created_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT lr.id, lr.user_id, lr.rehearsal_id, lr.status, lr.created_at
  FROM public.leave_requests lr
  WHERE (p_rehearsal_id IS NULL OR lr.rehearsal_id = p_rehearsal_id)
    AND public.can_view_member_attendance(lr.user_id)
    AND public.can_view_rehearsal_attendance(lr.rehearsal_id)
    AND (p_include_canceled OR lr.status NOT IN ('canceled','withdrawn'))
  ORDER BY lr.created_at DESC
$function$;

-- ---------------------------------------------------------------------------
-- 成员 RPC：提交 / 取消
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_attendance_change_request(
  p_rehearsal_id bigint,
  p_target_user_id uuid,
  p_to_status public."attendanceStatus",
  p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_from   public."attendanceStatus";
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND status = 'approved'::public."profileStatus"
      AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole"
  ) THEN
    RAISE EXCEPTION 'not_eligible' USING ERRCODE = '42501';
  END IF;

  IF p_to_status IS NULL THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;

  IF NOT public.can_manage_member_attendance(p_target_user_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_manage_rehearsal_attendance(p_rehearsal_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_from
  FROM public.attendances
  WHERE rehearsal_id = p_rehearsal_id AND user_id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance_missing' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.attendance_change_requests
    (rehearsal_id, target_user_id, requested_by, from_status, to_status, reason)
  VALUES
    (p_rehearsal_id, p_target_user_id, auth.uid(),
     coalesce(v_from, 'absent'::public."attendanceStatus"), p_to_status, v_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'pending_exists' USING ERRCODE = '23505';
END
$function$;

CREATE OR REPLACE FUNCTION public.cancel_attendance_change_request(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_requested_by uuid;
  v_status       public."attendanceChangeRequestStatus";
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT requested_by, status INTO v_requested_by, v_status
  FROM public.attendance_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_requested_by <> auth.uid() THEN
    RAISE EXCEPTION 'not_request_owner' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'pending'::public."attendanceChangeRequestStatus" THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = '22023';
  END IF;

  UPDATE public.attendance_change_requests
  SET status = 'canceled'::public."attendanceChangeRequestStatus"
  WHERE id = p_request_id;
END
$function$;

-- ---------------------------------------------------------------------------
-- 管理员审批（service_role）
-- ---------------------------------------------------------------------------
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
DECLARE
  v_req     public.attendance_change_requests%ROWTYPE;
  v_current public."attendanceStatus";
  v_reason  text := nullif(btrim(coalesce(p_reject_reason, '')), '');
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

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

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_class c ON c.oid = pr.prrelid
      WHERE pr.prpubid = (SELECT oid FROM pg_publication WHERE pubname = 'supabase_realtime')
        AND c.oid = 'public.attendance_change_requests'::regclass
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_change_requests';
    END IF;
  END IF;
END
$realtime$;

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.touch_attendance_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_attendance_audit() FROM anon;
GRANT EXECUTE ON FUNCTION public.touch_attendance_audit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_attendance_audit() TO service_role;

REVOKE ALL ON FUNCTION public.get_section_leave_requests(bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_section_leave_requests(bigint, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_attendance_change_request(bigint, uuid, public."attendanceStatus", text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_attendance_change_request(bigint, uuid, public."attendanceStatus", text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.cancel_attendance_change_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_attendance_change_request(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_decide_attendance_change_request(uuid, boolean, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decide_attendance_change_request(uuid, boolean, text, boolean, uuid) TO service_role;

COMMIT;

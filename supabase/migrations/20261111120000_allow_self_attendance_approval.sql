-- ============================================
-- 考勤修改申请：允许团长审批自己提出的申请
-- ============================================
--
-- 2026-11-11 用户确认：修改考勤申请不沿用「审批排除自己」的规则。
-- 只放开 attendance_approval；请假 / 入团审批仍排除自己的申请。
--
-- 同时把审批徽章的 attendance 计数改为包含自己提出的待处理申请，
-- 否则「自己的申请可审批」但徽章不计数，入口会看起来少一条。
--
-- 回滚：恢复 20261110190000 中 president_decide_attendance_change_request 的自审拦截，
-- 以及 president_pending_counts 的 requested_by <> auth.uid() 过滤。

BEGIN;

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
BEGIN
  PERFORM public.president_require_capability('attendance_approval');

  -- 不排除 requested_by = auth.uid()：团长可以审批自己提出的修改申请。
  RETURN public.decide_attendance_change_request_core(
    p_request_id, p_approve, p_reject_reason, p_force, auth.uid()
  );
END
$function$;

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
    ) ELSE 0 END;
END
$function$;

REVOKE ALL ON FUNCTION public.president_decide_attendance_change_request(uuid, boolean, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_decide_attendance_change_request(uuid, boolean, text, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.president_pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_pending_counts() TO authenticated, service_role;

COMMENT ON FUNCTION public.president_decide_attendance_change_request(uuid, boolean, text, boolean) IS
  '团长审批考勤修改申请（attendance_approval）；允许审批自己提出的申请。';
COMMENT ON FUNCTION public.president_pending_counts() IS
  '我的页审批徽章；请假/入团排除自己，考勤修改包含自己。';

COMMIT;

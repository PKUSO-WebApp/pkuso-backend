-- ============================================
-- 修改待审批的考勤申请（验收修复）
-- ============================================
--
-- 现有 RPC 只有 create / cancel。成员详情页需要「修改请求」：在 pending 期间
-- 改目标状态或理由。用 cancel + create 会有两步部分失败与唯一 pending 冲突的窗口，
-- 这里用一条原位 UPDATE 完成（不换行，唯一索引不受影响）。
--
-- 判据与 create 同口径：调用者必须是 approved member、是该申请的 requested_by、
-- 申请仍 pending，且仍拥有该成员/该排练的管理权（权限可能已被撤销）。
-- `from_status` **不更新**：它是审批时判 stale 的快照，修改请求不应重置它。
--
-- 回滚：
--   DROP FUNCTION IF EXISTS public.update_attendance_change_request(uuid, public."attendanceStatus", text);

BEGIN;

CREATE OR REPLACE FUNCTION public.update_attendance_change_request(
  p_request_id uuid,
  p_to_status public."attendanceStatus",
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_req    public.attendance_change_requests%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
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

  SELECT * INTO v_req
  FROM public.attendance_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_req.requested_by <> auth.uid() THEN
    RAISE EXCEPTION 'not_request_owner' USING ERRCODE = '42501';
  END IF;
  IF v_req.status <> 'pending'::public."attendanceChangeRequestStatus" THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = '22023';
  END IF;
  IF NOT public.can_manage_member_attendance(v_req.target_user_id)
     OR NOT public.can_manage_rehearsal_attendance(v_req.rehearsal_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  UPDATE public.attendance_change_requests
  SET to_status = p_to_status,
      reason = v_reason
  WHERE id = p_request_id;
END
$function$;

COMMENT ON FUNCTION public.update_attendance_change_request(uuid, public."attendanceStatus", text) IS
  '修改自己 pending 的考勤申请（to_status/reason）；from_status 作为审批 stale 快照不更新。';

REVOKE ALL ON FUNCTION public.update_attendance_change_request(uuid, public."attendanceStatus", text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_attendance_change_request(uuid, public."attendanceStatus", text)
  TO authenticated, service_role;

COMMIT;

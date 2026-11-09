-- ============================================
-- 0.6.2：生日字段 + 考勤修改申请拒绝 exempt
-- ============================================
--
-- 生日（2026-11-10 产品定）：
--   · `birthday date` 可空；`hide_birthday` 默认 false（未设置生日时不展示，设置后默认展示）；
--   · 与 email / college / phone 同一套隐私模式：**服务端在 `profiles_roster` 里掩码**，
--     本人/管理员/未隐藏时返回原值，否则 NULL；`hide_birthday` 一并返回给客户端。
--
-- exempt（2026-11-10 产品定）：
--   · 声部长/首席的「修改考勤」不再提供 exempt 选项；
--   · 服务端在两条申请 RPC 里拒绝 `to_status = 'exempt'`（老客户端也挡）。
--   · 现有 exempt 记录不受影响，仍可被改成 present/absent/excused。
--
-- 回滚：
--   CREATE OR REPLACE VIEW public.profiles_roster AS ...（去掉 birthday / hide_birthday）
--   CREATE OR REPLACE FUNCTION public.create_attendance_change_request(...)（去掉 guard）
--   CREATE OR REPLACE FUNCTION public.update_attendance_change_request(...)（去掉 guard）
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS hide_birthday;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS birthday;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 生日字段
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS birthday date,
  ADD COLUMN IF NOT EXISTS hide_birthday boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.birthday IS
  '生日（YYYY-MM-DD，可空）；展示受 hide_birthday 控制。';
COMMENT ON COLUMN public.profiles.hide_birthday IS
  '是否对非本人/非管理员隐藏生日；默认 false（设置后默认展示）。';

-- ---------------------------------------------------------------------------
-- 2. profiles_roster：末尾追加 birthday / hide_birthday
-- ---------------------------------------------------------------------------
-- 与 email / college / phone 同一条隐私口径：服务端掩码，客户端不需要（也不应该）
-- 拿到被隐藏的原值。列序只在末尾追加，避免影响 `select *` 的既有调用方。
CREATE OR REPLACE VIEW public.profiles_roster AS
SELECT
  id,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_email
      THEN email
    ELSE NULL::text
  END AS email,
  full_name,
  instrument,
  status,
  role,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_college
      THEN college
    ELSE NULL::text
  END AS college,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_phone
      THEN phone_number
    ELSE NULL::text
  END AS phone_number,
  join_date,
  created_at,
  is_section_leader,
  hide_email,
  hide_phone,
  hide_join_date,
  hide_college,
  is_in_orchestra,
  avatar_url,
  is_principal,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_birthday
      THEN birthday
    ELSE NULL::date
  END AS birthday,
  hide_birthday
FROM public.profiles
WHERE status = 'approved'::public."profileStatus"
   OR (SELECT auth.uid()) = id
   OR (SELECT public.is_admin());

GRANT SELECT ON public.profiles_roster TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. 考勤修改申请：拒绝 exempt
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

  -- 0.6.2：声部长/首席的修改申请不再允许设置 exempt（现有 exempt 记录仍可改成其他状态）
  IF p_to_status = 'exempt'::public."attendanceStatus" THEN
    RAISE EXCEPTION 'exempt_not_allowed' USING ERRCODE = '22023';
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

  -- 0.6.2：与 create 同一条 guard（修改 pending 请求也不允许改成 exempt）
  IF p_to_status = 'exempt'::public."attendanceStatus" THEN
    RAISE EXCEPTION 'exempt_not_allowed' USING ERRCODE = '22023';
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

COMMENT ON FUNCTION public.create_attendance_change_request(bigint, uuid, public."attendanceStatus", text) IS
  '提交考勤修改申请；0.6.2 起拒绝 to_status = exempt。';
COMMENT ON FUNCTION public.update_attendance_change_request(uuid, public."attendanceStatus", text) IS
  '修改自己 pending 的考勤申请；0.6.2 起拒绝 to_status = exempt。';

REVOKE ALL ON FUNCTION public.create_attendance_change_request(bigint, uuid, public."attendanceStatus", text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_attendance_change_request(bigint, uuid, public."attendanceStatus", text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_attendance_change_request(uuid, public."attendanceStatus", text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_attendance_change_request(uuid, public."attendanceStatus", text) TO authenticated, service_role;

COMMIT;

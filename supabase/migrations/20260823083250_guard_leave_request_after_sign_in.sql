CREATE OR REPLACE FUNCTION public.guard_leave_request_after_sign_in()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.attendances a
    WHERE a.rehearsal_id = NEW.rehearsal_id
      AND a.user_id = NEW.user_id
      AND a.status IN (
        'present'::public."attendanceStatus",
        'late'::public."attendanceStatus"
      )
  ) THEN
    RAISE EXCEPTION 'cannot request leave after signing in (present/late)'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_guard_leave_request_after_sign_in
  ON public.leave_requests;
CREATE TRIGGER trigger_guard_leave_request_after_sign_in
  BEFORE INSERT ON public.leave_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_leave_request_after_sign_in();

REVOKE ALL ON FUNCTION public.guard_leave_request_after_sign_in() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_leave_request_after_sign_in() FROM anon;
GRANT EXECUTE ON FUNCTION public.guard_leave_request_after_sign_in() TO authenticated;

COMMENT ON FUNCTION public.guard_leave_request_after_sign_in() IS
  'Rejects a new leave request when the member already has present/late attendance for that rehearsal; service_role admin workflow is preserved.';

CREATE OR REPLACE FUNCTION public.guard_member_leave_request_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.role() = 'service_role'
     OR current_setting('pkuso.internal_cancel_leave', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.user_id THEN
    RAISE EXCEPTION 'only the request owner may update this request'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status NOT IN (
       'pending'::public."leaveStatus",
       'rejected'::public."leaveStatus"
     )
     OR NEW.status NOT IN (
       'pending'::public."leaveStatus",
       'withdrawn'::public."leaveStatus",
       'canceled'::public."leaveStatus"
     ) THEN
    RAISE EXCEPTION 'invalid member leave request status transition'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.rehearsal_id IS DISTINCT FROM OLD.rehearsal_id
     OR NEW.target_status IS DISTINCT FROM OLD.target_status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.reject_reason IS NOT NULL THEN
    RAISE EXCEPTION 'member cannot modify protected leave request fields'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'pending'::public."leaveStatus"
     AND EXISTS (
       SELECT 1
       FROM public.attendances a
       WHERE a.rehearsal_id = NEW.rehearsal_id
         AND a.user_id = NEW.user_id
         AND a.status IN (
           'present'::public."attendanceStatus",
           'late'::public."attendanceStatus"
         )
     ) THEN
    RAISE EXCEPTION 'cannot request leave after signing in (present/late)'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_guard_member_leave_request_update
  ON public.leave_requests;
CREATE TRIGGER trigger_guard_member_leave_request_update
  BEFORE UPDATE ON public.leave_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_member_leave_request_update();

REVOKE ALL ON FUNCTION public.guard_member_leave_request_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_member_leave_request_update() FROM anon;

COMMENT ON FUNCTION public.guard_member_leave_request_update() IS
  'Rejects member edits to approved requests and protected leave_request columns; blocks re-applying leave after present/late sign-in; service_role admin workflow is preserved.';

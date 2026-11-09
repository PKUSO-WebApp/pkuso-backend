-- ============================================
-- 0.6.2：无需出勤（exempt）的排练不允许修改考勤
-- ============================================
--
-- 产品 2026-11-10 定：exempt 与「没有排练」同处理——日历上不给修改入口；
-- 老客户端/直接调用 RPC 也不能绕过，所以服务端再加一道：
--   · INSERT：from_status = exempt ⇒ 拒绝；
--   · UPDATE：只有当 to_status 或 reason 真的被改（即「修改申请」路径）时才拒绝；
--     审批 RPC 只改 status/decided_*，仍可处理存量 pending 请求。
--
-- 与 20261110120000 的 `exempt_not_allowed` 是两件事：
--   · 那条挡的是「把状态改成 exempt」；
--   · 这条挡的是「对 exempt 行发起/修改申请」。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS attendance_change_requests_reject_exempt ON public.attendance_change_requests;
--   DROP FUNCTION IF EXISTS public.reject_exempt_attendance_change();

BEGIN;

CREATE OR REPLACE FUNCTION public.reject_exempt_attendance_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.from_status = 'exempt'::public."attendanceStatus" THEN
      RAISE EXCEPTION 'exempt_not_editable' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE：只有「修改申请的内容」这一路径要挡；审批只动 status/decided_*，
  -- 必须放行（否则存量的 exempt 申请永远处理不掉）。
  IF NEW.to_status IS DISTINCT FROM OLD.to_status
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    IF NEW.from_status = 'exempt'::public."attendanceStatus" THEN
      RAISE EXCEPTION 'exempt_not_editable' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.reject_exempt_attendance_change() IS
  '0.6.2：禁止对 from_status=exempt 的考勤发起/修改修改申请；审批状态流转放行。';

CREATE TRIGGER attendance_change_requests_reject_exempt
  BEFORE INSERT OR UPDATE ON public.attendance_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.reject_exempt_attendance_change();

REVOKE EXECUTE ON FUNCTION public.reject_exempt_attendance_change() FROM PUBLIC, anon, authenticated;

COMMIT;

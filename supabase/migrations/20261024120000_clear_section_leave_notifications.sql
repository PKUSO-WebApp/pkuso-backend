-- ============================================
-- 取消请假时清掉对应的声部请假通知（验收修复）
-- ============================================
--
-- 背景：`20261023150100_section_leave_notifications.sql` 只在 INSERT 时产生通知。
-- 成员在 mp 里取消待审批请假后，声部长/首席的通知行仍在，未读徽章会继续亮 ——
-- 而这条申请已经不需要处理了，属于误导。
--
-- 处理：状态变成 canceled / withdrawn 时，删除 category=section_leave 且
-- meta.request_id = 本申请 id 的通知行（收件人就是当初通知到的人）。
-- 不改成「已读」是因为内容仍写着「提交了请假申请」，留着同样误导；
-- 申请本身在声部请假页里仍以状态行可见（include_canceled 开关）。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS clear_section_leave_notifications ON public.leave_requests;
--   DROP FUNCTION IF EXISTS public.clear_section_leave_notifications();

BEGIN;

CREATE OR REPLACE FUNCTION public.clear_section_leave_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status IN ('canceled', 'withdrawn')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM public.notifications
    WHERE category = 'section_leave'::public."notificationCategory"
      AND meta->>'request_id' = NEW.id::text;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER clear_section_leave_notifications
  AFTER UPDATE OF status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.clear_section_leave_notifications();

-- 与既有触发器函数同一条纪律：只由触发器调用，不给客户端角色 EXECUTE
REVOKE EXECUTE ON FUNCTION public.clear_section_leave_notifications() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clear_section_leave_notifications() FROM anon;
GRANT EXECUTE ON FUNCTION public.clear_section_leave_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_section_leave_notifications() TO service_role;

COMMIT;

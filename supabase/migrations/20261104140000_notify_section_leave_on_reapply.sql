-- ============================================
-- 请假驳回后重新提交（rejected → pending）通知声部长/首席
-- ============================================
--
-- 背景：`notify_section_leave_event` 只在 INSERT 时触发；mp 的「重新申请」是把同一条
-- `leave_requests` 从 rejected 改回 pending（UPDATE），不是新插入一行。于是声部长/
-- 首席收不到「他又提交了一次」的提醒（2026-10-24 已知盲区）。
--
-- 处理：补一个 `UPDATE OF status` 触发器，复用原通知函数（它读 NEW，与 UPDATE 兼容）。
-- - 只在「变回 pending」时触发；pending → pending 不重复通知；
-- - 取消/撤回仍由 `clear_section_leave_notifications` 清掉旧通知；
-- - 收件人、去重、分排目标过滤都在原函数里，不在这里复制。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS notify_section_leave_reapply ON public.leave_requests;

BEGIN;

CREATE TRIGGER notify_section_leave_reapply
  AFTER UPDATE OF status ON public.leave_requests
  FOR EACH ROW
  WHEN (
    NEW.status = 'pending'::public."leaveStatus"
    AND OLD.status IS DISTINCT FROM NEW.status
  )
  EXECUTE FUNCTION public.notify_section_leave_event();

COMMIT;

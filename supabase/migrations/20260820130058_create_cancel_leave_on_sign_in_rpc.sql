-- 签到后的请假配套撤销 RPC。
--
-- 真实 schema：leave_requests.rehearsal_id 为 bigint，user_id 为 uuid，
-- status 为 leaveStatus，attachment_url 为 text。Storage 文件不在数据库
-- 内删除；RPC 只返回实际更新行的附件路径，客户端再基于 Storage RLS
-- best-effort 删除本人目录下的文件。
--
-- 仅 approved/pending 且属于 auth.uid() 的申请会被更新为 canceled。
-- rejected、他人申请及其他状态不会命中，也不会返回。

BEGIN;

-- 返回 previous_status 需要在 UPDATE 前捕获；以显式 CTE 重建函数，
-- 避免依赖 UPDATE RETURNING 读取旧值。
CREATE OR REPLACE FUNCTION public.cancel_leave_on_sign_in(
  p_rehearsal_id bigint
)
RETURNS TABLE (
  request_id uuid,
  attachment_path text,
  previous_status public."leaveStatus",
  status public."leaveStatus"
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('pkuso.internal_cancel_leave', 'on', true);

  RETURN QUERY
  WITH eligible AS (
    SELECT lr.id, lr.attachment_url, lr.status AS old_status
    FROM public.leave_requests AS lr
    WHERE lr.rehearsal_id = p_rehearsal_id
      AND lr.user_id = v_uid
      AND lr.status IN (
        'approved'::public."leaveStatus",
        'pending'::public."leaveStatus"
      )
    FOR UPDATE
  ),
  changed AS (
    UPDATE public.leave_requests AS lr
       SET status = 'canceled'::public."leaveStatus",
           updated_at = now()
      FROM eligible AS e
     WHERE lr.id = e.id
    RETURNING lr.id
  )
  SELECT e.id,
         e.attachment_url,
         e.old_status,
         'canceled'::public."leaveStatus"
  FROM eligible AS e
  JOIN changed AS c ON c.id = e.id;
END;
$function$;

COMMENT ON FUNCTION public.cancel_leave_on_sign_in(bigint) IS
  'Authenticated owner-only cancellation of pending/approved leave requests for one rehearsal; returns updated rows and attachment paths for Storage-RLS-checked best-effort cleanup.';

REVOKE ALL ON FUNCTION public.cancel_leave_on_sign_in(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_leave_on_sign_in(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_leave_on_sign_in(bigint) TO authenticated;

COMMIT;

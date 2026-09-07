-- 请假申请 RLS 加固（Issue #142 对抗发现）：成员直连不能篡改审批状态
-- 成员端合法流转的 NEW.status 只有 pending（新申请/重新申请）与 withdrawn（撤回）
BEGIN;

DROP POLICY IF EXISTS "leave_requests: 用户可插入自己的申请" ON leave_requests;
CREATE POLICY "leave_requests: 用户可插入自己的申请" ON leave_requests
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND status = 'pending'::"leaveStatus");

DROP POLICY IF EXISTS "leave_requests: 用户可更新自己的申请" ON leave_requests;
CREATE POLICY "leave_requests: 用户可更新自己的申请" ON leave_requests
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND status IN ('pending'::"leaveStatus", 'withdrawn'::"leaveStatus"));

COMMIT;

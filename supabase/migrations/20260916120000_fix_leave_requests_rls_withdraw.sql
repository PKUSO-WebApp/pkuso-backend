-- Fix RLS policy to allow users to withdraw/cancel their own leave requests
-- The original WITH CHECK only allowed 'pending' status, but withdrawal changes status to 'withdrawn' or 'canceled'

DROP POLICY "leave_requests: 用户管理自己的申请" ON public.leave_requests;

CREATE POLICY "leave_requests: 用户管理自己的申请" ON public.leave_requests
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id 
  AND (
    status = 'pending'::leaveStatus
    OR status = 'withdrawn'::leaveStatus
    OR status = 'canceled'::leaveStatus
  )
);
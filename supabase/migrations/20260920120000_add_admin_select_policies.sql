-- Add admin SELECT policies for leave_requests and notifications
-- Allow admins to view all leave requests (for badge counts and approval list)
-- Allow admins to view all notifications (for future badge counts)

CREATE POLICY "leave_requests: 管理员可查看所有" ON public.leave_requests
  FOR SELECT TO authenticated
  USING (is_admin());

CREATE POLICY "notifications: 管理员可查看所有" ON public.notifications
  FOR SELECT TO authenticated
  USING (is_admin());
-- Enable Realtime for admin-relevant tables
-- Tables with user-related operations needing real-time updates in admin panel

ALTER PUBLICATION supabase_realtime ADD TABLE leave_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
-- 优化：为缺少覆盖索引的外键创建索引
--
-- 背景：Supabase database linter 检测到 13 个外键列缺少覆盖索引，
-- 可能导致 JOIN/DELETE 查询时全表扫描，影响性能。
-- 这些表是系统核心表（attendances / leave_requests / schedules / notifications 等），
-- 在排练签到、请假审批等高频场景中使用。
--
-- 本次迁移：为所有缺少索引的外键列创建 B-tree 索引。
-- 使用 CREATE INDEX IF NOT EXISTS 确保幂等性（可重复执行）。
--
-- 影响：
--   - 涉及表：attendances / invitation_codes / leave_requests / notifications /
--     posts / schedule_groups / schedules / system_notifications / verification_codes
--   - 涉及 RLS：无变更
--   - 涉及 Edge Functions：无变更
--   - 前端影响：无（纯性能优化）
--   - 写入影响：索引会略微增加 INSERT/UPDATE/DELETE 开销，但外键列写入频率远低于读取

BEGIN;

-- attendances.rehearsal_id → rehearsals.id
-- 查询场景：按排练查看出勤记录
CREATE INDEX IF NOT EXISTS idx_attendances_rehearsal_id
  ON public.attendances (rehearsal_id);

-- attendances.user_id → profiles.id
-- 查询场景：按用户查看出勤记录
CREATE INDEX IF NOT EXISTS idx_attendances_user_id
  ON public.attendances (user_id);

-- invitation_codes.created_by → auth.users
-- 查询场景：管理员查看自己创建的邀请码
CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by
  ON public.invitation_codes (created_by);

-- leave_requests.rehearsal_id → rehearsals.id
-- 查询场景：按排练查看请假申请
CREATE INDEX IF NOT EXISTS idx_leave_requests_rehearsal_id
  ON public.leave_requests (rehearsal_id);

-- leave_requests.user_id → profiles.id
-- 查询场景：按用户查看请假记录
CREATE INDEX IF NOT EXISTS idx_leave_requests_user_id
  ON public.leave_requests (user_id);

-- notifications.user_id → profiles.id
-- 查询场景：按用户查看通知（高频查询）
CREATE INDEX IF NOT EXISTS idx_notifications_user_id
  ON public.notifications (user_id);

-- posts.author_id → profiles.id
-- 查询场景：按作者查看帖子
CREATE INDEX IF NOT EXISTS idx_posts_author_id
  ON public.posts (author_id);

-- schedule_groups.author_id → profiles.id
-- 查询场景：按作者查看日程组
CREATE INDEX IF NOT EXISTS idx_schedule_groups_author_id
  ON public.schedule_groups (author_id);

-- schedules.author_id → profiles.id
-- 查询场景：按作者查看日程
CREATE INDEX IF NOT EXISTS idx_schedules_author_id
  ON public.schedules (author_id);

-- schedules.group_id → schedule_groups.id
-- 查询场景：按日程组查看日程
CREATE INDEX IF NOT EXISTS idx_schedules_group_id
  ON public.schedules (group_id);

-- schedules.rehearsal_id → rehearsals.id
-- 查询场景：按排练查看关联日程
CREATE INDEX IF NOT EXISTS idx_schedules_rehearsal_id
  ON public.schedules (rehearsal_id);

-- system_notifications.publisher_id → profiles.id
-- 查询场景：按发布者查看系统通知
CREATE INDEX IF NOT EXISTS idx_system_notifications_publisher_id
  ON public.system_notifications (publisher_id);

-- verification_codes.user_id → auth.users
-- 查询场景：按用户查看验证码
CREATE INDEX IF NOT EXISTS idx_verification_codes_user_id
  ON public.verification_codes (user_id);

COMMIT;

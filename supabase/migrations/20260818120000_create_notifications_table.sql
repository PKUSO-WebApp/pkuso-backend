-- 通知表（Issue #188）
-- 面向成员端信箱：考勤/活动/系统三类通知，管理员插入，成员读取与标记已读。
-- 枚举命名与既有惯例一致（attendanceStatus / leaveStatus / postType 均为 PascalCase）。
BEGIN;

-- ==================== 1. 通知分类枚举 ====================
CREATE TYPE "notificationCategory" AS ENUM ('attendance', 'activity', 'system');

-- ==================== 2. 通知表 ====================
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category "notificationCategory" NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

COMMENT ON TABLE notifications IS '通知（成员信箱）：考勤/活动/系统三类，管理员插入、成员读取并标记已读';
COMMENT ON COLUMN notifications.category IS '通知分类：attendance 考勤 / activity 活动 / system 系统';
COMMENT ON COLUMN notifications.read_at IS '已读时间，NULL 表示未读';

-- ==================== 3. RLS ====================
-- 成员仅能读取/更新自己的通知；管理员可插入任意用户的通知；delete 暂不开放。
-- 管理员判断沿用 is_admin()（SECURITY DEFINER，20260721200000 系列 migration 管理，
-- EXECUTE 已授予 authenticated，见 20260814155556 迁移说明）。
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications: 用户可读自己的通知" ON notifications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "notifications: 用户可更新自己的通知" ON notifications
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "notifications: 管理员可插入通知" ON notifications
  FOR INSERT TO authenticated WITH CHECK (is_admin());

-- ==================== 4. 索引 ====================
-- 信箱列表：按用户 + 创建时间倒序
CREATE INDEX notifications_user_id_created_at_idx ON notifications (user_id, created_at DESC);
-- 未读计数（read_at IS NULL）与分类筛选：user_id + category 前缀即可命中
CREATE INDEX notifications_user_id_category_read_at_idx ON notifications (user_id, category, read_at);

COMMIT;

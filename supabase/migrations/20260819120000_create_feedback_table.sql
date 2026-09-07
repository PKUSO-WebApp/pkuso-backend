-- 问题与反馈表（Issue #209）
-- 成员匿名提交反馈（不存 author_id，结构上保证管理员无法追溯提交人），管理员查看列表。
-- 风格与 notifications 表（20260818120000）一致：单事务、中文注释、is_admin() 判定管理员。
BEGIN;

-- ==================== 1. 反馈表 ====================
-- 匿名设计：无 author_id 列，管理员只能看到内容与提交时间，无法定位提交人。
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE feedback IS '问题与反馈：成员匿名提交（不存 author_id，管理员无法追溯提交人）、管理员查看列表';
COMMENT ON COLUMN feedback.content IS '反馈内容';

-- ==================== 2. RLS ====================
-- 成员可插入：匿名提交，WITH CHECK 无条件即可；
-- 管理员可查看列表：沿用 is_admin()（SECURITY DEFINER，20260721200000 系列 migration 管理，
-- EXECUTE 已授予 authenticated，见 20260814155556 迁移说明）；
-- 不开放 UPDATE/DELETE（暂不支持编辑/删除反馈）。
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feedback: 成员可提交反馈" ON feedback
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "feedback: 管理员可查看反馈" ON feedback
  FOR SELECT TO authenticated USING (is_admin());

-- ==================== 3. 索引 ====================
-- 管理端列表：按提交时间倒序
CREATE INDEX feedback_created_at_idx ON feedback (created_at DESC);

COMMIT;

-- 反馈可匿名功能：新增 created_by / is_anonymous 列
-- 背景：feedback 表原设计为结构性匿名（不存 author_id），现需支持可选匿名/实名提交。
-- 回滚：ALTER TABLE public.feedback DROP COLUMN created_by, DROP COLUMN is_anonymous;

BEGIN;

-- 1. 新增列
ALTER TABLE public.feedback
  ADD COLUMN created_by uuid REFERENCES public.profiles(id),
  ADD COLUMN is_anonymous boolean NOT NULL DEFAULT true;

-- 2. 更新 INSERT RLS 策略：匿名时 created_by 必须为 NULL，实名时必须为 auth.uid()
DROP POLICY "feedback: 成员可提交反馈" ON public.feedback;
CREATE POLICY "feedback: 成员可提交反馈" ON public.feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    (is_anonymous = true AND created_by IS NULL)
    OR
    (is_anonymous = false AND created_by = auth.uid())
  );

-- 3. 索引：加速按 created_by 查询（管理端可能按作者筛选）
CREATE INDEX feedback_created_by_idx ON public.feedback (created_by);

COMMIT;

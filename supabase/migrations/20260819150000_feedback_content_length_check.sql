-- Issue #210：反馈治理——content 长度约束
--
-- 背景：feedback 表 content 无长度约束，成员可提交数百 KB 巨文，admin 列表渲染卡顿。
-- 上限 2000 字符（与前端 textarea maxLength 一致），空串由前端校验拦截、
-- 此处下限 1 兜底（匿名插入无作者可溯源，防止空行垃圾）。
-- 回滚：ALTER TABLE public.feedback DROP CONSTRAINT feedback_content_length_check;

BEGIN;

ALTER TABLE public.feedback
  ADD CONSTRAINT feedback_content_length_check
  CHECK (char_length(content) BETWEEN 1 AND 2000);

COMMIT;

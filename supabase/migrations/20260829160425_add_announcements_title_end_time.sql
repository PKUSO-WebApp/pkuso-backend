-- 清空现有公告（结构即将变更，旧数据无 title/end_time 无法补全）
DELETE FROM public.announcements;

-- 新增 title 与 end_time 列（均非空）
ALTER TABLE public.announcements
  ADD COLUMN title text NOT NULL,
  ADD COLUMN end_time timestamptz NOT NULL;

-- ============================================
-- 共享谱列表视图（P5'）
-- ============================================
--
-- 每份分谱一行：文件信息 + 所属声部/曲目 + 非空共享批注页数 + 写入时的页数快照。
-- security_invoker = true：RLS 按调用者身份生效（底层表均为全团可读）。
--
-- 「普通成员只看 annotated_pages > 0；首席/声部长/团长看本作用域全部文件」
-- 是 **UI 侧过滤**，不在视图/RLS 里按声部限制——共享谱设计上全团可读。
--
-- 回滚：DROP VIEW IF EXISTS public.sheet_music_shared_score_files;

BEGIN;

CREATE OR REPLACE VIEW public.sheet_music_shared_score_files
WITH (security_invoker = true)
AS
SELECT
  f.id AS file_id,
  f.file_name,
  f.page_count,
  f.instrument AS file_instrument,
  f.sub_parts,
  p.section,
  sm.id AS score_id,
  sm.title,
  count(sa.page) FILTER (WHERE jsonb_array_length(sa.strokes) > 0) AS annotated_pages,
  max(sa.source_page_count) AS source_page_count,
  max(sa.updated_at) AS updated_at
FROM public.sheet_music_files AS f
JOIN public.sheet_music_parts AS p ON p.id = f.part_id
JOIN public.sheet_music AS sm ON sm.id = p.sheet_music_id
LEFT JOIN public.sheet_music_shared_annotations AS sa ON sa.file_id = f.id
GROUP BY
  f.id,
  f.file_name,
  f.page_count,
  f.instrument,
  f.sub_parts,
  p.section,
  sm.id,
  sm.title;

COMMENT ON VIEW public.sheet_music_shared_score_files IS
  'P5：共享谱列表（文件 + 声部 + 曲目 + 非空共享批注页数 + 页数快照）。';

REVOKE ALL ON public.sheet_music_shared_score_files FROM anon;
GRANT SELECT ON public.sheet_music_shared_score_files TO authenticated, service_role;

COMMIT;

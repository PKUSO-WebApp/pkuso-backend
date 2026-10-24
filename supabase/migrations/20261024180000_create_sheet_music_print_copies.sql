-- ============================================
-- 印制份数（P7b-1）：每份分谱的手动份数
-- ============================================
--
-- 谱务按文件调整「这份谱印几份」；没有行 = 用自动值（见下一迁移的
-- `get_score_print_plan`）。手动值可以填 0（表示这次不印），所以约束是 `>= 0`。
--
-- 总谱 / 打击乐也允许手改（用户 2026-10-24 定），自动默认值由读函数给 1。
--
-- 回滚：DROP TABLE IF EXISTS public.sheet_music_print_copies;

BEGIN;

CREATE TABLE public.sheet_music_print_copies (
  file_id    uuid PRIMARY KEY REFERENCES public.sheet_music_files(id) ON DELETE CASCADE,
  copies     integer NOT NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sheet_music_print_copies_copies_check CHECK (copies >= 0)
);

COMMENT ON TABLE public.sheet_music_print_copies IS
  '谱务印制份数的手动覆盖；无行 = 使用自动计算值。';
COMMENT ON COLUMN public.sheet_music_print_copies.copies IS
  '应印份数；0 = 这次不印（导出压缩包时跳过）。';

CREATE OR REPLACE FUNCTION public.touch_sheet_music_print_copies()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_print_copies_touch
  BEFORE UPDATE ON public.sheet_music_print_copies
  FOR EACH ROW EXECUTE FUNCTION public.touch_sheet_music_print_copies();

ALTER TABLE public.sheet_music_print_copies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sheet_music_print_copies FROM anon;
REVOKE ALL ON public.sheet_music_print_copies FROM authenticated;
GRANT SELECT ON public.sheet_music_print_copies TO authenticated;

REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_print_copies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_print_copies() FROM anon;
GRANT EXECUTE ON FUNCTION public.touch_sheet_music_print_copies() TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_sheet_music_print_copies() TO service_role;

COMMIT;

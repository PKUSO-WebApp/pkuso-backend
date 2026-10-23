-- ============================================
-- 共享谱批注：主表 + 历史表（P5'）
-- ============================================
--
-- 与个人批注（sheet_music_annotations）**是两张表**：
--   · 个人层：本人读写，RLS 只允许 auth.uid() = user_id；
--   · 共享层：全团可读，写入只能经 CAS RPC（本文件的表不给 authenticated 写权限）。
--
-- 设计依据：`声部长功能-数据模型与常量.md` §7 + §12.5（2026-10-23 最终版，A2 写权）。
--
-- 关键决定：
--   · version = md5(strokes::text) 生成列（与个人批注同算法），客户端只当不透明令牌；
--   · 空页（strokes=[]）保留不删；列表只统计非空页；
--   · source_page_count 记录写入时 sheet_music_files.page_count，用于「此谱已更新」提示；
--   · updated_by / replaced_by 由 RPC 写 auth.uid()；
--   · 历史每页保留最近 10 版；覆盖时由推送 RPC 归档**被覆盖**的那一份。
--
-- 回滚：
--   DROP VIEW IF EXISTS public.sheet_music_shared_score_files;
--   DROP TABLE IF EXISTS public.sheet_music_shared_annotation_history;
--   DROP TABLE IF EXISTS public.sheet_music_shared_annotations;
--   DROP FUNCTION IF EXISTS public.touch_sheet_music_shared_annotations();

BEGIN;

CREATE TABLE public.sheet_music_shared_annotations (
  file_id    uuid NOT NULL REFERENCES public.sheet_music_files(id) ON DELETE CASCADE,
  page       integer NOT NULL,
  strokes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_page_count integer,
  version    text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  PRIMARY KEY (file_id, page),
  CONSTRAINT sheet_music_shared_annotations_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_shared_annotations_strokes_type_check
    CHECK (jsonb_typeof(strokes) = 'array'),
  CONSTRAINT sheet_music_shared_annotations_strokes_size_check
    CHECK (pg_column_size(strokes) < 262144)
);

COMMENT ON TABLE public.sheet_music_shared_annotations IS
  '共享谱批注（按册+页一行，全团可读；写入只能经 push_shared_sheet_music_annotation）。';
COMMENT ON COLUMN public.sheet_music_shared_annotations.source_page_count IS
  '写入时 sheet_music_files.page_count 的快照；当前页数不同 ⇒ UI 提示「此谱已更新」。';
COMMENT ON COLUMN public.sheet_music_shared_annotations.version IS
  '内容版本号 = md5(strokes 的规范化文本)，服务端生成；客户端只作不透明令牌。';

CREATE TABLE public.sheet_music_shared_annotation_history (
  file_id     uuid NOT NULL REFERENCES public.sheet_music_files(id) ON DELETE CASCADE,
  page        integer NOT NULL,
  version     text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  strokes     jsonb NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  replaced_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (file_id, page, version),
  CONSTRAINT sheet_music_shared_annotation_history_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_shared_annotation_history_type_check
    CHECK (jsonb_typeof(strokes) = 'array'),
  CONSTRAINT sheet_music_shared_annotation_history_size_check
    CHECK (pg_column_size(strokes) < 262144)
);

COMMENT ON TABLE public.sheet_music_shared_annotation_history IS
  '共享谱批注历史（每页最近 10 版，覆盖时由推送 RPC 归档）。只读；写入只能经 RPC。';

CREATE INDEX sheet_music_shared_annotation_history_trim_idx
  ON public.sheet_music_shared_annotation_history (file_id, page, replaced_at DESC);

CREATE OR REPLACE FUNCTION public.touch_sheet_music_shared_annotations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_shared_annotations_touch
  BEFORE INSERT OR UPDATE ON public.sheet_music_shared_annotations
  FOR EACH ROW EXECUTE FUNCTION public.touch_sheet_music_shared_annotations();

ALTER TABLE public.sheet_music_shared_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_music_shared_annotation_history ENABLE ROW LEVEL SECURITY;

-- 共享内容全团可读（与谱务文件本身「所有人可读」同向）
CREATE POLICY sheet_music_shared_annotations_read ON public.sheet_music_shared_annotations
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY sheet_music_shared_annotation_history_read
  ON public.sheet_music_shared_annotation_history
  FOR SELECT TO authenticated
  USING (true);

-- 表上不给 authenticated 写权限：唯一写入口是 SECURITY DEFINER 的 CAS RPC。
REVOKE ALL ON public.sheet_music_shared_annotations FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_shared_annotations TO authenticated;
GRANT ALL ON public.sheet_music_shared_annotations TO service_role;

REVOKE ALL ON public.sheet_music_shared_annotation_history FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_shared_annotation_history TO authenticated;
GRANT ALL ON public.sheet_music_shared_annotation_history TO service_role;

REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_shared_annotations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_shared_annotations() FROM anon;
GRANT EXECUTE ON FUNCTION public.touch_sheet_music_shared_annotations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_sheet_music_shared_annotations() TO service_role;

COMMIT;

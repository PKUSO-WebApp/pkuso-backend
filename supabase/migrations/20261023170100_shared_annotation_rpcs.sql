-- ============================================
-- 共享谱批注：权限判据 + CAS 写入 + 历史归档（P5'）
-- ============================================
--
-- 写权 A2（§12.5）：首席（本乐器）+ 声部长（本作用域，组展开）+ 团长（shared_score 能力，含 admin）。
--
-- CAS 语义与个人批注（20261014150000）完全一致：
--   p_expected_version IS NULL → 无条件覆盖（老客户端）
--   p_expected_version = ''    → 期望「这一行不存在」
--   其他                       → 期望当前 version 恰好等于它
-- 冲突时不写任何行，返回远端当前 (version, strokes)。
--
-- 覆盖前先把**被覆盖的旧行**归档到 history，再 trim 到最近 10 版。
-- 表上没有 authenticated 写权限；本 RPC 是唯一写入口。
--
-- 回滚：
--   DROP FUNCTION IF EXISTS public.push_shared_sheet_music_annotation(uuid, integer, jsonb, text);
--   DROP FUNCTION IF EXISTS public.archive_shared_sheet_music_annotation(uuid, integer, jsonb);
--   DROP FUNCTION IF EXISTS public.trim_sheet_music_shared_annotation_history(uuid, integer, integer);
--   DROP FUNCTION IF EXISTS public.can_edit_shared_annotation(uuid);

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A2 权限判据
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_edit_shared_annotation(p_file_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.sheet_music_files AS f WHERE f.id = p_file_id
  ) AND (
    public.has_capability('shared_score')
    OR EXISTS (
      SELECT 1
      FROM public.sheet_music_files AS f
      JOIN public.sheet_music_parts AS p ON p.id = f.part_id
      WHERE f.id = p_file_id
        AND (
          p.section IN (SELECT * FROM public.principal_instruments(auth.uid()))
          OR p.section IN (SELECT * FROM public.led_sections(auth.uid()))
        )
    )
  );
$function$;

COMMENT ON FUNCTION public.can_edit_shared_annotation(uuid) IS
  'P5：A2 写权——首席本乐器 / 声部长本作用域（组展开）/ shared_score 能力（含 admin）。';

-- ---------------------------------------------------------------------------
-- 2. 历史裁剪（内部）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trim_sheet_music_shared_annotation_history(
  p_file_id uuid,
  p_page integer,
  p_keep integer DEFAULT 10
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH ranked AS (
    SELECT h.version,
           row_number() OVER (ORDER BY h.replaced_at DESC, h.version DESC) AS rn
    FROM public.sheet_music_shared_annotation_history AS h
    WHERE h.file_id = p_file_id AND h.page = p_page
  )
  DELETE FROM public.sheet_music_shared_annotation_history AS h
  USING ranked AS r
  WHERE h.file_id = p_file_id
    AND h.page = p_page
    AND h.version = r.version
    AND r.rn > greatest(p_keep, 1);
$function$;

-- ---------------------------------------------------------------------------
-- 3. 归档被覆盖的旧内容（内部）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_shared_sheet_music_annotation(
  p_file_id uuid,
  p_page integer,
  p_strokes jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.sheet_music_shared_annotation_history
    (file_id, page, strokes, replaced_by)
  VALUES
    (p_file_id, p_page, p_strokes, auth.uid())
  ON CONFLICT (file_id, page, version) DO NOTHING;

  PERFORM public.trim_sheet_music_shared_annotation_history(p_file_id, p_page, 10);
END
$function$;

-- ---------------------------------------------------------------------------
-- 4. CAS 写入（唯一写入口）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.push_shared_sheet_music_annotation(
  p_file_id uuid,
  p_page integer,
  p_strokes jsonb,
  p_expected_version text DEFAULT NULL
)
RETURNS TABLE (ok boolean, version text, strokes jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.sheet_music_shared_annotations;
  v_new text;
  v_page_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_file_id IS NULL OR p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'bad_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_strokes IS NULL OR jsonb_typeof(p_strokes) <> 'array' THEN
    RAISE EXCEPTION 'bad_strokes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.can_edit_shared_annotation(p_file_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT f.page_count INTO v_page_count
  FROM public.sheet_music_files AS f
  WHERE f.id = p_file_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file_not_found' USING ERRCODE = '22023';
  END IF;

  v_new := md5(p_strokes::text);

  -- 锁住这一行（不存在则锁不到，下面的唯一键冲突兜住并发插入）
  SELECT a.* INTO v_row
  FROM public.sheet_music_shared_annotations AS a
  WHERE a.file_id = p_file_id AND a.page = p_page
  FOR UPDATE;

  IF p_expected_version IS NOT NULL THEN
    IF v_row.file_id IS NULL THEN
      IF p_expected_version <> '' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::jsonb;
        RETURN;
      END IF;
    ELSIF v_row.version IS DISTINCT FROM p_expected_version THEN
      RETURN QUERY SELECT false, v_row.version, v_row.strokes;
      RETURN;
    END IF;
  END IF;

  IF v_row.file_id IS NULL THEN
    BEGIN
      INSERT INTO public.sheet_music_shared_annotations
        (file_id, page, strokes, updated_by, source_page_count)
      VALUES
        (p_file_id, p_page, p_strokes, v_uid, v_page_count)
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      SELECT a.* INTO v_row
      FROM public.sheet_music_shared_annotations AS a
      WHERE a.file_id = p_file_id AND a.page = p_page
      FOR UPDATE;
      IF p_expected_version IS NOT NULL THEN
        RETURN QUERY SELECT false, v_row.version, v_row.strokes;
        RETURN;
      END IF;
      PERFORM public.archive_shared_sheet_music_annotation(p_file_id, p_page, v_row.strokes);
      UPDATE public.sheet_music_shared_annotations AS a
      SET strokes = p_strokes,
          updated_by = v_uid,
          source_page_count = v_page_count
      WHERE a.file_id = p_file_id AND a.page = p_page
      RETURNING * INTO v_row;
    END;
  ELSIF v_row.version <> v_new THEN
    PERFORM public.archive_shared_sheet_music_annotation(p_file_id, p_page, v_row.strokes);
    UPDATE public.sheet_music_shared_annotations AS a
    SET strokes = p_strokes,
        updated_by = v_uid,
        source_page_count = v_page_count
    WHERE a.file_id = p_file_id AND a.page = p_page
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT true, v_row.version, NULL::jsonb;
END
$function$;

COMMENT ON FUNCTION public.push_shared_sheet_music_annotation(uuid, integer, jsonb, text) IS
  'P5：共享谱 CAS 写入（唯一写入口）；覆盖前归档旧版并保留最近 10 版。';

-- ---------------------------------------------------------------------------
-- 5. 授权
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.can_edit_shared_annotation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_edit_shared_annotation(uuid)
  TO authenticated, service_role;

-- 内部工具：只由 SECURITY DEFINER 的 push 调用，不给任何客户端角色
REVOKE ALL ON FUNCTION public.trim_sheet_music_shared_annotation_history(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_shared_sheet_music_annotation(uuid, integer, jsonb)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.push_shared_sheet_music_annotation(uuid, integer, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_shared_sheet_music_annotation(uuid, integer, jsonb, text)
  TO authenticated, service_role;

COMMIT;

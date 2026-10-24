-- ============================================
-- 印制份数（P7b-2）：清单读取 + 手动份数写入
-- ============================================
--
-- 自动份数规则（用户 2026-10-24 定）：
--   · 总谱：1 份；
--   · 打击乐：每个文件 1 份；
--   · 普通分谱：命中该文件分声部号的成员数；命中 0 人时按 1 份；
--     文件 `sub_parts` 为空时按「本声部全部成员数」算。
-- 总谱 / 打击乐也可以手动改（用户 2026-10-24 定），所以 `set_print_copies`
-- 不按 section 拒绝；读函数返回 `kind` 供 UI 显示默认规则。
--
-- 权限：admin 或 approved + role='score_manager'（web 谱务专职账号）。
-- 表上 authenticated 只有 SELECT；写入只经 `set_print_copies`。
--
-- 回滚：
--   DROP POLICY IF EXISTS "印制份数：谱务可读" ON public.sheet_music_print_copies;
--   DROP FUNCTION IF EXISTS public.set_print_copies(uuid, integer);
--   DROP FUNCTION IF EXISTS public.get_score_print_plan(uuid);
--   DROP FUNCTION IF EXISTS public.can_manage_sheet_music();

BEGIN;

CREATE OR REPLACE FUNCTION public.can_manage_sheet_music()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role = 'score_manager'::public."profileRole"
      AND p.status = 'approved'::public."profileStatus"
  );
$function$;

COMMENT ON FUNCTION public.can_manage_sheet_music() IS
  '当前调用者能否管理谱务（管理员或已批准的 score_manager）。';

CREATE OR REPLACE FUNCTION public.get_score_print_plan(p_score_id uuid)
RETURNS TABLE (
  file_id          uuid,
  part_id          uuid,
  section          text,
  file_name        text,
  storage_path     text,
  file_size        integer,
  sub_parts        integer[],
  section_members  integer,
  assigned_members integer,
  auto_copies      integer,
  manual_copies    integer,
  copies           integer,
  kind             text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.can_manage_sheet_music() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH files AS (
    SELECT
      f.id,
      f.part_id,
      btrim(p.section) AS section,
      f.file_name,
      f.storage_path,
      f.file_size,
      coalesce(f.sub_parts, '{}'::integer[]) AS sub_parts
    FROM public.sheet_music_files f
    JOIN public.sheet_music_parts p ON p.id = f.part_id
    WHERE p.sheet_music_id = p_score_id
      AND btrim(coalesce(p.section, '')) <> ''
  ),
  members AS (
    SELECT
      btrim(pr.instrument) AS instrument,
      smp.preferred_sub_part
    FROM public.profiles pr
    LEFT JOIN public.section_member_preferences smp ON smp.user_id = pr.id
    WHERE pr.status = 'approved'::public."profileStatus"
      AND pr.role = 'member'::public."profileRole"
      AND btrim(coalesce(pr.instrument, '')) <> ''
  ),
  counted AS (
    SELECT
      f.*,
      (SELECT count(*) FROM members m WHERE m.instrument = f.section)::integer AS section_members,
      CASE
        WHEN f.section IN ('总谱', '打击乐') THEN NULL
        WHEN cardinality(f.sub_parts) = 0 THEN
          (SELECT count(*) FROM members m WHERE m.instrument = f.section)::integer
        ELSE
          (SELECT count(*) FROM members m
           WHERE m.instrument = f.section
             AND m.preferred_sub_part = any(f.sub_parts))::integer
      END AS assigned_members
    FROM files f
  )
  SELECT
    c.id,
    c.part_id,
    c.section,
    c.file_name,
    c.storage_path,
    c.file_size,
    c.sub_parts,
    c.section_members,
    c.assigned_members,
    CASE
      WHEN c.section IN ('总谱', '打击乐') THEN 1
      ELSE greatest(coalesce(c.assigned_members, 0), 1)
    END AS auto_copies,
    pc.copies AS manual_copies,
    coalesce(
      pc.copies,
      CASE
        WHEN c.section IN ('总谱', '打击乐') THEN 1
        ELSE greatest(coalesce(c.assigned_members, 0), 1)
      END
    ) AS copies,
    CASE
      WHEN c.section = '总谱' THEN 'score'
      WHEN c.section = '打击乐' THEN 'percussion'
      ELSE 'part'
    END AS kind
  FROM counted c
  LEFT JOIN public.sheet_music_print_copies pc ON pc.file_id = c.id
  ORDER BY c.section, c.sub_parts, c.file_name;
END
$function$;

COMMENT ON FUNCTION public.get_score_print_plan(uuid) IS
  '一首曲子的印制清单：每文件的本声部人数、已分配人数、自动/手动/最终份数。';

CREATE OR REPLACE FUNCTION public.set_print_copies(p_file_id uuid, p_copies integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.can_manage_sheet_music() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.sheet_music_files f WHERE f.id = p_file_id) THEN
    RAISE EXCEPTION 'file_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- null = 恢复自动（删掉手动覆盖）
  IF p_copies IS NULL THEN
    DELETE FROM public.sheet_music_print_copies WHERE file_id = p_file_id;
    RETURN;
  END IF;

  IF p_copies < 0 THEN
    RAISE EXCEPTION 'invalid_copies' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sheet_music_print_copies (file_id, copies, updated_by)
  VALUES (p_file_id, p_copies, (SELECT auth.uid()))
  ON CONFLICT (file_id) DO UPDATE
    SET copies = EXCLUDED.copies,
        updated_by = EXCLUDED.updated_by;
END
$function$;

COMMENT ON FUNCTION public.set_print_copies(uuid, integer) IS
  '设置/清除某文件的应印份数；p_copies 为 null 时恢复自动值。';

CREATE POLICY "印制份数：谱务可读" ON public.sheet_music_print_copies
  FOR SELECT TO authenticated
  USING (public.can_manage_sheet_music());

REVOKE ALL ON FUNCTION public.can_manage_sheet_music() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_sheet_music() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_score_print_plan(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_score_print_plan(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_print_copies(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_print_copies(uuid, integer) TO authenticated, service_role;

COMMIT;

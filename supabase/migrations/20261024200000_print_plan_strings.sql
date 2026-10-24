-- ============================================
-- 印制份数（P7b-3）：弦乐五声部默认按在册人数
-- ============================================
--
-- 用户 2026-10-24 定：第一小提琴 / 第二小提琴 / 中提琴 / 大提琴 / 低音提琴
-- 这五个弦乐声部，默认**有多少人就印多少份**，不参与分声部号匹配。
--
-- 「五个」不在这里硬编码：`sections` 字典的 `弦乐` 组正好就是这五个乐器
-- （`section_group_members`），与 P7c 的弦乐策略共用同一份字典。
--
-- 只替换 `get_score_print_plan`；返回列与 `set_print_copies` 均不变，web 无需改动。
--
-- 回滚：重新执行 20261024180100_print_plan_rpcs.sql 的 get_score_print_plan 定义。

BEGIN;

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
      coalesce(f.sub_parts, '{}'::integer[]) AS sub_parts,
      -- 弦乐五声部：组字典里的「弦乐」成员；不在这里抄一份乐器清单
      EXISTS (
        SELECT 1
        FROM public.section_group_members g
        WHERE g.group_name = '弦乐'
          AND g.member_name = btrim(p.section)
      ) AS is_strings
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
        -- 弦乐：不看 sub_parts，整声部在册即「已分配」
        WHEN f.is_strings THEN
          (SELECT count(*) FROM members m WHERE m.instrument = f.section)::integer
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
  '一首曲子的印制清单：弦乐五声部按在册人数，其余按分声部号命中人数；总谱/打击乐固定 1。';

COMMIT;

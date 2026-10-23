-- ============================================
-- 考勤自动分配（P10'）：按曲目/分排写 absent / exempt
-- ============================================
--
-- 用户 2026-10-23 批准 A–F（B2：写权限仅 admin）。判据：
--   · 成员 approved + member；instrument 空/「其他」⇒ 永远 exempt
--   · 分排（type='section' 且 target_section 非空）：先按 target 收窄，非目标 ⇒ exempt
--   · 曲目（rehearsal_repertoire）：
--       - 没有任何曲目 ⇒ 全员 required
--       - 任一曲目无谱（sheet_music_id 为空）⇒ 全员 required
--       - 任一有谱曲目含「总谱」分谱 ⇒ 全员 required
--       - 任一有谱曲目没有任何分谱行（元数据缺失）⇒ 全员 required
--       - required = 选中曲目的乐器分谱并集（sections.kind='instrument'）
--       - 分排时取 required 与 target 的交集；交集为空 ⇒ 该场目标声部全员 required
--         （保守兜底：宁可多要求，不因选错曲目/缺元数据把人静默 exempt）
--   · 只插入不存在的 (rehearsal_id, user_id)；已有考勤行一行不改
--   · 只处理尚未结束的排练；p_rehearsal_ids='{}' 仍然 no-op
--
-- 行为变更只影响**新插入**的行：已有行的 status 不动。
--
-- 回滚：
--   恢复 20260930151500 里的 fill_attendance_roster 定义；
--   DROP FUNCTION IF EXISTS public.compute_rehearsal_attendance(bigint);

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 内部：算一场排练的 (成员, absent/exempt)
-- ---------------------------------------------------------------------------
-- 只给 service_role；fill_attendance_roster 以 owner 身份调用。
-- 分成独立函数是为了让「required/exempt 矩阵」可以单独断言（见 PR 验证）。
CREATE OR REPLACE FUNCTION public.compute_rehearsal_attendance(p_rehearsal_id bigint)
RETURNS TABLE (user_id uuid, status public."attendanceStatus")
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH r AS (
    SELECT
      id,
      type,
      coalesce(target_section, '{}'::text[]) AS target_section
    FROM public.rehearsals
    WHERE id = p_rehearsal_id
  ),
  reps AS (
    SELECT rr.sheet_music_id
    FROM public.rehearsal_repertoire AS rr
    WHERE rr.rehearsal_id = p_rehearsal_id
  ),
  parts AS (
    SELECT p.section
    FROM reps
    JOIN public.sheet_music_parts AS p ON p.sheet_music_id = reps.sheet_music_id
  ),
  flags AS (
    SELECT
      NOT EXISTS (SELECT 1 FROM reps) AS no_reps,
      EXISTS (SELECT 1 FROM reps WHERE sheet_music_id IS NULL) AS has_unscored,
      EXISTS (SELECT 1 FROM parts WHERE section = '总谱') AS has_full_score,
      EXISTS (
        SELECT 1
        FROM reps
        WHERE sheet_music_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.sheet_music_parts AS p
            WHERE p.sheet_music_id = reps.sheet_music_id
          )
      ) AS has_unknown_parts
  ),
  required AS (
    SELECT DISTINCT p.section
    FROM parts AS p
    JOIN public.sections AS s
      ON s.name = p.section AND s.kind = 'instrument'
  ),
  -- 分排只关心 target 内的 required；交集为空时走保守兜底
  required_in_scope AS (
    SELECT p.section
    FROM required AS p
    CROSS JOIN r
    WHERE cardinality(r.target_section) = 0
       OR p.section = ANY (r.target_section)
  ),
  all_required AS (
    SELECT (
      no_reps
      OR has_unscored
      OR has_full_score
      OR has_unknown_parts
      OR NOT EXISTS (SELECT 1 FROM required_in_scope)
    ) AS flag
    FROM flags
  )
  SELECT
    m.id,
    CASE
      -- 空/「其他」声部永远无需出勤
      WHEN btrim(coalesce(m.instrument, '')) IN ('', '其他') THEN
        'exempt'::public."attendanceStatus"
      -- 分排：非目标声部无需出勤
      WHEN r.type = 'section'
           AND cardinality(r.target_section) > 0
           AND NOT (btrim(m.instrument) = ANY (r.target_section)) THEN
        'exempt'::public."attendanceStatus"
      -- 全员 required（无曲目/无谱/总谱/缺元数据/交集为空），或该成员在 required 内
      WHEN (SELECT flag FROM all_required)
           OR btrim(m.instrument) IN (SELECT section FROM required_in_scope) THEN
        'absent'::public."attendanceStatus"
      ELSE
        'exempt'::public."attendanceStatus"
    END
  FROM public.profiles AS m
  CROSS JOIN r
  WHERE m.status = 'approved'::public."profileStatus"
    AND coalesce(m.role, 'member'::public."profileRole") = 'member'::public."profileRole";
$function$;

COMMENT ON FUNCTION public.compute_rehearsal_attendance(bigint) IS
  'P10：按排练曲目/分排计算每个 approved member 的考勤占位状态（absent/exempt）。';

-- ---------------------------------------------------------------------------
-- 2. 补齐名单：只插不存在的行
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fill_attendance_roster(p_rehearsal_ids bigint[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_rehearsal_id bigint;
  v_inserted integer := 0;
  v_rows integer;
BEGIN
  IF p_rehearsal_ids IS NOT NULL AND cardinality(p_rehearsal_ids) = 0 THEN
    RETURN 0;
  END IF;

  FOR v_rehearsal_id IN
    SELECT r.id
    FROM public.rehearsals AS r
    WHERE (p_rehearsal_ids IS NULL OR r.id = ANY (p_rehearsal_ids))
      AND public.rehearsal_is_upcoming(r.start_time, r.end_time)
  LOOP
    INSERT INTO public.attendances (rehearsal_id, user_id, status)
    SELECT v_rehearsal_id, plan.user_id, plan.status
    FROM public.compute_rehearsal_attendance(v_rehearsal_id) AS plan
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.attendances AS a
      WHERE a.rehearsal_id = v_rehearsal_id
        AND a.user_id = plan.user_id
    );

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_inserted := v_inserted + v_rows;
  END LOOP;

  RETURN v_inserted;
END
$function$;

-- ---------------------------------------------------------------------------
-- 3. 权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.compute_rehearsal_attendance(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_rehearsal_attendance(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.compute_rehearsal_attendance(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.compute_rehearsal_attendance(bigint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) TO service_role;

COMMIT;

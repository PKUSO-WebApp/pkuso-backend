-- ============================================
-- 团长考勤导出：尊重 profiles.hide_email
-- ============================================
--
-- 考勤导出的字段与 web 管理端导出一致，但团长不是 admin：`profiles_roster`
-- 对非本人 / 非管理员会掩码 email，导出也不应该把成员明确隐藏的邮箱交出去。
--
-- 判据与 profiles_roster 相同：本人 / 管理员 / 未隐藏 才返回 email。
--
-- 回滚：恢复 20261110160000 中 president_attendance_export 的 email 为 p.email。

BEGIN;

CREATE OR REPLACE FUNCTION public.president_attendance_export(
  p_rehearsal_id bigint DEFAULT NULL,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL
)
RETURNS TABLE (
  rehearsal_id          bigint,
  rehearsal_start       text,
  rehearsal_end         text,
  rehearsal_type        text,
  rehearsal_title       text,
  rehearsal_repertoire  text,
  rehearsal_location    text,
  user_id               uuid,
  full_name             text,
  email                 text,
  instrument            text,
  is_in_orchestra       boolean,
  status                public."attendanceStatus",
  sign_in_time          timestamp,
  updated_at            timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.president_require_capability('attendance_export');

  RETURN QUERY
  SELECT
    a.rehearsal_id,
    r.start_time,
    r.end_time,
    r.type,
    r.title,
    r.repertoire,
    r.location,
    a.user_id,
    p.full_name,
    CASE
      WHEN p.id = auth.uid()
        OR public.is_admin()
        OR NOT p.hide_email
      THEN p.email
      ELSE NULL
    END AS email,
    p.instrument,
    p.is_in_orchestra,
    a.status,
    a.sign_in_time,
    a.updated_at
  FROM public.attendances a
  JOIN public.rehearsals r ON r.id = a.rehearsal_id
  LEFT JOIN public.profiles p ON p.id = a.user_id
  WHERE (p_rehearsal_id IS NULL OR a.rehearsal_id = p_rehearsal_id)
    AND (
      p_start_date IS NULL
      OR (
        CASE
          WHEN left(r.start_time, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN left(r.start_time, 10)::date
        END
      ) >= p_start_date
    )
    AND (
      p_end_date IS NULL
      OR (
        CASE
          WHEN left(r.start_time, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN left(r.start_time, 10)::date
        END
      ) <= p_end_date
    )
  ORDER BY r.start_time DESC NULLS LAST, p.full_name NULLS LAST;
END
$function$;

REVOKE ALL ON FUNCTION public.president_attendance_export(bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_attendance_export(bigint, date, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.president_attendance_export(bigint, date, date) IS
  '团长考勤导出数据（attendance_export）；CSV 由客户端生成；email 按 hide_email 掩码。';

COMMIT;

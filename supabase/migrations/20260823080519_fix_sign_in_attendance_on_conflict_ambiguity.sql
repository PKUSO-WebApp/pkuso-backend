CREATE OR REPLACE FUNCTION public.sign_in_attendance(
  p_rehearsal_id bigint,
  p_code text
)
RETURNS TABLE (
  id bigint,
  rehearsal_id bigint,
  user_id uuid,
  status public."attendanceStatus",
  sign_in_time timestamp
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rehearsal public.rehearsals%ROWTYPE;
  v_start timestamp;
  v_end timestamp;
  v_now timestamp := (now() AT TIME ZONE 'Asia/Shanghai')::timestamp;
  v_status public."attendanceStatus";
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = v_uid
      AND p.status = 'approved'::public."profileStatus"
  ) THEN
    RAISE EXCEPTION 'profile is not approved'
      USING ERRCODE = '42501';
  END IF;

  SELECT r.*
    INTO STRICT v_rehearsal
  FROM public.rehearsals AS r
  WHERE r.id = p_rehearsal_id;

  IF v_rehearsal.type = 'full'
     AND (v_rehearsal.sign_in_code IS NULL
          OR COALESCE(p_code, '') <> v_rehearsal.sign_in_code) THEN
    RAISE EXCEPTION 'invalid sign-in code'
      USING ERRCODE = '22023';
  END IF;

  IF v_rehearsal.start_time IS NULL THEN
    RAISE EXCEPTION 'rehearsal start time is required'
      USING ERRCODE = '22023';
  END IF;

  v_start := v_rehearsal.start_time::timestamp;
  IF v_rehearsal.end_time IS NOT NULL
     AND v_rehearsal.end_time::timestamp < v_start THEN
    RAISE EXCEPTION 'rehearsal end time must not precede start time'
      USING ERRCODE = '22023';
  END IF;
  v_end := COALESCE(v_rehearsal.end_time::timestamp, v_start + INTERVAL '3 hours');

  IF v_now < v_start - INTERVAL '30 minutes'
     OR v_now > v_end THEN
    RAISE EXCEPTION 'sign-in is outside the allowed window'
      USING ERRCODE = '22023';
  END IF;

  IF v_now <= v_start + INTERVAL '15 minutes' THEN
    v_status := 'present'::public."attendanceStatus";
  ELSE
    v_status := 'late'::public."attendanceStatus";
  END IF;

  RETURN QUERY
  INSERT INTO public.attendances AS a (
    rehearsal_id,
    user_id,
    status,
    sign_in_time
  )
  VALUES (
    p_rehearsal_id,
    v_uid,
    v_status,
    v_now
  )
  ON CONFLICT ON CONSTRAINT attendances_rehearsal_id_user_id_key
  DO UPDATE
    SET status = EXCLUDED.status,
        sign_in_time = EXCLUDED.sign_in_time
  WHERE a.sign_in_time IS NULL
  RETURNING a.id, a.rehearsal_id, a.user_id, a.status, a.sign_in_time;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance has already been signed in'
      USING ERRCODE = '23505';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.sign_in_attendance(bigint, text) IS
  'Authenticated member sign-in: validates approved profile, full-rehearsal sign-in code (section rehearsals sign in directly without code) and the 30-minute-before/end window; server assigns status and sign_in_time. ON CONFLICT references the unique constraint by name to avoid PL/pgSQL variable/column ambiguity with RETURNS TABLE out params.';

REVOKE ALL ON FUNCTION public.sign_in_attendance(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sign_in_attendance(bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sign_in_attendance(bigint, text) TO authenticated;

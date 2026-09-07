-- 地理签到加固：封死旁路（回收成员直写 attendances、下线旧签到码 RPC）、
-- 定位签到函数安全加固（accuracy 钳制/坐标范围校验/pg_temp）、列级 CHECK 兜底

-- 1) 成员不再能直写考勤：仅保留管理员 ALL 策略与成员 SELECT
DROP POLICY IF EXISTS "attendances: 所有人可插入自己的记录" ON public.attendances;
DROP POLICY IF EXISTS "attendances: 可更新自己的记录" ON public.attendances;

-- 2) 下线旧签到码 RPC（分声部排练经它可无任何校验异地签）
REVOKE ALL ON FUNCTION public.sign_in_attendance(bigint, text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.sign_in_attendance(bigint, text);

-- 3) 列级 CHECK：坐标范围合法且排除 NaN（自比较），半径 1~地球半径
ALTER TABLE public.rehearsals
  DROP CONSTRAINT IF EXISTS rehearsals_checkin_lat_ck,
  ADD CONSTRAINT rehearsals_checkin_lat_ck
    CHECK (checkin_lat IS NULL OR (checkin_lat = checkin_lat AND checkin_lat BETWEEN -90 AND 90)),
  DROP CONSTRAINT IF EXISTS rehearsals_checkin_lng_ck,
  ADD CONSTRAINT rehearsals_checkin_lng_ck
    CHECK (checkin_lng IS NULL OR (checkin_lng = checkin_lng AND checkin_lng BETWEEN -180 AND 180)),
  DROP CONSTRAINT IF EXISTS rehearsals_checkin_radius_m_ck,
  ADD CONSTRAINT rehearsals_checkin_radius_m_ck
    CHECK (checkin_radius_m IS NULL OR (checkin_radius_m = checkin_radius_m AND checkin_radius_m BETWEEN 1 AND 6371000));

-- 4) 重建定位签到函数（加固版）
CREATE OR REPLACE FUNCTION public.sign_in_attendance_location(
  p_rehearsal_id bigint,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision DEFAULT NULL
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
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_rehearsal public.rehearsals%ROWTYPE;
  v_start timestamp;
  v_end timestamp;
  v_now timestamp := (now() AT TIME ZONE 'Asia/Shanghai')::timestamp;
  v_status public."attendanceStatus";
  v_dist_m double precision;
  v_radius_eff double precision;
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

  -- 地理围栏：仅当排练配置了完整坐标与半径时启用；任一为空则不限位置
  IF v_rehearsal.checkin_lat IS NOT NULL
     AND v_rehearsal.checkin_lng IS NOT NULL
     AND v_rehearsal.checkin_radius_m IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'check-in location is required'
        USING ERRCODE = '22023';
    END IF;

    -- 坐标必须有限且在有效范围（NaN 自比较排除；±Infinity 落在范围外）
    IF p_lat <> p_lat OR p_lng <> p_lng OR
       p_lat NOT BETWEEN -90 AND 90 OR
       p_lng NOT BETWEEN -180 AND 180 THEN
      RAISE EXCEPTION 'invalid check-in coordinates'
        USING ERRCODE = '22023';
    END IF;

    v_dist_m := 6371000 * 2 * asin(sqrt(
      power(sin(radians(v_rehearsal.checkin_lat - p_lat) / 2), 2)
      + cos(radians(v_rehearsal.checkin_lat)) * cos(radians(p_lat))
        * power(sin(radians(v_rehearsal.checkin_lng - p_lng) / 2), 2)
    ));
    -- accuracy 由服务端钳制到 [0,100] 米，客户端无法借它放大围栏
    v_radius_eff := v_rehearsal.checkin_radius_m
      + LEAST(GREATEST(COALESCE(p_accuracy, 0), 0), 100);

    IF NOT (v_dist_m <= v_radius_eff) THEN
      RAISE EXCEPTION 'outside check-in geofence'
        USING ERRCODE = '22023';
    END IF;
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
$fn$;

REVOKE ALL ON FUNCTION public.sign_in_attendance_location(bigint, double precision, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_in_attendance_location(bigint, double precision, double precision, double precision) TO authenticated;

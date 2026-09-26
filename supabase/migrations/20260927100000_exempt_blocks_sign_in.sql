-- 「无需出勤」（exempt）成员不可签到（pkuso-backend#47 的签到侧）
--
-- 背景：attendanceStatus 新增 exempt 后，管理员设了「无需出勤」的成员仍能签到——
-- 签到 RPC 的冲突分支只守 sign_in_time IS NULL，会把 exempt 覆盖成 present。
-- 这与既有 excused/absent 的规则一致（签到优先，Issue #141），但 exempt 是长期免出勤
-- 标记，被一次签到抹掉与管理员意图不符，故为其单列一条守卫。
--
-- ⚠️ 本文件完整重写了函数体：`sign_in_attendance_location` 的函数体**不在本仓库的迁移历史里**
-- （既有迁移只有 REVOKE/GRANT），故以**线上 `pg_get_functiondef` 的实际定义**为准抄录后加守卫。
-- 注意 pkuso-web/supabase/migrations 里那份 20260826 的历史归档**已经漂移**（仍写着按 15 分钟
-- 宽限区分 present/late），不可作为来源。今后该函数若再改，同样要以线上定义为基础。
--
-- 契约：attendance 行为 exempt 时，签到一律以 `attendance status is exempt` 拒绝（ERRCODE 22023）。
-- 客户端据该文案给出「无需出勤」提示；pkuso-mp 的签到按钮在状态机层面已对该状态禁用，
-- 本守卫是服务端兜底（陈旧客户端 / 页面打开期间被改为 exempt）。

CREATE OR REPLACE FUNCTION public.sign_in_attendance_location(p_rehearsal_id bigint, p_lat double precision, p_lng double precision, p_accuracy double precision DEFAULT NULL::double precision)
 RETURNS TABLE(id bigint, rehearsal_id bigint, user_id uuid, status "attendanceStatus", sign_in_time timestamp without time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- 无需出勤：不参与签到。放在地理围栏与时间窗之前，使该成员无论何时何地
  -- 都拿到这条明确原因，而不是「围栏外 / 不在签到时段」这类会误导的报错。
  IF EXISTS (
    SELECT 1
    FROM public.attendances AS a
    WHERE a.rehearsal_id = p_rehearsal_id
      AND a.user_id = v_uid
      AND a.status = 'exempt'::public."attendanceStatus"
  ) THEN
    RAISE EXCEPTION 'attendance status is exempt'
      USING ERRCODE = '22023';
  END IF;

  -- 地理围栏：仅当排练配置了完整坐标与半径时启用；任一为空则不限位置
  IF v_rehearsal.checkin_lat IS NOT NULL
     AND v_rehearsal.checkin_lng IS NOT NULL
     AND v_rehearsal.checkin_radius_m IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'check-in location is required'
        USING ERRCODE = '22023';
    END IF;

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

  -- 窗口内签到一律记为出席（不再区分迟到）
  v_status := 'present'::public."attendanceStatus";

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
  -- 第二道守卫：关闭「前置检查 → 本条写入」间隙内被改为 exempt 的竞态窗口
  WHERE a.sign_in_time IS NULL
    AND a.status <> 'exempt'::public."attendanceStatus"
  RETURNING a.id, a.rehearsal_id, a.user_id, a.status, a.sign_in_time;

  IF NOT FOUND THEN
    -- 上面的 WHERE 未命中：若原因是间隙内被设为无需出勤，给出与前置检查一致的原因，
    -- 否则仍是既有的「已签到」语义
    IF EXISTS (
      SELECT 1
      FROM public.attendances AS a
      WHERE a.rehearsal_id = p_rehearsal_id
        AND a.user_id = v_uid
        AND a.status = 'exempt'::public."attendanceStatus"
    ) THEN
      RAISE EXCEPTION 'attendance status is exempt'
        USING ERRCODE = '22023';
    END IF;

    RAISE EXCEPTION 'attendance has already been signed in'
      USING ERRCODE = '23505';
  END IF;
END;
$function$;

-- 回滚：重跑本文件并把两处 `attendance status is exempt` 守卫与 `AND a.status <> 'exempt'`
-- 一并去掉即可（即恢复为线上 20260927 之前的定义）。

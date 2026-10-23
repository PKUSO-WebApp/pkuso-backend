-- ============================================
-- 排练曲目写入 RPC（P10' web 表单）
-- ============================================
--
-- 为什么需要 create RPC：
--   补名单触发器挂在 rehearsals 的 INSERT/UPDATE OF start_time 上。web 若先
--   INSERT 排练、再 INSERT 曲目，触发器在第一步就会按「没有曲目」算出全员 required，
--   等曲目写进来时考勤行已经存在（只插不改）⇒ P10 的 exempt 永远不会生效。
--
--   本 RPC 在一个事务里：
--     1) 先 INSERT 排练，start_time/end_time 置 NULL（触发器不补名单）；
--     2) 写 rehearsal_repertoire；
--     3) 再 UPDATE start_time/end_time —— 这一步的触发器才按曲目补名单。
--   中间态对其它会话不可见。
--
-- 编辑时用 save_rehearsal_repertoire：只替换曲目行，不重算已有考勤
--（用户批准的「只影响新行」；已有考勤是人的决定，不因曲目编辑被覆盖）。
--
-- 写权限：B2 = 仅 admin（函数内 is_admin() 显式检查；表本身 RLS 也是 admin-only）。

BEGIN;

CREATE OR REPLACE FUNCTION public.create_rehearsal_with_repertoire(
  p_rehearsal jsonb,
  p_pieces jsonb DEFAULT '[]'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_pieces) <> 'array' THEN
    RAISE EXCEPTION 'pieces_must_be_array' USING ERRCODE = '22023';
  END IF;

  -- 第 1 步：时间留空，避免触发器在曲目写入前补名单
  INSERT INTO public.rehearsals (
    type,
    target_section,
    start_time,
    end_time,
    location,
    repertoire,
    sign_in_code,
    checkin_lat,
    checkin_lng,
    checkin_radius_m
  )
  VALUES (
    coalesce(p_rehearsal->>'type', 'full'),
    coalesce(
      (
        SELECT array_agg(value)
        FROM jsonb_array_elements_text(p_rehearsal->'target_section') AS t(value)
      ),
      '{}'::text[]
    ),
    NULL,
    NULL,
    p_rehearsal->>'location',
    p_rehearsal->>'repertoire',
    NULLIF(p_rehearsal->>'sign_in_code', ''),
    (p_rehearsal->>'checkin_lat')::double precision,
    (p_rehearsal->>'checkin_lng')::double precision,
    (p_rehearsal->>'checkin_radius_m')::integer
  )
  RETURNING id INTO v_id;

  -- 第 2 步：写曲目
  INSERT INTO public.rehearsal_repertoire (rehearsal_id, sheet_music_id, title, sort_order)
  SELECT
    v_id,
    NULLIF(elem->>'sheet_music_id', '')::uuid,
    btrim(elem->>'title'),
    coalesce((elem->>'sort_order')::integer, (ord - 1)::integer)
  FROM jsonb_array_elements(p_pieces) WITH ORDINALITY AS t(elem, ord);

  -- 第 3 步：设置时间，这次触发器按曲目补名单
  UPDATE public.rehearsals
  SET start_time = p_rehearsal->>'start_time',
      end_time = p_rehearsal->>'end_time'
  WHERE id = v_id;

  RETURN v_id;
END
$function$;

COMMENT ON FUNCTION public.create_rehearsal_with_repertoire(jsonb, jsonb) IS
  'P10：创建排练 + 曲目，保证补名单发生在曲目写入之后（admin-only）。';

CREATE OR REPLACE FUNCTION public.save_rehearsal_repertoire(
  p_rehearsal_id bigint,
  p_pieces jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rehearsals WHERE id = p_rehearsal_id) THEN
    RAISE EXCEPTION 'rehearsal_missing' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_pieces) <> 'array' THEN
    RAISE EXCEPTION 'pieces_must_be_array' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.rehearsal_repertoire WHERE rehearsal_id = p_rehearsal_id;

  INSERT INTO public.rehearsal_repertoire (rehearsal_id, sheet_music_id, title, sort_order)
  SELECT
    p_rehearsal_id,
    NULLIF(elem->>'sheet_music_id', '')::uuid,
    btrim(elem->>'title'),
    coalesce((elem->>'sort_order')::integer, (ord - 1)::integer)
  FROM jsonb_array_elements(p_pieces) WITH ORDINALITY AS t(elem, ord);
END
$function$;

COMMENT ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb) IS
  'P10：替换一场排练的曲目（admin-only）；不重算已有考勤行。';

REVOKE ALL ON FUNCTION public.create_rehearsal_with_repertoire(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_rehearsal_with_repertoire(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_rehearsal_with_repertoire(jsonb, jsonb)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb)
  TO authenticated, service_role;

COMMIT;

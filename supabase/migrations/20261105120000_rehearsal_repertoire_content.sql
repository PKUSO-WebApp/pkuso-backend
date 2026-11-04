-- ============================================
-- 排练曲目：增加「本次排练内容」说明（可空）
-- ============================================
--
-- 一场排练里，同一首曲子可能只练某几个乐章/段落。原来的 rehearsal_repertoire
-- 只有 title（曲名快照），无法表达「肖斯塔科维奇第五交响曲：第一、第二乐章」。
--
-- 这里只加一个可空列，RPC 的**参数列表不变**：
--   create_rehearsal_with_repertoire(jsonb, jsonb) / save_rehearsal_repertoire(bigint, jsonb)
-- 仍然接收 p_pieces 数组，只是从每个元素多读一个 `content` 键。旧调用方不传
-- content 时写入 NULL，旧行为不变 ⇒ 非破坏性。
--
-- 回滚：ALTER TABLE public.rehearsal_repertoire DROP COLUMN IF EXISTS content;

BEGIN;

ALTER TABLE public.rehearsal_repertoire
  ADD COLUMN content text;

COMMENT ON COLUMN public.rehearsal_repertoire.content IS
  '本次排练的具体内容（如乐章/段落），可空；曲名仍存 title。';

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

  -- 第 2 步：写曲目（content 可空；旧调用方不传时为 NULL）
  INSERT INTO public.rehearsal_repertoire (rehearsal_id, sheet_music_id, title, content, sort_order)
  SELECT
    v_id,
    NULLIF(elem->>'sheet_music_id', '')::uuid,
    btrim(elem->>'title'),
    NULLIF(btrim(elem->>'content'), ''),
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

  INSERT INTO public.rehearsal_repertoire (rehearsal_id, sheet_music_id, title, content, sort_order)
  SELECT
    p_rehearsal_id,
    NULLIF(elem->>'sheet_music_id', '')::uuid,
    btrim(elem->>'title'),
    NULLIF(btrim(elem->>'content'), ''),
    coalesce((elem->>'sort_order')::integer, (ord - 1)::integer)
  FROM jsonb_array_elements(p_pieces) WITH ORDINALITY AS t(elem, ord);
END
$function$;

COMMENT ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb) IS
  'P10：替换一场排练的曲目（admin-only）；不重算已有考勤行。';

COMMIT;

-- ============================================
-- 团长排练地点（常用地点 + 地名→经纬度映射）
-- ============================================
--
-- 小程序里不做地图选点：团长创建排练时从**常用地点列表**里选，服务端把
-- `location` / `checkin_lat` / `checkin_lng` / `checkin_radius_m` 一次性写死到
-- rehearsals 行上。改地点表不会回改已经创建的排练（那是一场排练的历史快照）。
--
-- 数据来源（2026-11-10 用户给定 / 腾讯位置服务实测）：
--   · 排练厅（新太阳）39.988842, 116.311144
--   · 百年讲堂        39.989893, 116.310621（腾讯「北京大学百周年纪念讲堂」）
-- 坐标是 GCJ-02，与微信 wx.getLocation({ type:'gcj02' }) 同一坐标系。
--
-- 写权限：表只给 authenticated SELECT；新增/修改地点走 migration 或 service_role，
-- 不在 mp 里做地点管理。
--
-- 回滚：DROP FUNCTION list_rehearsal_locations；恢复 create_rehearsal_with_repertoire /
-- save_rehearsal_repertoire 的旧定义；DROP TABLE rehearsal_locations。

BEGIN;

CREATE TABLE public.rehearsal_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  address     text,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  radius_m    integer NOT NULL DEFAULT 200 CHECK (radius_m > 0),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rehearsal_locations IS
  '团长创建排练时的常用地点；地名→经纬度（GCJ-02）映射。';
COMMENT ON COLUMN public.rehearsal_locations.lat IS
  'GCJ-02 纬度，与微信 wx.getLocation({type:"gcj02"}) 一致。';

ALTER TABLE public.rehearsal_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "排练地点：已登录可读"
  ON public.rehearsal_locations
  FOR SELECT TO authenticated
  USING (true);

REVOKE ALL ON public.rehearsal_locations FROM anon;
GRANT SELECT ON public.rehearsal_locations TO authenticated;
GRANT ALL ON public.rehearsal_locations TO service_role;

INSERT INTO public.rehearsal_locations (name, lat, lng, radius_m, sort_order)
VALUES
  ('排练厅（新太阳）', 39.988842, 116.311144, 200, 0),
  ('百年讲堂', 39.989893, 116.310621, 200, 1)
ON CONFLICT (name) DO UPDATE
  SET lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      radius_m = EXCLUDED.radius_m,
      sort_order = EXCLUDED.sort_order,
      active = true,
      updated_at = now();

CREATE OR REPLACE FUNCTION public.list_rehearsal_locations()
RETURNS TABLE (
  id uuid,
  name text,
  address text,
  lat double precision,
  lng double precision,
  radius_m integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT l.id, l.name, l.address, l.lat, l.lng, l.radius_m
  FROM public.rehearsal_locations l
  WHERE l.active
  ORDER BY l.sort_order, l.name
$function$;

COMMENT ON FUNCTION public.list_rehearsal_locations() IS
  '团长创建排练时可选的地点（active，按 sort_order）。';

-- ---------------------------------------------------------------------------
-- 创建排练：团长（has_capability('rehearsal')）也可调用；支持 location_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_rehearsal_with_repertoire(
  p_rehearsal jsonb,
  p_pieces jsonb DEFAULT '[]'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id            bigint;
  v_location_id   uuid := NULLIF(p_rehearsal->>'location_id', '')::uuid;
  v_location_name text;
  v_lat           double precision;
  v_lng           double precision;
  v_radius_m      integer;
BEGIN
  IF NOT (public.is_admin() OR public.has_capability('rehearsal')) THEN
    RAISE EXCEPTION 'rehearsal_write_forbidden' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_pieces) <> 'array' THEN
    RAISE EXCEPTION 'pieces_must_be_array' USING ERRCODE = '22023';
  END IF;

  -- location_id 优先：地点名与坐标从常用地点表取，避免客户端伪造坐标
  IF v_location_id IS NOT NULL THEN
    SELECT l.name, l.lat, l.lng, l.radius_m
      INTO v_location_name, v_lat, v_lng, v_radius_m
    FROM public.rehearsal_locations l
    WHERE l.id = v_location_id AND l.active;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'location_not_found' USING ERRCODE = '22023';
    END IF;
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
    coalesce(v_location_name, p_rehearsal->>'location'),
    p_rehearsal->>'repertoire',
    NULLIF(p_rehearsal->>'sign_in_code', ''),
    coalesce(v_lat, (p_rehearsal->>'checkin_lat')::double precision),
    coalesce(v_lng, (p_rehearsal->>'checkin_lng')::double precision),
    coalesce(v_radius_m, (p_rehearsal->>'checkin_radius_m')::integer)
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
  'P10：创建排练 + 曲目；admin 或团长 rehearsal 能力；支持 location_id。';

-- 编辑曲目：与创建同一写权（admin 或团长 rehearsal）
CREATE OR REPLACE FUNCTION public.save_rehearsal_repertoire(
  p_rehearsal_id bigint,
  p_pieces jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.has_capability('rehearsal')) THEN
    RAISE EXCEPTION 'rehearsal_write_forbidden' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION public.list_rehearsal_locations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_rehearsal_locations() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_rehearsal_with_repertoire(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_rehearsal_with_repertoire(jsonb, jsonb)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_rehearsal_repertoire(bigint, jsonb)
  TO authenticated, service_role;

COMMIT;

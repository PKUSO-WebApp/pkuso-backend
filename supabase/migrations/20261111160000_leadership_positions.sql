-- ============================================
-- 团级职位：团长 / 副团长（各一名）
-- ============================================
--
-- 用户 2026-11-11 定：
--   · 新增副团长职位，功能与团长完全相同（七项能力）；
--   · 团长、副团长各一名；
--   · 副团长不能是声部长；副团长转团长先撤销再任命，不做特殊晋升逻辑。
--
-- 设计：
--   · 权限唯一来源仍是 president_capabilities（has_capability 不变）；
--   · leadership_positions 只负责「谁是什么职位」的标签与唯一性；
--   · 任命 = 写职位 + 授予全部七项能力；撤销 = 删职位 + 收回全部能力；
--   · 一人只能占一个职位（user_id 主键）；团长/副团长各最多一名（partial unique index）；
--   · 团长/副团长与声部长互斥（沿用现有 capability → section leader 的 guard）；
--   · 首席可共存（不动 instrument_principals）。
--
-- 回填：只把「七项能力齐全」的最早一名用户回填为团长；没有副团长回填。
--       其余历史能力持有者保持「有职位表之外的能力」的遗留状态，不自动造职位。
--
-- 回滚：DROP 函数；DROP TABLE leadership_positions；DROP TYPE leadershipPosition；
--       恢复 admin_set_president / admin_remove_president 的旧定义。

BEGIN;

CREATE TYPE public."leadershipPosition" AS ENUM ('president', 'vice_president');

CREATE TABLE public.leadership_positions (
  user_id      uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  position     public."leadershipPosition" NOT NULL,
  appointed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  appointed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX leadership_positions_one_president
  ON public.leadership_positions (position)
  WHERE position = 'president'::public."leadershipPosition";

CREATE UNIQUE INDEX leadership_positions_one_vice_president
  ON public.leadership_positions (position)
  WHERE position = 'vice_president'::public."leadershipPosition";

ALTER TABLE public.leadership_positions ENABLE ROW LEVEL SECURITY;

-- web 任命页用浏览器客户端读（admin-only）；写仍只走 service_role RPC
CREATE POLICY "leadership_positions: 管理员可读"
  ON public.leadership_positions
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- 写只给 service_role（web API）与 SECURITY DEFINER RPC；mp 走 my_leadership_position()
REVOKE ALL ON public.leadership_positions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.leadership_positions TO service_role;
GRANT SELECT ON public.leadership_positions TO authenticated;

COMMENT ON TABLE public.leadership_positions IS
  '团级职位（团长/副团长各一名）；权限仍由 president_capabilities 决定。';
COMMENT ON COLUMN public.leadership_positions.appointed_by IS
  '任命的 web 管理员；历史回填为 NULL。';

-- 回填：七项能力齐全的用户中，最早被任命的一位作为团长（prod 当前无数据）
INSERT INTO public.leadership_positions (user_id, position, appointed_at)
SELECT pc.user_id, 'president'::public."leadershipPosition", min(pc.granted_at)
FROM public.president_capabilities pc
GROUP BY pc.user_id
HAVING count(*) = cardinality(public.president_capability_keys())
ORDER BY min(pc.granted_at)
LIMIT 1;

-- ---------------------------------------------------------------------------
-- 内部核心：写职位 + 授予七项能力（admin-only，不直接给客户端）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_assign_leadership_position(
  p_user_id uuid,
  p_position public."leadershipPosition",
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing public."leadershipPosition";
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

  IF p_position IS NULL THEN
    RAISE EXCEPTION 'invalid_position' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id
      AND status = 'approved'::public."profileStatus"
      AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole"
  ) THEN
    RAISE EXCEPTION 'target_not_eligible' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.section_leaders WHERE leader_id = p_user_id) THEN
    RAISE EXCEPTION 'section_leader_cannot_be_leader' USING ERRCODE = '22023';
  END IF;

  SELECT position INTO v_existing
  FROM public.leadership_positions
  WHERE user_id = p_user_id;

  IF FOUND AND v_existing <> p_position THEN
    -- 一人一职位；转团长/转副团长都要先撤销
    RAISE EXCEPTION 'leadership_position_exists' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.leadership_positions
    WHERE position = p_position AND user_id <> p_user_id
  ) THEN
    IF p_position = 'president'::public."leadershipPosition" THEN
      RAISE EXCEPTION 'president_exists' USING ERRCODE = '22023';
    ELSE
      RAISE EXCEPTION 'vice_president_exists' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 同一职位重复任命是幂等的：清空再授予固定矩阵，避免历史残留
  DELETE FROM public.president_capabilities WHERE user_id = p_user_id;
  INSERT INTO public.president_capabilities (user_id, capability, granted_by, granted_at)
  SELECT p_user_id, t.capability, p_actor_id, now()
  FROM unnest(public.president_capability_keys()) AS t(capability);

  INSERT INTO public.leadership_positions (user_id, position, appointed_by, appointed_at)
  VALUES (p_user_id, p_position, p_actor_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET position = EXCLUDED.position,
        appointed_by = EXCLUDED.appointed_by,
        appointed_at = EXCLUDED.appointed_at;
END
$function$;

-- ---------------------------------------------------------------------------
-- 内部核心：撤销职位 + 收回能力
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_remove_leadership_position(
  p_user_id uuid,
  p_position public."leadershipPosition",
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing public."leadershipPosition";
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

  SELECT position INTO v_existing
  FROM public.leadership_positions
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    -- 兼容旧的「只授了部分能力」账号：团长撤销可以清能力；副团长撤销不碰
    IF p_position = 'president'::public."leadershipPosition" THEN
      DELETE FROM public.president_capabilities WHERE user_id = p_user_id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'not_vice_president' USING ERRCODE = '22023';
  END IF;

  IF v_existing <> p_position THEN
    RAISE EXCEPTION 'leadership_position_mismatch' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.leadership_positions WHERE user_id = p_user_id;
  DELETE FROM public.president_capabilities WHERE user_id = p_user_id;
END
$function$;

-- ---------------------------------------------------------------------------
-- 对外 RPC：保持旧函数签名，新增副团长
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_president(
  p_user_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.admin_assign_leadership_position(
    p_user_id,
    'president'::public."leadershipPosition",
    p_actor_id
  )
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_president(
  p_user_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.admin_remove_leadership_position(
    p_user_id,
    'president'::public."leadershipPosition",
    p_actor_id
  )
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_vice_president(
  p_user_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.admin_assign_leadership_position(
    p_user_id,
    'vice_president'::public."leadershipPosition",
    p_actor_id
  )
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_vice_president(
  p_user_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.admin_remove_leadership_position(
    p_user_id,
    'vice_president'::public."leadershipPosition",
    p_actor_id
  )
$function$;

-- ---------------------------------------------------------------------------
-- mp：当前用户的团级职位
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_leadership_position()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT lp.position::text
  FROM public.leadership_positions lp
  WHERE lp.user_id = auth.uid()
$function$;

COMMENT ON FUNCTION public.my_leadership_position() IS
  'mp「我的」页团级工作台标题：president / vice_president / NULL。';

-- ---------------------------------------------------------------------------
-- 权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_assign_leadership_position(
  uuid, public."leadershipPosition", uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_leadership_position(
  uuid, public."leadershipPosition", uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_leadership_position(
  uuid, public."leadershipPosition", uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_leadership_position(
  uuid, public."leadershipPosition", uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_president(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_president(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_president(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_president(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_vice_president(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_vice_president(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_vice_president(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_vice_president(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.my_leadership_position() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_leadership_position() TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_set_president(uuid, uuid) IS
  '任命团长（唯一）；写职位 + 授予七项能力。转职位需先撤销。';
COMMENT ON FUNCTION public.admin_remove_president(uuid, uuid) IS
  '撤销团长；兼容清理未设职位的旧能力账号。';
COMMENT ON FUNCTION public.admin_set_vice_president(uuid, uuid) IS
  '任命副团长（唯一）；写职位 + 授予七项能力。';
COMMENT ON FUNCTION public.admin_remove_vice_president(uuid, uuid) IS
  '撤销副团长；不会误清团长。';

COMMIT;

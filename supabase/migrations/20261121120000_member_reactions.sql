-- ============================================
-- 成员互动：点赞 / 送花（聚合计数 + 原子累加 RPC）
-- ============================================
--
-- 需求（2026-11-21）：成员卡片右上角展示点赞数与送花数；成员详情页可重复点击，
-- 小程序端按批缓存后调用一次 RPC，减少远程调用次数。
--
-- 设计取舍：
--   · 用独立的 member_reactions 表存聚合计数，不改 profiles —— 计数是互动数据，
--     且高频 UPDATE 不该污染成员主表（也不会触发 profiles 上的审计/同步触发器）。
--   · 重复点击**不做去重**：这是「送花/点赞」的累计数，不是一人一票。
--   · 表本身不给写权限；计数只能经 add_member_reactions 原子累加（SECURITY DEFINER）。
--   · 单次 delta 上限 100、总量上限 int4 max：客户端正常批量的上限也是 100，
--     恶意客户端无法一次把计数顶到溢出；持续调用仍可累加（计数本身是展示数据）。
--   · 允许给自己点赞/送花：这是展示性互动，不做身份限制；若产品后续要禁止，
--     在 RPC 里加 p_target_user_id = auth.uid() 的分支即可。
--
-- 回滚：
--   DROP FUNCTION public.add_member_reactions(uuid, integer, integer);
--   DROP TABLE public.member_reactions;
--   CREATE OR REPLACE VIEW public.profiles_roster AS ...（恢复 20261111170000 的定义）

BEGIN;

CREATE TABLE public.member_reactions (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  likes_count integer NOT NULL DEFAULT 0,
  flowers_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_reactions_likes_nonnegative CHECK (likes_count >= 0),
  CONSTRAINT member_reactions_flowers_nonnegative CHECK (flowers_count >= 0)
);

COMMENT ON TABLE public.member_reactions IS
  '成员收到的点赞/送花聚合计数（只能经 add_member_reactions RPC 原子累加）';
COMMENT ON COLUMN public.member_reactions.likes_count IS '收到的点赞数（累计，上限 int4 max）';
COMMENT ON COLUMN public.member_reactions.flowers_count IS '收到的送花数（累计，上限 int4 max）';

ALTER TABLE public.member_reactions ENABLE ROW LEVEL SECURITY;

-- 计数对所有已登录成员可见；没有 INSERT/UPDATE/DELETE 策略，直接写一律被 RLS 拒绝。
CREATE POLICY "member_reactions_select_authenticated"
  ON public.member_reactions
  FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON public.member_reactions TO authenticated;

-- profiles_roster 末尾追加两列（列顺序保持不变，只追加）
CREATE OR REPLACE VIEW public.profiles_roster AS
SELECT
  p.id,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_email
    THEN p.email
    ELSE NULL::text
  END AS email,
  p.full_name,
  p.instrument,
  p.status,
  p.role,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_college
    THEN p.college
    ELSE NULL::text
  END AS college,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_phone
    THEN p.phone_number
    ELSE NULL::text
  END AS phone_number,
  p.join_date,
  p.created_at,
  p.is_section_leader,
  p.hide_email,
  p.hide_phone,
  p.hide_join_date,
  p.hide_college,
  p.is_in_orchestra,
  p.avatar_url,
  p.is_principal,
  CASE
    WHEN ((SELECT auth.uid()) = p.id) OR (SELECT public.is_admin()) OR NOT p.hide_birthday
    THEN p.birthday
    ELSE NULL::date
  END AS birthday,
  p.hide_birthday,
  lp.position AS leadership_position,
  COALESCE(mr.likes_count, 0) AS likes_count,
  COALESCE(mr.flowers_count, 0) AS flowers_count
FROM public.profiles p
LEFT JOIN public.leadership_positions lp ON lp.user_id = p.id
LEFT JOIN public.member_reactions mr ON mr.user_id = p.id
WHERE p.status = 'approved'::public."profileStatus"
   OR (SELECT auth.uid()) = p.id
   OR (SELECT public.is_admin());

GRANT SELECT ON public.profiles_roster TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.add_member_reactions(
  p_target_user_id uuid,
  p_likes integer DEFAULT 0,
  p_flowers integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_likes integer;
  v_flowers integer;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  IF p_target_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'target_required');
  END IF;

  IF p_likes IS NULL OR p_flowers IS NULL OR p_likes < 0 OR p_flowers < 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_delta');
  END IF;

  -- 先做上限检查，再算和：直接传两个 int4 max 也不会在 `p_likes + p_flowers` 上溢出
  IF p_likes > 100 OR p_flowers > 100 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'delta_too_large');
  END IF;

  IF p_likes + p_flowers = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_delta');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_target_user_id
      AND p.status = 'approved'::public."profileStatus"
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'target_not_found');
  END IF;

  INSERT INTO public.member_reactions AS mr (user_id, likes_count, flowers_count)
  VALUES (p_target_user_id, p_likes, p_flowers)
  ON CONFLICT (user_id) DO UPDATE
    SET likes_count = LEAST(
          mr.likes_count::bigint + EXCLUDED.likes_count,
          2147483647
        )::integer,
        flowers_count = LEAST(
          mr.flowers_count::bigint + EXCLUDED.flowers_count,
          2147483647
        )::integer,
        updated_at = now()
  RETURNING mr.likes_count, mr.flowers_count INTO v_likes, v_flowers;

  RETURN jsonb_build_object('ok', true, 'likes', v_likes, 'flowers', v_flowers);
END;
$$;

REVOKE ALL ON FUNCTION public.add_member_reactions(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_member_reactions(uuid, integer, integer) TO authenticated;

COMMIT;

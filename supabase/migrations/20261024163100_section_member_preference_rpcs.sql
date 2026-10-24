-- ============================================
-- 默认分声部（P7a-2）：判据 + 写 RPC + 读策略
-- ============================================
--
-- 写权（《数据模型与常量》§12.6，覆盖 §9.2）：
--   团长（default_sub_part 能力，全部）/ 声部长（本作用域，组已展开）/
--   首席（本乐器）/ 管理员兜底。
--   目标必须是 approved + role='member'。
--
-- 写只经 `set_member_preference()`（security definer）；表上 authenticated 只有 SELECT。
-- `can_set_preference()` 同时用于 RLS 读策略，所以必须对 authenticated 可执行。
--
-- 回滚：
--   DROP POLICY IF EXISTS "默认分声部：本人/管理层可读" ON public.section_member_preferences;
--   DROP FUNCTION IF EXISTS public.set_member_preference(uuid, integer);
--   DROP FUNCTION IF EXISTS public.can_set_preference(uuid);

BEGIN;

CREATE OR REPLACE FUNCTION public.can_set_preference(p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_member
      AND p.status = 'approved'::public."profileStatus"
      AND p.role = 'member'::public."profileRole"
      AND (
        public.is_admin()
        OR public.has_capability('default_sub_part')
        OR btrim(coalesce(p.instrument, '')) IN (
          SELECT * FROM public.led_sections((SELECT auth.uid()))
          UNION
          SELECT * FROM public.principal_instruments((SELECT auth.uid()))
        )
      )
  );
$function$;

COMMENT ON FUNCTION public.can_set_preference(uuid) IS
  '能否设置该成员的默认分声部：目标 approved+member，且调用者是管理员/团长能力/本作用域声部长/本乐器首席。';

CREATE OR REPLACE FUNCTION public.set_member_preference(p_member uuid, p_sub_part integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.can_set_preference(p_member) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  -- null = 清除；0 与负数无意义（分声部号从 1 起）
  IF p_sub_part IS NOT NULL AND p_sub_part <= 0 THEN
    RAISE EXCEPTION 'invalid_sub_part' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.section_member_preferences (user_id, preferred_sub_part, updated_by)
  VALUES (p_member, p_sub_part, (SELECT auth.uid()))
  ON CONFLICT (user_id) DO UPDATE
    SET preferred_sub_part = EXCLUDED.preferred_sub_part,
        updated_by = EXCLUDED.updated_by;
END
$function$;

COMMENT ON FUNCTION public.set_member_preference(uuid, integer) IS
  '设置/清除成员默认分声部（p_sub_part 为 null 时清除）。权限由 can_set_preference 判。';

CREATE POLICY "默认分声部：本人/管理层可读" ON public.section_member_preferences
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_admin()
    OR public.can_set_preference(user_id)
  );

REVOKE ALL ON FUNCTION public.can_set_preference(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_set_preference(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_member_preference(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_preference(uuid, integer) TO authenticated, service_role;

COMMIT;

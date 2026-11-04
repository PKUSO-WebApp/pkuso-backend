-- ============================================
-- 撤销声部长/首席：按「我看到的当前负责人」做 CAS
-- ============================================
--
-- 背景：`admin_remove_section_leader(p_section)` / `admin_remove_principal(p_instrument)`
-- 只按作用域 DELETE。两个管理员并发时，A 把长笛声部长从张三换成李四，B 的旧页面
-- 点撤销（它以为要撤张三）→ 服务端按「长笛」把李四删掉。
--
-- 这里新增带 expected id 的 `_checked` 版本：DELETE 同时匹配作用域与当前负责人；
-- 不匹配返回 **leader_changed / principal_changed**，Web 映射为「已被别人修改，请刷新」。
-- 旧的 2 参函数暂不删除（已部署的前端可能还在调），但新 Web 只走 `_checked`；
-- 待 Web prod 同步后可另开 migration 收掉旧函数。
--
-- 回滚：
--   DROP FUNCTION IF EXISTS public.admin_remove_section_leader_checked(text, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.admin_remove_principal_checked(text, uuid, uuid);

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_remove_section_leader_checked(
  p_section text,
  p_expected_leader_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);
  -- 与 set 共用同一把锁：撤销也要和「读冲突 → 写」线性化。
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

  IF NOT EXISTS (
    SELECT 1 FROM public.sections WHERE name = p_section AND can_lead
  ) THEN
    RAISE EXCEPTION 'invalid_scope: %', p_section USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.section_leaders
  WHERE section = p_section
    AND leader_id = p_expected_leader_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'leader_changed' USING ERRCODE = '22023';
  END IF;
END
$function$;

COMMENT ON FUNCTION public.admin_remove_section_leader_checked(text, uuid, uuid) IS
  '撤销声部长（CAS）：仅当当前 leader_id 仍等于 p_expected_leader_id 时删除，否则 leader_changed。';

CREATE OR REPLACE FUNCTION public.admin_remove_principal_checked(
  p_instrument text,
  p_expected_principal_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.sections
    WHERE name = p_instrument AND kind = 'instrument' AND can_principal
  ) THEN
    RAISE EXCEPTION 'invalid_scope: %', p_instrument USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.instrument_principals
  WHERE instrument = p_instrument
    AND principal_id = p_expected_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal_changed' USING ERRCODE = '22023';
  END IF;
END
$function$;

COMMENT ON FUNCTION public.admin_remove_principal_checked(text, uuid, uuid) IS
  '撤销首席（CAS）：仅当当前 principal_id 仍等于 p_expected_principal_id 时删除，否则 principal_changed。';

REVOKE ALL ON FUNCTION public.admin_remove_section_leader_checked(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_section_leader_checked(text, uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_principal_checked(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_principal_checked(text, uuid, uuid)
  TO service_role;

COMMIT;

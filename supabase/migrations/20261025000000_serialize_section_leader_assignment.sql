-- ============================================
-- P0b 并发修复：声部长任命的 check-then-insert 加事务级 advisory lock
-- ============================================
--
-- 竞态（2026-10-24 审查发现）：
--   A 任命「木管」部长、B 同时任命「长笛」部长；两事务在 READ COMMITTED 下
--   互相看不到对方未提交的行，两段 EXISTS 都通过，最终同时落下
--   「组部长 + 组内乐器部长」，违反组/乐器互斥不变量。
--
-- 注：P0c 收敛后，木管/铜管组内乐器已不允许单独任命（can_lead=false），
-- 当前作用域规则下这条具体路径不可达；本锁作为不变量防御保留，
-- 避免未来扩展作用域或出现历史数据时重新暴露。
--
-- 修法（用户 2026-10-25 定：用 backend lock）：
--   `admin_set_section_leader` 与 `admin_remove_section_leader` 在事务开头取
--   同一把 `pg_advisory_xact_lock`，把「读冲突 → 写」串行化；锁随事务提交/回滚释放。
--   全局串行只影响管理员任命这种低频操作，不需要按作用域细分。
--
-- 锁 key：`hashtext('public.section_leaders')::bigint`；两个函数必须用同一表达式。
--
-- 回滚：重新执行 20261023130200_leadership_functions.sql 中这两个函数的定义
-- （即去掉 PERFORM pg_advisory_xact_lock 那一行）。

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_set_section_leader(
  p_section text,
  p_leader_id uuid,
  p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_kind text;
  v_instrument text;
BEGIN
  PERFORM public.assert_admin_actor(p_actor_id);

  -- 串行化所有 section_leaders 的写路径，关闭 check-then-insert 竞态。
  PERFORM pg_advisory_xact_lock(hashtext('public.section_leaders')::bigint);

  SELECT kind INTO v_kind
  FROM public.sections
  WHERE name = p_section AND can_lead;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'invalid_scope: %', p_section USING ERRCODE = '22023';
  END IF;

  SELECT btrim(coalesce(instrument, '')) INTO v_instrument
  FROM public.profiles
  WHERE id = p_leader_id
    AND status = 'approved'::public."profileStatus"
    AND coalesce(role, 'member'::public."profileRole") = 'member'::public."profileRole";
  IF v_instrument IS NULL OR v_instrument = '' THEN
    RAISE EXCEPTION 'target_not_eligible' USING ERRCODE = '22023';
  END IF;

  IF v_kind = 'instrument' THEN
    IF v_instrument <> p_section THEN
      RAISE EXCEPTION 'target_not_in_scope' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.section_group_members
      WHERE group_name = p_section AND member_name = v_instrument
    ) THEN
      RAISE EXCEPTION 'target_not_in_scope' USING ERRCODE = '22023';
    END IF;

    -- 组内已有乐器部长 ⇒ 不再设组
    IF EXISTS (
      SELECT 1 FROM public.section_group_members sgm
      JOIN public.section_leaders sl ON sl.section = sgm.member_name
      WHERE sgm.group_name = p_section
    ) THEN
      RAISE EXCEPTION 'scope_overlap' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 乐器已在某个可作部长作用域的组里有部长 ⇒ 不再设该乐器
  IF v_kind = 'instrument' AND EXISTS (
    SELECT 1
    FROM public.section_group_members sgm
    JOIN public.sections g ON g.name = sgm.group_name AND g.can_lead
    JOIN public.section_leaders sl ON sl.section = sgm.group_name
    WHERE sgm.member_name = p_section
  ) THEN
    RAISE EXCEPTION 'scope_overlap' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.section_leaders (section, leader_id, assigned_by, assigned_at)
  VALUES (p_section, p_leader_id, p_actor_id, now())
  ON CONFLICT (section) DO UPDATE
    SET leader_id = EXCLUDED.leader_id,
        assigned_by = EXCLUDED.assigned_by,
        assigned_at = EXCLUDED.assigned_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_section_leader(
  p_section text,
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
  DELETE FROM public.section_leaders WHERE section = p_section;
END
$function$;

REVOKE ALL ON FUNCTION public.admin_set_section_leader(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_section_leader(text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_remove_section_leader(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_section_leader(text, uuid) TO service_role;

COMMENT ON FUNCTION public.admin_set_section_leader(text, uuid, uuid) IS
  '任命声部长；事务级 advisory lock 串行化，防止组/乐器互斥的并发 check-then-insert 竞态。';
COMMENT ON FUNCTION public.admin_remove_section_leader(text, uuid) IS
  '撤销声部长；与 admin_set_section_leader 共用 advisory lock。';

COMMIT;

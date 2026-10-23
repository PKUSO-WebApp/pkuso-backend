-- ============================================
-- 声部请假通知：成员提交请假 ⇒ 通知其声部长/首席/团长
-- ============================================
--
-- 用途：mp「我的 → 通知 → 声部请假」的未读徽章。徽章沿用现有通知机制
-- （notifications 表 + read_at），本迁移只负责**产生**通知行；分类
-- `section_leave` 在上一个 migration 里加入 enum。
--
-- 收件人 = 能管理该成员的人（与 my_managed_sections 同一口径）：
--   · 该乐器的声部长（section_leaders.section = 乐器）
--   · 管理了包含该乐器的声部组的组长（section_group_members）
--   · 该乐器的首席（instrument_principals）
--   · 拥有 attendance 能力的团长（president_capabilities）
-- 排除申请人本人（声部长给自己提请假时不该通知自己）。
--
-- 只在 INSERT（新申请）时通知：
--   · 取消/撤回在声部请假页里以状态行展示，不额外产生通知；
--   · 管理员审批结果已有既有的 attendance 通知给申请人，不重复。
--
-- 可见性：分排且该成员声部不在 target_section 内时，其声部长也看不到这场
-- （can_view_rehearsal_attendance 的同一方向），因此不产生通知。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS notify_section_leave_event ON public.leave_requests;
--   DROP FUNCTION IF EXISTS public.notify_section_leave_event();

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_section_leave_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_member     public.profiles%ROWTYPE;
  v_rehearsal  public.rehearsals%ROWTYPE;
  v_instrument text;
  v_name       text;
  v_repertoire text;
  v_type       text;
  v_when       text;
  v_content    text;
  v_leader     uuid;
BEGIN
  SELECT * INTO v_member FROM public.profiles WHERE id = NEW.user_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_instrument := btrim(coalesce(v_member.instrument, ''));
  -- 「其他」/空声部没有可管理的声部长，不产生通知
  IF v_instrument = '' OR v_instrument = '其他' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rehearsal FROM public.rehearsals WHERE id = NEW.rehearsal_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 分排且该成员不在目标声部内 ⇒ 连其声部长也看不到这场，不通知
  IF coalesce(cardinality(v_rehearsal.target_section), 0) > 0
     AND NOT (v_instrument = ANY (v_rehearsal.target_section)) THEN
    RETURN NEW;
  END IF;

  v_name := coalesce(nullif(btrim(v_member.full_name), ''), '成员');
  v_repertoire := coalesce(
    nullif(btrim(v_rehearsal.repertoire), ''),
    nullif(btrim(v_rehearsal.title), ''),
    '排练'
  );
  v_type := CASE
    WHEN v_rehearsal.type = 'full' THEN '合排'
    WHEN v_rehearsal.type = 'section' THEN '分排'
    ELSE '排练'
  END;

  BEGIN
    v_when := to_char(v_rehearsal.start_time::timestamp, 'MM-DD HH24:MI');
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      v_when := NULL;
  END;

  v_content := v_name || '（' || v_instrument || '）提交了'
    || CASE WHEN v_when IS NULL THEN '' ELSE ' ' || v_when END
    || ' ' || v_type || '《' || v_repertoire || '》的请假申请';

  FOR v_leader IN
    SELECT DISTINCT l.leader_id
    FROM (
      -- 该乐器的声部长
      SELECT sl.leader_id
      FROM public.section_leaders sl
      WHERE sl.section = v_instrument
      UNION
      -- 管理了包含该乐器的声部组的组长
      SELECT sl.leader_id
      FROM public.section_leaders sl
      JOIN public.section_group_members sgm ON sgm.group_name = sl.section
      WHERE sgm.member_name = v_instrument
      UNION
      -- 该乐器的首席
      SELECT ip.principal_id
      FROM public.instrument_principals ip
      WHERE ip.instrument = v_instrument
      UNION
      -- 拥有考勤能力的团长（团长的能力开口，见 P0b 的 president_capabilities）
      SELECT pc.user_id
      FROM public.president_capabilities pc
      WHERE pc.capability = 'attendance'
    ) l
    WHERE l.leader_id IS NOT NULL
      AND l.leader_id <> NEW.user_id
  LOOP
    INSERT INTO public.notifications (user_id, category, title, content, kind, meta)
    VALUES (
      v_leader,
      'section_leave'::public."notificationCategory",
      '声部请假申请',
      v_content,
      'section_leave_request',
      jsonb_build_object(
        'request_id', NEW.id,
        'user_id', NEW.user_id,
        'rehearsal_id', NEW.rehearsal_id
      )
    );
  END LOOP;

  RETURN NEW;
END
$function$;

CREATE TRIGGER notify_section_leave_event
  AFTER INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_section_leave_event();

-- 与既有触发器函数同一条纪律：只由触发器调用，不给客户端角色 EXECUTE
REVOKE EXECUTE ON FUNCTION public.notify_section_leave_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_section_leave_event() FROM anon;
GRANT EXECUTE ON FUNCTION public.notify_section_leave_event() TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_section_leave_event() TO service_role;

COMMIT;

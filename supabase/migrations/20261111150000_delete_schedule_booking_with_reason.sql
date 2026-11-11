-- ============================================
-- 删除预约：团长删他人预约时必须给原因并通知预约人
-- ============================================
--
-- 用户 2026-11-11 指定：
--   · 团长可以删除任何人的人工预约；
--   · 删除别人的预约时最好告知原因，并给作者发系统通知；
--   · 影子预约（rehearsal_id 非空）不能直接删，UI 引导去排练详情页删排练。
--
-- 本 RPC 取代 mp 里对 schedules 的直接 DELETE（RLS 仍保留给作者/管理员/web 用）。
-- 作者删除自己的预约：不要求原因、不发通知。
-- 非作者（团长/管理员）删除：要求原因；作者存在时插入 system 通知（best-effort）。
--
-- 回滚：DROP FUNCTION public.delete_schedule_booking(bigint, text);

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_schedule_booking(
  p_schedule_id bigint,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sched    public.schedules%ROWTYPE;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_is_author boolean;
  v_title    text;
  v_start    text;
  v_content  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sched
  FROM public.schedules
  WHERE id = p_schedule_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_sched.rehearsal_id IS NOT NULL THEN
    -- 影子预约：删了排练还在，必须走排练删除（UI 会跳转）
    RETURN jsonb_build_object('ok', false, 'code', 'is_rehearsal');
  END IF;

  v_is_author := v_sched.author_id = auth.uid();
  IF NOT (
    v_is_author
    OR public.is_admin()
    OR public.has_capability('rehearsal')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_allowed');
  END IF;

  -- 非作者删除：必须给原因（作者会在通知里看到）
  IF NOT v_is_author AND v_sched.author_id IS NOT NULL AND v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required');
  END IF;

  DELETE FROM public.schedules WHERE id = p_schedule_id;

  IF NOT v_is_author AND v_sched.author_id IS NOT NULL THEN
    v_title := coalesce(nullif(btrim(v_sched.title), ''), '未命名预约');
    v_start := to_char(v_sched.start_time, 'YYYY-MM-DD HH24:MI');
    v_content := '你创建的预约「' || v_title || '」（' || v_start || '）已被团长删除。原因：'
                 || v_reason;
    BEGIN
      INSERT INTO public.notifications (user_id, category, title, content, kind, meta)
      VALUES (
        v_sched.author_id,
        'system'::public."notificationCategory",
        '预约已被删除',
        v_content,
        'schedule_deleted',
        jsonb_build_object(
          'schedule_id', v_sched.id,
          'start_time', v_sched.start_time,
          'end_time', v_sched.end_time,
          'reason', v_reason
        )
      );
    EXCEPTION WHEN OTHERS THEN
      -- 通知失败不阻断删除主操作
      NULL;
    END;

    RETURN jsonb_build_object('ok', true, 'notified', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'notified', false);
END
$function$;

REVOKE ALL ON FUNCTION public.delete_schedule_booking(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_schedule_booking(bigint, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_schedule_booking(bigint, text) IS
  '删除人工预约；非作者删除需原因并给作者发 system 通知；影子预约返回 is_rehearsal。';

COMMIT;

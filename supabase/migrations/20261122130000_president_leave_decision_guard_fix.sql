-- ============================================
-- 修复：团长在小程序里审批请假被 42501 拒绝
-- ============================================
--
-- 现象：president_decide_leave_request 返回 HTTP 403，Postgres 日志为
--   only the request owner may update this request
--   PL/pgSQL function guard_member_leave_request_update() line 9 at RAISE
--
-- 根因：guard_member_leave_request_update 只放行 service_role（web 管理端）与
-- 「申请本人」，没有给团长的审批路径留口。president_decide_leave_request 虽是
-- SECURITY DEFINER，但触发器里的 auth.uid() 读的是**请求 JWT**（审批人 ≠ 申请人），
-- 因此团长的 UPDATE 必然被拒。该缺陷从团长审批功能上线起就存在（web 走 service_role
-- 所以一直正常）。
--
-- 修法：沿用本仓库既有的「事务级 GUC 窄口」模式（与 internal_cancel_leave、
-- guard_profile_privileged_columns 同款）：
--   · president_decide_leave_request 在能力校验通过后 SET LOCAL 一个内部标记；
--   · guard_member_leave_request_update 见到该标记就直接放行。
-- 窄口只存在于本次 RPC 调用的事务内；直连表 UPDATE 的成员仍走原来的守卫。
--
-- 回滚：恢复 20261111140000 中 president_decide_leave_request 的原文
-- （去掉 set_config 那一行），并把 guard_member_leave_request_update 的条件
-- 恢复为「service_role 或 internal_cancel_leave」。

BEGIN;

-- ---------------------------------------------------------------------------
-- 守卫触发器：增加团长审批窄口
-- （该函数早于 migration 基线，仓库里没有它的创建文件；此处按线上定义重建）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_member_leave_request_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.role() = 'service_role'
     OR current_setting('pkuso.internal_cancel_leave', true) = 'on'
     OR current_setting('pkuso.internal_president_leave_decision', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.user_id THEN
    RAISE EXCEPTION 'only the request owner may update this request'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status NOT IN (
       'pending'::public."leaveStatus",
       'rejected'::public."leaveStatus"
     )
     OR NEW.status NOT IN (
       'pending'::public."leaveStatus",
       'withdrawn'::public."leaveStatus",
       'canceled'::public."leaveStatus"
     ) THEN
    RAISE EXCEPTION 'invalid member leave request status transition'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.rehearsal_id IS DISTINCT FROM OLD.rehearsal_id
     OR NEW.target_status IS DISTINCT FROM OLD.target_status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.reject_reason IS NOT NULL THEN
    RAISE EXCEPTION 'member cannot modify protected leave request fields'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'pending'::public."leaveStatus"
     AND EXISTS (
       SELECT 1
       FROM public.attendances a
       WHERE a.rehearsal_id = NEW.rehearsal_id
         AND a.user_id = NEW.user_id
         AND a.status IN (
           'present'::public."attendanceStatus",
           'late'::public."attendanceStatus"
         )
     ) THEN
    RAISE EXCEPTION 'cannot request leave after signing in (present/late)'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 团长请假审批：能力校验通过后打开窄口（其余逻辑与 20261111140000 一致）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.president_decide_leave_request(
  p_request_id uuid,
  p_approve boolean,
  p_reject_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_req         public.leave_requests%ROWTYPE;
  v_att_status  public."attendanceStatus";
  v_sign_in     timestamp;
  v_reason      text := nullif(btrim(coalesce(p_reject_reason, '')), '');
  v_warning     text;
  v_start       text;
  v_type        text;
  v_repertoire  text;
  v_rehearsal_title text;
  v_date        text := '';
  v_type_word   text := '';
  v_name        text;
  v_content     text;
BEGIN
  PERFORM public.president_require_capability('leave_approval');

  -- 事务级窄口：放行 guard_member_leave_request_update 的「仅申请人可更新」守卫。
  -- SET LOCAL 语义（is_local = true），只作用于本次 RPC 调用的事务。
  PERFORM set_config('pkuso.internal_president_leave_decision', 'on', true);

  SELECT * INTO v_req
  FROM public.leave_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_req.status <> 'pending'::public."leaveStatus" THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;
  -- 不排除 v_req.user_id = auth.uid()：团长可以审批自己的请假申请。

  SELECT r.start_time, r.type, r.repertoire, r.title
    INTO v_start, v_type, v_repertoire, v_rehearsal_title
  FROM public.rehearsals r
  WHERE r.id = v_req.rehearsal_id;

  IF p_approve THEN
    SELECT a.status, a.sign_in_time
      INTO v_att_status, v_sign_in
    FROM public.attendances a
    WHERE a.rehearsal_id = v_req.rehearsal_id
      AND a.user_id = v_req.user_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_sign_in IS NOT NULL THEN
        -- 已实际签到：不覆盖签到记录，申请照常通过
        v_warning := 'signed_in';
      ELSIF v_att_status = 'exempt'::public."attendanceStatus" THEN
        -- 无需出勤：保持原状态，申请照常通过
        v_warning := 'exempt';
      ELSE
        UPDATE public.attendances
        SET status = v_req.target_status,
            updated_by = auth.uid()
        WHERE rehearsal_id = v_req.rehearsal_id
          AND user_id = v_req.user_id;
      END IF;
    ELSE
      INSERT INTO public.attendances (rehearsal_id, user_id, status, updated_by)
      VALUES (v_req.rehearsal_id, v_req.user_id, v_req.target_status, auth.uid());
    END IF;

    UPDATE public.leave_requests
    SET status = 'approved'::public."leaveStatus"
    WHERE id = p_request_id;

    -- 通知文案与 web 的 insertLeaveNotification 保持一致（best-effort）
    IF v_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      v_date := ltrim(substring(v_start from 6 for 2), '0') || '月'
                || ltrim(substring(v_start from 9 for 2), '0') || '日';
    END IF;
    v_type_word := CASE v_type
      WHEN 'full' THEN '合排'
      WHEN 'section' THEN '分排'
      ELSE ''
    END;
    v_name := coalesce(
      nullif(btrim(v_repertoire), ''),
      nullif(btrim(v_rehearsal_title), ''),
      '排练'
    );
    v_content := v_date || '《' || v_name || '》的' || v_type_word || '请假申请已通过';

    BEGIN
      INSERT INTO public.notifications (user_id, category, title, content)
      VALUES (
        v_req.user_id,
        'attendance'::public."notificationCategory",
        '请假申请已通过',
        v_content
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'ok', true,
      'request_id', p_request_id,
      'status', 'approved',
      'warning', v_warning
    );
  ELSE
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'reject_reason_required');
    END IF;

    UPDATE public.leave_requests
    SET status = 'rejected'::public."leaveStatus",
        reject_reason = v_reason
    WHERE id = p_request_id;

    IF v_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      v_date := ltrim(substring(v_start from 6 for 2), '0') || '月'
                || ltrim(substring(v_start from 9 for 2), '0') || '日';
    END IF;
    v_type_word := CASE v_type
      WHEN 'full' THEN '合排'
      WHEN 'section' THEN '分排'
      ELSE ''
    END;
    v_name := coalesce(
      nullif(btrim(v_repertoire), ''),
      nullif(btrim(v_rehearsal_title), ''),
      '排练'
    );
    v_content := v_date || '《' || v_name || '》的' || v_type_word
                 || '请假申请已被驳回，原因：' || v_reason;

    BEGIN
      INSERT INTO public.notifications (user_id, category, title, content)
      VALUES (
        v_req.user_id,
        'attendance'::public."notificationCategory",
        '请假申请被驳回',
        v_content
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'ok', true,
      'request_id', p_request_id,
      'status', 'rejected'
    );
  END IF;
END
$function$;

COMMIT;

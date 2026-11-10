-- ============================================
-- 入团审批：member_info 预填改为 best-effort
-- ============================================
--
-- 20261110160000 把「状态置 approved」和「从 member_info 预填字段」放在同一条
-- UPDATE 里。预填只要失败（例如 member_info 的邮箱在 auth.users 已存在，
-- sync_profile_to_auth 更新 auth.users 时会撞唯一约束），整条审批就会回滚，
-- 申请停留在 pending —— 这与 web `/api/admin/approve` 的语义不一致：
-- web 先置 approved，再在独立 try/catch 里预填，预填失败不影响审批。
--
-- 本迁移拆成两步：
--   1) 状态更新必须成功（仍走事务级 GUC 窄口）；
--   2) 预填在独立子事务里做，失败只回滚预填，不影响已批准的 status。
--
-- 同时把 member_info 的匹配改成「按姓名恰好一行才预填」：web 用的是
-- `.single()`，0 行或多行都会跳过；原先的 LIMIT 1 在重名时会填错人的资料。
--
-- 回滚：恢复 20261110160000 中 president_decide_membership_request 的单条 UPDATE 版本。

BEGIN;

CREATE OR REPLACE FUNCTION public.president_decide_membership_request(
  p_user_id uuid,
  p_approve boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile    public.profiles%ROWTYPE;
  v_info       public.member_info%ROWTYPE;
  v_info_count integer := 0;
  v_norm       text;
  v_instrument text;
BEGIN
  PERFORM public.president_require_capability('membership_approval');

  IF p_user_id = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval_not_allowed');
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_profile.status <> 'pending'::public."profileStatus" THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;

  IF p_approve THEN
    -- 与 web 的 /api/admin/approve 一致：按姓名从 member_info 预填空字段（best-effort）。
    -- 0 行或多行都跳过（web 用 .single()，多行会进入 catch）。
    IF nullif(btrim(v_profile.full_name), '') IS NOT NULL THEN
      SELECT count(*) INTO v_info_count
      FROM public.member_info
      WHERE full_name = v_profile.full_name;

      IF v_info_count = 1 THEN
        SELECT * INTO v_info
        FROM public.member_info
        WHERE full_name = v_profile.full_name
        LIMIT 1;
      END IF;
    END IF;

    IF v_info.id IS NOT NULL
       AND nullif(btrim(v_profile.instrument), '') IS NULL
       AND nullif(btrim(v_info.instrument_name), '') IS NOT NULL THEN
      v_norm := lower(btrim(v_info.instrument_name));
      v_instrument := CASE v_norm
        WHEN '一提' THEN '第一小提琴'
        WHEN '一小' THEN '第一小提琴'
        WHEN '第一小提琴' THEN '第一小提琴'
        WHEN '1st violin' THEN '第一小提琴'
        WHEN '二提' THEN '第二小提琴'
        WHEN '二小' THEN '第二小提琴'
        WHEN '第二小提琴' THEN '第二小提琴'
        WHEN '2nd violin' THEN '第二小提琴'
        WHEN '中提' THEN '中提琴'
        WHEN '中提琴' THEN '中提琴'
        WHEN 'viola' THEN '中提琴'
        WHEN '大提' THEN '大提琴'
        WHEN '大提琴' THEN '大提琴'
        WHEN 'cello' THEN '大提琴'
        WHEN '低音提' THEN '低音提琴'
        WHEN '低音提琴' THEN '低音提琴'
        WHEN 'double bass' THEN '低音提琴'
        WHEN '贝斯' THEN '低音提琴'
        WHEN 'bass' THEN '低音提琴'
        WHEN '长笛' THEN '长笛'
        WHEN 'flute' THEN '长笛'
        WHEN '双簧管' THEN '双簧管'
        WHEN 'oboe' THEN '双簧管'
        WHEN '欧宝' THEN '双簧管'
        WHEN '单簧管' THEN '单簧管'
        WHEN '黑管' THEN '单簧管'
        WHEN 'clarinet' THEN '单簧管'
        WHEN '大管' THEN '大管'
        WHEN '巴松' THEN '大管'
        WHEN 'bassoon' THEN '大管'
        WHEN '圆号' THEN '圆号'
        WHEN 'horn' THEN '圆号'
        WHEN '小号' THEN '小号'
        WHEN 'trumpet' THEN '小号'
        WHEN '长号' THEN '长号'
        WHEN 'trombone' THEN '长号'
        WHEN '大号' THEN '大号'
        WHEN 'tuba' THEN '大号'
        WHEN '打击乐' THEN '打击乐'
        WHEN '打击' THEN '打击乐'
        WHEN 'percussion' THEN '打击乐'
        WHEN '键盘' THEN '键盘'
        WHEN '钢琴' THEN '键盘'
        WHEN 'keyboard' THEN '键盘'
        WHEN '竖琴' THEN '竖琴'
        WHEN 'harp' THEN '竖琴'
        WHEN '其他' THEN '其他'
        ELSE CASE
          WHEN EXISTS (
            SELECT 1 FROM public.sections s
            WHERE s.name = btrim(v_info.instrument_name)
              AND s.kind = 'instrument'
          ) THEN btrim(v_info.instrument_name)
          ELSE '其他'
        END
      END;
    END IF;

    -- 第 1 步：状态更新必须成功。窄口只放行这一次 pending → approved；
    -- 触发器仍要求 role 不变。
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'on', true);
    BEGIN
      UPDATE public.profiles
      SET status = 'approved'::public."profileStatus"
      WHERE id = p_user_id;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);
      RAISE;
    END;
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);

    -- 第 2 步：预填是 best-effort。此时 status 已经是 approved，若预填失败，
    -- 子事务只回滚预填，不推翻审批（与 web 的先批准、后预填一致）。
    IF v_info.id IS NOT NULL
       AND (
         nullif(btrim(v_info.email), '') IS NOT NULL
         OR nullif(btrim(v_info.college), '') IS NOT NULL
         OR v_instrument IS NOT NULL
       ) THEN
      BEGIN
        UPDATE public.profiles
        SET email = coalesce(nullif(btrim(email), ''), nullif(btrim(v_info.email), '')),
            college = coalesce(nullif(btrim(college), ''), nullif(btrim(v_info.college), '')),
            instrument = coalesce(nullif(btrim(instrument), ''), v_instrument)
        WHERE id = p_user_id;
      EXCEPTION WHEN OTHERS THEN
        -- 预填失败不影响批准流程
        NULL;
      END;
    END IF;

    RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', 'approved');
  ELSE
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'on', true);
    BEGIN
      UPDATE public.profiles
      SET status = 'rejected'::public."profileStatus"
      WHERE id = p_user_id;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);
      RAISE;
    END;
    PERFORM pg_catalog.set_config('pkuso.allow_membership_decision', 'off', true);

    RETURN jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', 'rejected');
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.president_decide_membership_request(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.president_decide_membership_request(uuid, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.president_decide_membership_request(uuid, boolean) IS
  '团长通过/驳回入团（membership_approval）；批准与 member_info 预填分开，预填失败不回滚批准。';

COMMIT;

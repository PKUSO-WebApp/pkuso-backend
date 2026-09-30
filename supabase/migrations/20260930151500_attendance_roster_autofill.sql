-- ============================================
-- 考勤：把「名单完整性」变成数据库的不变量（issue #82）
-- ============================================
--
-- ## 病根
--
-- 「某个成员该不该有这一场的考勤行」从来没有被定义过，实际等于**发布那一刻 web 端
-- 内存里的数组**：pkuso-web 的 `admin/rehearsals/new/page.tsx` 在 create 之后拿
-- `useProfiles({status:'approved'})` 的结果做一次 `batchInsert`，**失败只 console.error、
-- 不阻断发布**（profiles 还没加载完就提交 ⇒ 静默写入一份不完整的名单）。
--
-- 而所有读者都从 `attendances` 反推名单（web 考勤弹窗、两个导出、mp 的考勤历史与
-- `summarizeAttendance` —— 它的 total 直接等于行数）⇒ 缺行 = 这个人**从名单里消失**，
-- 管理员在 web 端既看不到他也改不了他。
--
-- prod 实测（2026-09-30 只读查）：5 场排练全中，共缺 38 对。
--
-- ⚠️ 一条**订正过**的判据（同日发现）：先前这里写着「其中 17 对的账号建号早于排练开始，
-- 所以不是『新成员』这一个特例」—— **那是测错的，结论正好相反**。那条查询拿
-- `created_at <= start_time::timestamp` 比较，而右边被按**会话时区（UTC）**解释，
-- 边界整整推后了 8 小时。按北京时刻重算：**38 对全部是「建号晚于排练开始」**，
-- 09-13 那场的 17 个账号正是在那场 14:00 的排练开始之后（当天 14:00–22:00）才建的 ——
-- 即「先参加排练、后建号」，是**新成员那一类**，不是「当时已在册却没进名单」。
--
-- 这条事实钉死了下面第二条边界：自动补名单只能**向前**补。任何靠 created_at 去猜
-- 「谁当时在团」的规则都不成立 —— 建号时间与入团时间没有对应关系（很多人是先参加
-- 第一次排练、之后才建号来记考勤的）。已结束的排练那份历史缺口只能由**人**来判断
-- （issue #82 里给了候选清单查询与「按人补一行」的模板）。
--
-- ## 不变量（本 migration 建立的东西）
--
--   (排练 R, 成员 M) 存在出勤行  ⟺  M 在 R 结束时已是 approved 的 member
--
-- 三个入口共同维护：
--   · 建/改排练（触发器）→ 立即补齐
--   · 成员被批准（触发器）→ 给所有尚未结束的排练补行
--   · 客户端显式调 ensure_attendance_roster（RPC）→ 自愈兜底
--
-- ## 边界（写死在函数里，不靠调用方记得）
--
-- · **只碰尚未结束的排练**。「结束」的判据与签到 RPC 同源：
--   COALESCE(end_time, start_time + 3h) >= now() AT TIME ZONE 'Asia/Shanghai'。
--   已结束的排练**一行都不加** —— 历史不由本函数重写。这不只是「谨慎」：对已结束的
--   排练，**没有任何数据能判断谁当时在团**（见上面那条订正）。存量缺口由人工判断后
--   手工补，脚本里只提供「列出候选 + 按人补一行」的工具，不提供自动规则。
-- · **只增不删、绝不改已有行**：NOT EXISTS 反连接 + (rehearsal_id, user_id) 唯一约束
--   双重保证幂等；不碰任何已存在行的 status / sign_in_time。
-- · **只补 member**：role 列可空，空值按列默认值 member 算（与 web 的两处同一判据）。
--
-- ## 为什么触发器是「全量补」而不是「只补这一场」
--
-- 触发器函数统一调 `fill_attendance_roster(NULL)`（= 所有尚未结束的排练）。它幂等、
-- 一次反连接就跑完，代价可忽略；好处是**任何一次事件都会顺手把更早的缺口自愈掉**，
-- 而不是「这一场修好了、上一场还缺着」。
--
-- ## 权限
--
-- · `fill_attendance_roster`（核心）：**不给任何客户端角色 EXECUTE**，只由触发器与
--   RPC 壳（都是 SECURITY DEFINER，以 owner 身份执行）调用。手工补名单请在 SQL Editor
--   直接调它 —— RPC 壳反而调不了（见下条）。
-- · `ensure_attendance_roster`（RPC 壳）：给 authenticated + service_role，函数内校验
--   `is_admin()` / `service_role`。SQL Editor 里没有 JWT ⇒ auth.role() / auth.uid() 都是
--   NULL ⇒ 会被这道校验挡下（与 guard_profile_privileged_columns 同一条已知取舍）。
-- · 触发器函数按本仓既有纪律 REVOKE anon。
--
-- ## 回滚
--
--   DROP TRIGGER IF EXISTS trigger_fill_attendance_roster_on_profile ON public.profiles;
--   DROP TRIGGER IF EXISTS trigger_fill_attendance_roster_on_rehearsal ON public.rehearsals;
--   DROP FUNCTION IF EXISTS public.fill_attendance_roster_on_change();
--   DROP FUNCTION IF EXISTS public.ensure_attendance_roster(bigint[]);
--   DROP FUNCTION IF EXISTS public.fill_attendance_roster(bigint[]);
--   DROP FUNCTION IF EXISTS public.rehearsal_is_upcoming(text, text);
--   回滚只移除「以后自动补」，已经补出来的行留在库里（它们本来就是对的）。
--
-- ## 验证
--
-- 一次性 postgres:17-alpine 容器 + 最小 schema（见 PR 描述），逐条跑 issue #82 的契约。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 判据：这场排练结束了吗
-- ---------------------------------------------------------------------------
--
-- 与 sign_in_attendance_location 的两处判据保持一致：
--   · end_time 缺失 ⇒ start_time + 3 小时（签到 RPC 的同一个默认时长）
--   · 时区 Asia/Shanghai（start_time / end_time 是 text 里的**本地**时间，不是 timestamptz）
--
-- start_time 为 NULL / 空 / 解析不了 ⇒ false（= 不补）。**刻意不猜**：解析不了的排练
-- 补进去只会产生不可见或错误的行，而 fill 可以反复跑 —— 等时间被修好，下一次事件
-- （改排练、批准成员、RPC）自然就补上了。这里只吞两种「文本不是时间戳」的错误码，
-- 别的异常照常抛出（不掩盖真实故障）。
--
-- ⚠️ 两边都解析（即使 end 有效也要解析 start）：初版只在与 end 无关时才碰 start，
-- 于是一条 start_time = 'xxxx'、end_time 正常的脏数据会被判成「未结束」并补出一批行。
-- 判据要的是「这两个时间我读得懂」，那就两个都得读。
CREATE OR REPLACE FUNCTION public.rehearsal_is_upcoming(p_start text, p_end text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_start timestamp;
  v_end timestamp;
BEGIN
  IF p_start IS NULL OR btrim(p_start) = '' THEN
    RETURN false;
  END IF;

  v_start := p_start::timestamp;

  IF p_end IS NOT NULL AND btrim(p_end) <> '' THEN
    v_end := p_end::timestamp;
  ELSE
    -- 与签到 RPC 的默认时长一致
    v_end := v_start + interval '3 hours';
  END IF;

  RETURN v_end >= (now() AT TIME ZONE 'Asia/Shanghai')::timestamp;
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN false;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. 核心：补齐名单（幂等、只增、只碰尚未结束的排练）
-- ---------------------------------------------------------------------------
--
-- p_rehearsal_ids 为 NULL = 所有尚未结束的排练；空数组 = 什么都不做（显式传空不该被
-- 读成「全部」）。返回本次插入的行数，便于调用方与验证时对数。
CREATE OR REPLACE FUNCTION public.fill_attendance_roster(p_rehearsal_ids bigint[] DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rehearsal_ids IS NOT NULL AND cardinality(p_rehearsal_ids) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.attendances (rehearsal_id, user_id, status)
  SELECT r.id, p.id, 'absent'::public."attendanceStatus"
    FROM public.rehearsals AS r
    CROSS JOIN public.profiles AS p
   WHERE (p_rehearsal_ids IS NULL OR r.id = ANY (p_rehearsal_ids))
     AND public.rehearsal_is_upcoming(r.start_time, r.end_time)
     AND p.status = 'approved'::public."profileStatus"
     AND COALESCE(p.role, 'member'::public."profileRole") = 'member'::public."profileRole"
     AND NOT EXISTS (
           SELECT 1
             FROM public.attendances AS a
            WHERE a.rehearsal_id = r.id
              AND a.user_id = p.id
         );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. RPC 壳：给 web 在打开考勤弹窗 / 导出前调一次（自愈兜底）
-- ---------------------------------------------------------------------------
--
-- 兜底的是触发器覆盖不到的三种情况：① 本 migration 之前就存在的缺口（触发器不会
-- 追溯）；② 触发器被临时禁用 / 被将来的某次改动漏掉；③ 绕过 profiles 与 rehearsals
-- 的写入路径（如管理员在 SQL Editor 里手工建数据）。
CREATE OR REPLACE FUNCTION public.ensure_attendance_roster(p_rehearsal_ids bigint[] DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- 与 guard_profile_privileged_columns 同一条判据：service_role 走 API route / Edge
  -- Function，管理员走带 JWT 的客户端
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'admin required'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.fill_attendance_roster(p_rehearsal_ids);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. 触发器：两个入口共用同一个「全量补」函数
-- ---------------------------------------------------------------------------
--
-- AFTER 触发器：主操作（建排练、批准成员）已经成功，补名单失败会连它一起回滚 ——
-- 这是刻意的：宁可不批准，也不要放一个「批了但名单缺人」的状态过去。
CREATE OR REPLACE FUNCTION public.fill_attendance_roster_on_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.fill_attendance_roster(NULL);
  RETURN NULL;  -- AFTER 触发器的返回值被忽略
END;
$function$;

-- 建排练 / 改时间：发布时立刻把名单补齐（取代 web 端那段 batchInsert）。
-- UPDATE OF start_time, end_time：只有时间被改动时才有必要重算（排练被改到未来 =
-- 这一场重新变成「尚未结束」，本来不该有行的人现在该有了）。
DROP TRIGGER IF EXISTS trigger_fill_attendance_roster_on_rehearsal ON public.rehearsals;
CREATE TRIGGER trigger_fill_attendance_roster_on_rehearsal
  AFTER INSERT OR UPDATE OF start_time, end_time ON public.rehearsals
  FOR EACH ROW
  EXECUTE FUNCTION public.fill_attendance_roster_on_change();

-- 成员被批准：给所有尚未结束的排练补行（本 issue 报的那条路径）。
-- WHEN 把触发器收窄到「这一行（变成）是 approved 的 member」：
-- 管理员改名、改声部等 UPDATE 不会带这两个列，压根不触发；重复批准（已是 approved）
-- 会触发一次，但 fill 幂等，代价是一次反连接。
DROP TRIGGER IF EXISTS trigger_fill_attendance_roster_on_profile ON public.profiles;
CREATE TRIGGER trigger_fill_attendance_roster_on_profile
  AFTER INSERT OR UPDATE OF status, role ON public.profiles
  FOR EACH ROW
  WHEN (
    NEW.status = 'approved'::public."profileStatus"
    AND COALESCE(NEW.role, 'member'::public."profileRole") = 'member'::public."profileRole"
  )
  EXECUTE FUNCTION public.fill_attendance_roster_on_change();

-- ---------------------------------------------------------------------------
-- 5. 权限（与 20260908100000 / 20260928120000 同一条纪律）
-- ---------------------------------------------------------------------------

-- 核心函数：任何客户端角色都不给 EXECUTE。注意 owner（postgres）不受 REVOKE 影响，
-- SECURITY DEFINER 的触发器与 RPC 壳照常能调它。
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fill_attendance_roster(bigint[]) TO service_role;

-- RPC 壳：给带 JWT 的客户端（web 的 admin）
REVOKE EXECUTE ON FUNCTION public.ensure_attendance_roster(bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ensure_attendance_roster(bigint[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_attendance_roster(bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_attendance_roster(bigint[]) TO service_role;

-- 判据函数：纯计算，给客户端调用没有副作用，但仍按最小权限只留给已认证角色
REVOKE EXECUTE ON FUNCTION public.rehearsal_is_upcoming(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rehearsal_is_upcoming(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rehearsal_is_upcoming(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rehearsal_is_upcoming(text, text) TO service_role;

-- 触发器函数：只由触发器调用
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster_on_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fill_attendance_roster_on_change() FROM anon;
GRANT EXECUTE ON FUNCTION public.fill_attendance_roster_on_change() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fill_attendance_roster_on_change() TO service_role;

COMMIT;

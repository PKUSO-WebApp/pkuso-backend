-- ============================================
-- 安全：profiles 的 role / status 两列不许本人自改
-- ============================================
--
-- 起因（pkuso-backend#57）：`profiles` 上唯一的策略是 `ALL`，它的 `WITH CHECK` 只要求
-- 「写的是自己那一行」（`auth.uid() = id OR is_admin()`），**两列都没有护栏**；
-- 表级 GRANT 又是整表 UPDATE（没有按列收权），profiles 上也没有守着这两列的触发器。
-- 于是任何已登录用户一条 PATCH 就能：
--
--   · 把自己改成 `admin`  → `is_admin()` 此后恒真（全部管理端 RLS 与 /api/admin/* 都读它）
--   · 把 `status` 从 `pending` 改成 `approved` → 绕过入团审批
--
-- 依据（**prod 实查**，dev 查同一组的结果与它逐字一致）：
--   · `pg_policies`：策略名 `profiles: 自己读写 + 管理员全部`，cmd = ALL，roles = {public}
--       qual       = (auth.uid() = id) OR is_admin() OR (status = 'approved' AND true)
--       with_check = (auth.uid() = id) OR is_admin()          ← 没有 role / status
--   · `pg_class.relacl`：`authenticated=arwdDxtm`（整表 UPDATE，无列级收权）
--   · `pg_trigger`：profiles 上只有两个触发器，都不碰这两列 ——
--       trigger_delete_storage_on_profile_delete（BEFORE DELETE）
--       trigger_sync_profile_to_auth（AFTER UPDATE，只同步 email/full_name）
--
-- ⚠️ **为什么用触发器，而不是 `REVOKE UPDATE (role, status)` 按列收权**：
--    列级 GRANT 认的是**数据库角色**，而管理员也是 `authenticated` ——
--    收权会把管理员改名一起挡掉，将来「管理员指派 score_manager」的入口只能绕 service_role。
--    触发器能按 `is_admin()` / `auth.role()` 分辨，正是这里需要的粒度。
--
-- ⚠️ **为什么连 INSERT 一起守**（issue 正文只写了 UPDATE）：
--    这两列的列默认值就是 `'member'` / `'pending'`，而 INSERT 的 `WITH CHECK` 同样只要求
--    `auth.uid() = id` —— 一个 profile 行被删掉（管理员删人）的用户，可以用自己的 JWT
--    重新 INSERT 一行 `role = 'admin'`。同一把锁上少装一道门闩没有意义。
--
--    ⚠️ 但 INSERT 分支的判错代价更高，所以逐条核对过**所有**写入路径（下面这条尤其要看）：
--      · `handle_new_user()` **显式**写 `'pending'` / `'member'`（dev 实查函数体）→ 落在放行值上；
--      · 小程序与 web 的 `useProfiles.insert` 用的 `ProfileInsert` **不含**这两列（吃默认值）；
--      · 其余写 profiles 的路径（`/api/admin/import-member-info`、`approve|reject` 系）走
--        service_role → 第一个分支直接放行；Edge Functions 里没有任何 profiles INSERT。
--    ⚠️ **`handle_new_user()` 把 INSERT 包在 `EXCEPTION WHEN OTHERS` 里，失败只留一条 NOTICE** ——
--       也就是说：如果哪天有人往 profiles 里插一行**非 member/pending** 的记录，症状不是报错，
--       而是**静默少一行 profile**（用户卡在守卫页）。改这个函数时务必保住它显式写的那两个值。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS guard_profile_privileged_columns ON public.profiles;
--   DROP FUNCTION IF EXISTS public.guard_profile_privileged_columns();

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- service_role 走的是 API route / Edge Function / CI，它们本来就有权写这两列
  -- （与 guard_leave_request_after_sign_in 等既有守卫同一条判据）
  IF auth.role() = 'service_role' OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'member'::public."profileRole"
       OR NEW.status IS DISTINCT FROM 'pending'::public."profileStatus" THEN
      RAISE EXCEPTION 'cannot self-assign profile.role or profile.status on insert'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'cannot modify profile.role'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'cannot modify profile.status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER guard_profile_privileged_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_privileged_columns();

-- 与既有四个触发器函数同一条纪律（见 `20260908100000` / `20260908103000`：
-- 触发器函数只由触发器调用，不需要给客户端 EXECUTE）
REVOKE EXECUTE ON FUNCTION public.guard_profile_privileged_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_profile_privileged_columns() FROM anon;
GRANT EXECUTE ON FUNCTION public.guard_profile_privileged_columns() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_profile_privileged_columns() TO service_role;

COMMIT;

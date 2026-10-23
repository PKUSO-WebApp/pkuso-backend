-- ============================================
-- 角色 flags 强制重算 + profiles_roster 追加 is_principal（P0b-2）
-- ============================================
--
-- ## 为什么要这个触发器
--
-- `profiles.is_section_leader` 原先是一个**任何团员都能自改**的 boolean：
--   · `guard_profile_privileged_columns` 只守 role/status 两列；
--   · authenticated 的表级 UPDATE 授权覆盖全列。
-- 一旦声部长/首席获得任何权限，它就是现成的提权路径。
--
-- 本迁移不把该列加进守卫黑名单（黑名单会漏），而是**强制重算**：
-- BEFORE INSERT OR UPDATE 时 `NEW.is_section_leader := EXISTS(section_leaders …)`、
-- `NEW.is_principal := EXISTS(instrument_principals …)`。客户端传什么值都不算数，
-- 但 web/mp 的读取路径一行不用改。
--
-- ## 反向同步
--
-- 角色表变化后 touch 对应的 profile 行（`SET is_section_leader = is_section_leader`），
-- 让上面的 BEFORE 触发器重算。`sync_profile_to_auth` 只在 email/full_name 变化时写 auth，
-- 所以这个 touch 不会产生 auth 调用。
--
-- ## 回填
--
-- `UPDATE profiles SET is_section_leader = is_section_leader` 让 BEFORE 触发器对全表重算一次。
-- 角色表此刻为空 ⇒ 所有 flag 归 false。**dev/prod 当前 is_section_leader=true 都是 0**，
-- 不会误伤任何人；以后由管理员通过 admin RPC 重新任命。
--
-- ## 视图
--
-- `profiles_roster` 末尾追加 `is_principal`，列序/owner/WHERE 保持现状；仍保持现有的
-- SECURITY DEFINER 语义（不在本次改安全模型）。ACL 重新授予 SELECT，避免 CREATE OR REPLACE
-- 后默认权限变化影响 web 的读取。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS profiles_sync_leadership_flags ON public.profiles;
--   DROP TRIGGER IF EXISTS section_leaders_sync_flags ON public.section_leaders;
--   DROP TRIGGER IF EXISTS instrument_principals_sync_flags ON public.instrument_principals;
--   DROP FUNCTION IF EXISTS public.sync_profile_leadership_flags();
--   DROP FUNCTION IF EXISTS public.sync_section_leader_flags();
--   DROP FUNCTION IF EXISTS public.sync_principal_flags();
--   -- is_principal / 视图列是否回滚由后续决定（本迁移不自动删列）。

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_principal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.is_principal IS
  '由 instrument_principals 触发器强制重算，客户端不可手改。';

-- ---------------------------------------------------------------------------
-- profiles：写入时重算 flags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_profile_leadership_flags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  NEW.is_section_leader := EXISTS (
    SELECT 1 FROM public.section_leaders WHERE leader_id = NEW.id
  );
  NEW.is_principal := EXISTS (
    SELECT 1 FROM public.instrument_principals WHERE principal_id = NEW.id
  );
  RETURN NEW;
END
$function$;

CREATE TRIGGER profiles_sync_leadership_flags
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_leadership_flags();

-- ---------------------------------------------------------------------------
-- section_leaders：反向 touch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_section_leader_flags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.profiles
       SET is_section_leader = is_section_leader
     WHERE id = OLD.leader_id;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.profiles
       SET is_section_leader = is_section_leader
     WHERE id = NEW.leader_id;
    IF OLD.leader_id IS DISTINCT FROM NEW.leader_id THEN
      UPDATE public.profiles
         SET is_section_leader = is_section_leader
       WHERE id = OLD.leader_id;
    END IF;
    RETURN NEW;
  ELSE
    UPDATE public.profiles
       SET is_section_leader = is_section_leader
     WHERE id = NEW.leader_id;
    RETURN NEW;
  END IF;
END
$function$;

CREATE TRIGGER section_leaders_sync_flags
  AFTER INSERT OR UPDATE OR DELETE ON public.section_leaders
  FOR EACH ROW EXECUTE FUNCTION public.sync_section_leader_flags();

-- ---------------------------------------------------------------------------
-- instrument_principals：反向 touch（同构）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_principal_flags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.profiles
       SET is_principal = is_principal
     WHERE id = OLD.principal_id;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.profiles
       SET is_principal = is_principal
     WHERE id = NEW.principal_id;
    IF OLD.principal_id IS DISTINCT FROM NEW.principal_id THEN
      UPDATE public.profiles
         SET is_principal = is_principal
       WHERE id = OLD.principal_id;
    END IF;
    RETURN NEW;
  ELSE
    UPDATE public.profiles
       SET is_principal = is_principal
     WHERE id = NEW.principal_id;
    RETURN NEW;
  END IF;
END
$function$;

CREATE TRIGGER instrument_principals_sync_flags
  AFTER INSERT OR UPDATE OR DELETE ON public.instrument_principals
  FOR EACH ROW EXECUTE FUNCTION public.sync_principal_flags();

-- ---------------------------------------------------------------------------
-- 回填：全表重算一次
-- ---------------------------------------------------------------------------
UPDATE public.profiles
   SET is_section_leader = is_section_leader;

-- ---------------------------------------------------------------------------
-- profiles_roster：末尾追加 is_principal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.profiles_roster AS
SELECT
  id,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_email
      THEN email
    ELSE NULL::text
  END AS email,
  full_name,
  instrument,
  status,
  role,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_college
      THEN college
    ELSE NULL::text
  END AS college,
  CASE
    WHEN ((SELECT auth.uid()) = id) OR (SELECT public.is_admin()) OR NOT hide_phone
      THEN phone_number
    ELSE NULL::text
  END AS phone_number,
  join_date,
  created_at,
  is_section_leader,
  hide_email,
  hide_phone,
  hide_join_date,
  hide_college,
  is_in_orchestra,
  avatar_url,
  is_principal
FROM public.profiles
WHERE status = 'approved'::public."profileStatus"
   OR (SELECT auth.uid()) = id
   OR (SELECT public.is_admin());

GRANT SELECT ON public.profiles_roster TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 触发器函数的 EXECUTE 权限（与 guard_profile_privileged_columns 同一条纪律）
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.sync_profile_leadership_flags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_profile_leadership_flags() FROM anon;
GRANT EXECUTE ON FUNCTION public.sync_profile_leadership_flags() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_profile_leadership_flags() TO service_role;

REVOKE EXECUTE ON FUNCTION public.sync_section_leader_flags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_section_leader_flags() FROM anon;
GRANT EXECUTE ON FUNCTION public.sync_section_leader_flags() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_section_leader_flags() TO service_role;

REVOKE EXECUTE ON FUNCTION public.sync_principal_flags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_principal_flags() FROM anon;
GRANT EXECUTE ON FUNCTION public.sync_principal_flags() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_principal_flags() TO service_role;

COMMIT;

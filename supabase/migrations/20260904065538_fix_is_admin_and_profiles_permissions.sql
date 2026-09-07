-- 1. 确保所有角色都能 EXECUTE is_admin（RLS 策略中调用需要）
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

-- 2. 确保 profiles_roster 视图有正确的权限
GRANT SELECT ON public.profiles_roster TO anon;
GRANT SELECT ON public.profiles_roster TO authenticated;
GRANT SELECT ON public.profiles_roster TO service_role;

-- 3. 确保 profiles 表有 SELECT 权限（SECURITY INVOKER 视图需要）
GRANT SELECT ON public.profiles TO anon;
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT ON public.profiles TO service_role;

-- 4. 验证所有相关函数的权限
DO $$
DECLARE
  func_name text;
  func_grants record;
BEGIN
  FOR func_name IN SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND p.proname IN ('is_admin', 'check_data_versions', 'get_my_profile_entry', 'get_my_session', 'touch_session', 'sign_in_attendance_location', 'cancel_leave_on_sign_in')
  LOOP
    RAISE NOTICE 'Function %: %', func_name, (SELECT proacl FROM pg_proc WHERE proname = func_name AND pronamespace = 'public'::regnamespace);
  END LOOP;
END $$;

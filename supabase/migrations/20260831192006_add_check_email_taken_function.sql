-- 检查邮箱是否已被其他用户占用（查 auth.users 表）
CREATE OR REPLACE FUNCTION public.check_email_taken(p_email text, p_exclude_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE lower(email) = lower(p_email)
      AND id != p_exclude_user_id
  );
$$;

-- 允许 authenticated 角色调用
GRANT EXECUTE ON FUNCTION public.check_email_taken(text, uuid) TO authenticated;

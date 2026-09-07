-- 更新触发器：删除 profile 时同时删除 auth.users 行
CREATE OR REPLACE FUNCTION public.sync_profile_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- DELETE：级联删除 auth.users
  IF TG_OP = 'DELETE' THEN
    DELETE FROM auth.users WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  -- UPDATE：同步 email + full_name
  -- 同步 email（仅当 profiles.email 是有效邮箱时）
  IF NEW.email IS NOT NULL
     AND NEW.email != ''
     AND NEW.email LIKE '%@%'
     AND NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE auth.users
    SET email = NEW.email,
        email_confirmed_at = NOW(),
        raw_user_meta_data = jsonb_set(
          jsonb_set(
            COALESCE(raw_user_meta_data, '{}'::jsonb),
            '{email}',
            to_jsonb(NEW.email)
          ),
          '{email_verified}',
          'true'
        )
    WHERE id = NEW.id;
  END IF;

  -- 同步 full_name
  IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN
    IF NEW.full_name IS NOT NULL AND NEW.full_name != '' THEN
      UPDATE auth.users
      SET raw_user_meta_data = jsonb_set(
            COALESCE(raw_user_meta_data, '{}'::jsonb),
            '{full_name}',
            to_jsonb(NEW.full_name)
          )
      WHERE id = NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 触发器改为 BEFORE DELETE（因为需要返回 OLD，且在 CASCADE 之前执行）
DROP TRIGGER IF EXISTS trigger_sync_profile_to_auth ON profiles;
CREATE TRIGGER trigger_sync_profile_to_auth
  BEFORE DELETE OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_profile_to_auth();

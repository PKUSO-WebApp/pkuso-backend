-- 1. 恢复触发器：去掉 DELETE 逻辑（只保留 UPDATE 同步）
CREATE OR REPLACE FUNCTION public.sync_profile_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

-- 2. 触发器改回 AFTER UPDATE（不需要 BEFORE DELETE 了）
DROP TRIGGER IF EXISTS trigger_sync_profile_to_auth ON profiles;
CREATE TRIGGER trigger_sync_profile_to_auth
  AFTER UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_profile_to_auth();

-- 3. 删除 profiles → auth.users 的外键（profiles.id = auth.users.id 本身已保证一致性）
ALTER TABLE profiles DROP CONSTRAINT profiles_id_fkey;

-- 4. 改为 auth.users DELETE 时级联删 profiles（方向反向：删 auth → 删 profile）
--    这样删除 profile 时：profiles DELETE → CASCADE 删 schedules/posts → profiles 行删除
--    如果要从 auth.users 删除：auth.users DELETE → CASCADE 删 profiles → profiles 上的 CASCADE 删子表
ALTER TABLE profiles
  ADD CONSTRAINT profiles_id_auth_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 一次性同步：profiles → auth.users（email + full_name）
-- 此后由触发器自动保持同步

-- 1. 同步 email（仅处理 profiles 有真实邮箱且与 auth 不一致的情况）
--    同时设置 email_confirmed_at，使同步后的邮箱自动 confirmed
UPDATE auth.users au
SET email = p.email,
    email_confirmed_at = NOW(),
    raw_user_meta_data = jsonb_set(
      jsonb_set(
        COALESCE(au.raw_user_meta_data, '{}'::jsonb),
        '{email}',
        to_jsonb(p.email)
      ),
      '{email_verified}',
      'true'
    )
FROM profiles p
WHERE au.id = p.id
  AND p.email IS NOT NULL
  AND p.email != ''
  AND p.email LIKE '%@%'
  AND p.email != au.email;

-- 2. 同步 full_name（仅处理 profiles 有名字且与 auth 不一致的情况）
UPDATE auth.users au
SET raw_user_meta_data = jsonb_set(
      COALESCE(au.raw_user_meta_data, '{}'::jsonb),
      '{full_name}',
      to_jsonb(p.full_name)
    )
FROM profiles p
WHERE au.id = p.id
  AND p.full_name IS NOT NULL
  AND p.full_name != ''
  AND (au.raw_user_meta_data->>'full_name') IS DISTINCT FROM p.full_name;

-- 3. 创建触发器函数：profiles 更新时自动同步 auth.users
--    email 同步时自动设置 email_confirmed_at + email_verified
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

-- 4. 挂载触发器
CREATE TRIGGER trigger_sync_profile_to_auth
  AFTER UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_profile_to_auth();

-- 5. 授予触发器函数执行权限（SECURITY DEFINER 已提权，但显式声明更清晰）
GRANT EXECUTE ON FUNCTION public.sync_profile_to_auth() TO authenticated;

-- 6. 删除 profiles → auth.users 的旧外键，改为 ON DELETE CASCADE
--    删除 auth.users 行时自动级联删除 profiles 及其所有子表
ALTER TABLE profiles DROP CONSTRAINT profiles_id_fkey;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_id_auth_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 7. 子表外键改为 ON DELETE CASCADE（删 profile 时级联删除关联数据）
ALTER TABLE schedules
  DROP CONSTRAINT schedules_author_id_fkey,
  ADD CONSTRAINT schedules_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE schedule_groups
  DROP CONSTRAINT schedule_groups_author_id_fkey,
  ADD CONSTRAINT schedule_groups_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- 更新触发器函数：同步 email 时自动确认
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

-- 同步一次性迁移中已同步的 email：补上 confirmed 状态
UPDATE auth.users
SET email_confirmed_at = NOW(),
    raw_user_meta_data = jsonb_set(
      COALESCE(raw_user_meta_data, '{}'::jsonb),
      '{email_verified}',
      'true'
    )
WHERE email LIKE '%@%'
  AND email NOT LIKE '%@placeholder.local%'
  AND email_confirmed_at IS NULL;

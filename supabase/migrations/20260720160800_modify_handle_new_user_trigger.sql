-- 迁移说明：修改 handle_new_user 触发器函数，修复以下问题：
-- 1. 添加异常处理（try-catch），INSERT 失败时记录错误但不阻止用户注册
-- 2. 使用 INSERT ... ON CONFLICT DO NOTHING 避免主键冲突
-- 3. 使用 COALESCE 为关键字段提供默认值
-- 回滚说明：DROP FUNCTION public.handle_new_user()，然后重新创建不含异常处理、ON CONFLICT 和 COALESCE 的原始版本

BEGIN;

-- 先删除所有依赖于 handle_new_user 函数的触发器
DROP TRIGGER IF EXISTS handle_new_user ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- 再删除函数
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 创建新的触发器函数，从 raw_user_meta_data 读取用户信息
-- 修复内容：
-- 1. 添加异常处理，INSERT 失败时记录错误但不阻止用户注册
-- 2. 使用 INSERT ... ON CONFLICT DO NOTHING 避免主键冲突
-- 3. 使用 COALESCE 为关键字段提供默认值
CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    INSERT INTO public.profiles (
      id,
      email,
      full_name,
      instrument,
      college,
      join_date,
      status,
      role,
      created_at
    )
    VALUES (
      NEW.id,
      COALESCE(NEW.email, ''),
      COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
      COALESCE(NEW.raw_user_meta_data->>'instrument', ''),
      COALESCE(NEW.raw_user_meta_data->>'college', ''),
      COALESCE(NEW.raw_user_meta_data->>'join_date', NOW()::DATE),
      'pending'::profileStatus,
      'member'::profileRole,
      NOW()
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION
    WHEN OTHERS THEN
      -- 记录错误但不阻止用户注册
      RAISE NOTICE 'handle_new_user: Failed to insert profile for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 重建触发器
CREATE TRIGGER handle_new_user
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMIT;

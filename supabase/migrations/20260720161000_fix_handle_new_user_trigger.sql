-- 迁移说明：修复 handle_new_user 触发器函数导致的 500 错误
-- 问题分析：
-- 1. COALESCE(NEW.raw_user_meta_data->>'join_date', NOW()::DATE) 类型不一致
--    ->> 操作符返回 text，NOW()::DATE 返回 date，COALESCE 要求所有参数类型一致
-- 2. 触发器函数中未显式设置 search_path，可能导致枚举类型解析失败
-- 修复内容：
-- 1. 将 NOW()::DATE 改为 CURRENT_DATE::TEXT，确保 COALESCE 参数类型一致
-- 2. 在函数开头设置 search_path，确保枚举类型正确解析
-- 3. 对 join_date 列进行显式类型转换，确保插入 profiles 表时类型正确
-- 回滚说明：DROP FUNCTION public.handle_new_user()，然后重新创建包含 NOW()::DATE 的版本

BEGIN;

-- 先删除所有依赖于 handle_new_user 函数的触发器
DROP TRIGGER IF EXISTS handle_new_user ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- 再删除函数
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 创建修复后的触发器函数
CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- 设置 search_path，确保枚举类型正确解析
  SET search_path = public, auth;
  
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
      -- 修复：将 NOW()::DATE 改为 CURRENT_DATE::TEXT，确保 COALESCE 参数类型一致
      -- 然后进行显式类型转换为 DATE
      COALESCE(NEW.raw_user_meta_data->>'join_date', CURRENT_DATE::TEXT)::DATE,
      -- 修复：枚举类型使用双引号包裹，确保正确解析
      'pending'::"profileStatus",
      'member'::"profileRole",
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

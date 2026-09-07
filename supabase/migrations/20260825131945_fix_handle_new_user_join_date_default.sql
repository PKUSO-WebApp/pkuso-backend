-- 入团时间治理②：注册建档默认值由「当天日期」改为「当前学期」（上半年=春，下半年=秋）；
-- 元数据自带 join_date 时仅在已符合「YYYY春/YYYY秋」格式时采用。
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
      CASE
        -- 仅当元数据自带且已符合「YYYY春/秋」学期格式时采用；否则按当前日期推导学期默认值
        WHEN NEW.raw_user_meta_data->>'join_date' ~ '^\d{4}(春|秋)$'
          THEN NEW.raw_user_meta_data->>'join_date'
        ELSE to_char(CURRENT_DATE, 'YYYY')
             || CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) <= 6 THEN '春' ELSE '秋' END
      END,
      -- 枚举类型使用双引号包裹，确保正确解析
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
$function$;

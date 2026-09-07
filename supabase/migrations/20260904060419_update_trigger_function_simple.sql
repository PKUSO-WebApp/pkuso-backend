
-- 使用更简单的方式：直接调用 Edge Function，不依赖 app.settings
CREATE OR REPLACE FUNCTION function_delete_storage_on_row_delete()
RETURNS TRIGGER AS $$
DECLARE
  bucket_name TEXT;
  file_path TEXT;
  image_url TEXT;
BEGIN
  -- 根据表名确定 bucket 和路径字段
  CASE TG_TABLE_NAME
    WHEN 'posts' THEN
      bucket_name := 'community-images';
      image_url := OLD.image_url;
    WHEN 'profiles' THEN
      bucket_name := 'avatar_images';
      image_url := OLD.avatar_url;
    WHEN 'leave_requests' THEN
      bucket_name := 'leave-attachments';
      image_url := OLD.attachment_url;
    ELSE
      RETURN OLD;
  END CASE;
  
  -- 如果没有图片 URL，直接返回
  IF image_url IS NULL OR image_url = '' THEN
    RETURN OLD;
  END IF;
  
  -- 从 URL 提取文件路径
  -- URL 格式: https://xxx.supabase.co/storage/v1/object/public/bucket/path/to/file
  file_path := regexp_replace(image_url, '^.*/storage/v1/object/public/' || bucket_name || '/', '');
  
  -- 如果提取失败（路径等于原 URL），直接返回
  IF file_path IS NULL OR file_path = image_url THEN
    RETURN OLD;
  END IF;
  
  -- 调用 Edge Function 删除文件（异步，使用 service_role key 认证）
  -- 注意：这里需要配置 Supabase Service Role Key
  -- 由于无法直接设置 app.settings，我们使用一个临时方案：
  -- 在 Edge Function 中通过环境变量获取 key
  BEGIN
    PERFORM net.http_post(
      url := 'https://xkrszbmmdaorivkatvwh.supabase.co/functions/v1/delete-storage-file',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'bucket', bucket_name,
        'paths', ARRAY[file_path]
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- 记录错误但不阻止删除操作
    RAISE WARNING 'Failed to delete storage file: %', SQLERRM;
  END;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

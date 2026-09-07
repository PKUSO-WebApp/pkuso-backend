
CREATE OR REPLACE FUNCTION function_delete_storage_on_row_delete()
RETURNS TRIGGER AS $$
DECLARE
  bucket_name TEXT;
  file_path TEXT;
  supabase_url TEXT;
  service_role_key TEXT;
BEGIN
  -- 根据表名确定 bucket 和路径字段
  CASE TG_TABLE_NAME
    WHEN 'posts' THEN
      bucket_name := 'community-images';
      -- 从 image_url 提取路径
      -- URL 格式: https://xxx.supabase.co/storage/v1/object/public/community-images/path/to/file
      file_path := regexp_replace(OLD.image_url, '^.*/storage/v1/object/public/community-images/', '');
    WHEN 'profiles' THEN
      bucket_name := 'avatar_images';
      file_path := regexp_replace(OLD.avatar_url, '^.*/storage/v1/object/public/avatar_images/', '');
    WHEN 'leave_requests' THEN
      bucket_name := 'leave-attachments';
      file_path := regexp_replace(OLD.attachment_url, '^.*/storage/v1/object/public/leave-attachments/', '');
    ELSE
      RETURN OLD;
  END CASE;
  
  -- 如果没有文件路径，直接返回
  IF file_path IS NULL OR file_path = '' OR file_path = OLD.image_url OR file_path = OLD.avatar_url OR file_path = OLD.attachment_url THEN
    RETURN OLD;
  END IF;
  
  -- 获取配置（从 postgres 的 custom settings）
  BEGIN
    supabase_url := current_setting('app.settings.supabase_url');
    service_role_key := current_setting('app.settings.service_role_key');
  EXCEPTION WHEN OTHERS THEN
    -- 如果配置不存在，记录日志并返回
    RAISE WARNING 'app.settings not configured for storage deletion';
    RETURN OLD;
  END;
  
  -- 调用 Edge Function 删除文件（异步）
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/delete-storage-file',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_role_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'bucket', bucket_name,
      'paths', ARRAY[file_path]
    )
  );
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;


-- 创建一个函数用于上传测试图片
CREATE OR REPLACE FUNCTION upload_test_image()
RETURNS void AS $$
DECLARE
  test_image_bytes BYTEA;
  response jsonb;
BEGIN
  -- 创建一个简单的 1x1 PNG 图片（base64 解码）
  test_image_bytes := decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  
  -- 使用 net.http_post 上传到 Storage
  -- 注意：Storage API 需要 multipart/form-data，这比较复杂
  -- 让我们使用一个更简单的方法：直接创建一个记录
  
  -- 实际上，我们可以跳过上传步骤，直接测试删除逻辑
  -- 因为我们的目标是验证触发器和 Edge Function 的调用
  
  RAISE NOTICE 'Test image upload skipped - testing trigger logic only';
END;
$$ LANGUAGE plpgsql;

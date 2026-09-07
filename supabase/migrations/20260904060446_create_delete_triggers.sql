
-- 创建 DELETE 触发器

-- posts 表
CREATE TRIGGER trigger_delete_storage_on_post_delete
  BEFORE DELETE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION function_delete_storage_on_row_delete();

-- profiles 表
CREATE TRIGGER trigger_delete_storage_on_profile_delete
  BEFORE DELETE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION function_delete_storage_on_row_delete();

-- leave_requests 表
CREATE TRIGGER trigger_delete_storage_on_leave_request_delete
  BEFORE DELETE ON leave_requests
  FOR EACH ROW
  EXECUTE FUNCTION function_delete_storage_on_row_delete();

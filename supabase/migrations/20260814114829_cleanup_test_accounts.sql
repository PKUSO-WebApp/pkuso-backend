-- 数据清理：删除全部测试账号（Issue 无，用户直接指令）
-- 保留：dddamienw@gmail.com、pkusorchestra@163.com
-- 业务数据（app_settings/rehearsals/attendances/schedules）保留不动
-- 先删 profiles（FK 指向 auth.users），再删 auth.users
-- 幂等性：DELETE 语句天然幂等，重复执行无副作用
-- 回滚方案：不可行（数据删除不可恢复），执行前需备份

BEGIN;

-- ==================== 1. 删除测试 profiles（FK 指向 auth.users，先删） ====================
DELETE FROM profiles
WHERE email NOT IN ('dddamienw@gmail.com', 'pkusorchestra@163.com');

-- ==================== 2. 删除测试 auth.users（含 1 个无 profile 的测试账号） ====================
DELETE FROM auth.users
WHERE email NOT IN ('dddamienw@gmail.com', 'pkusorchestra@163.com');

COMMIT;

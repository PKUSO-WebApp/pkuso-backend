-- 迁移说明：数据清理，删除全部测试账号（Issue 无，用户直接指令）。
--
-- 背景：
--   生产库积累了大量测试账号（@pkuso.test 域名的 inv-* / settings-admin-* /
--   settings-member-*，共 42 个 profile / 43 个 auth user），需要一次性清理，
--   仅保留两个真实账号：dddamienw@gmail.com、pkusorchestra@163.com。
--
-- 删除范围与顺序：
--   1. 先删 profiles：profiles.id 有 FK 指向 auth.users(id)，必须先删子表行。
--   2. 再删 auth.users：auth.identities / auth.sessions / auth.mfa_factors 等
--      auth 内部子表均 ON DELETE CASCADE，随用户删除自动清理。
--
-- 保留数据（不动）：
--   - app_settings（邮件签名等全局设置，与账号无关）
--   - rehearsals / attendances / schedules / schedule_groups / posts
--   - 已核实：attendances.user_id 仅引用保留账号 fe2db172；
--     schedules.author_id 为 null；posts / schedule_groups / invitation_codes 空表。
--     无其他表引用测试账号（FK 检查：引用 profiles / auth.users 的外键均
--     指向保留账号或为 CASCADE / 空表）。
--
-- 幂等性：DELETE 语句天然幂等，重复执行无副作用（第二次无行可删）。
--
-- 回滚方案：不可行（数据删除不可恢复）。如需恢复需从备份还原对应行，
--   建议执行前已做备份。

BEGIN;

-- ==================== 1. 删除测试 profiles（FK 指向 auth.users，先删） ====================
DELETE FROM profiles
WHERE email NOT IN ('dddamienw@gmail.com', 'pkusorchestra@163.com');

-- ==================== 2. 删除测试 auth.users（含 1 个无 profile 的测试账号） ====================
DELETE FROM auth.users
WHERE email NOT IN ('dddamienw@gmail.com', 'pkusorchestra@163.com');

COMMIT;

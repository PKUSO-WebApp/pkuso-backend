-- ============================================
-- 通知分类：新增 section_leave（声部请假）
-- ============================================
--
-- 背景：声部长/首席的「声部请假」入口需要与其他通知一致的未读徽章。
-- 现有通知按 `notificationCategory` 分三类（attendance / activity / system），
-- 徽章 = 该分类下 read_at IS NULL 的行数，打开信箱时整类标记已读。
--
-- 因此声部请假必须有自己的分类：复用 attendance 会把它算进「考勤与请假」的
-- 徽章，且打开声部请假页会把成员的考勤通知一并标已读。
--
-- ⚠️ 本文件**只加 enum 值**。PostgreSQL 不允许在同一事务里使用刚 ADD 的 enum
-- 值，所以触发器写在下一个 migration（20261023150100）里。
--
-- 回滚：enum 值无法安全删除（PostgreSQL 不支持 DROP VALUE），如确需回滚，
-- 先删除触发器和通知行，再重建 enum 类型。

BEGIN;

ALTER TYPE public."notificationCategory" ADD VALUE IF NOT EXISTS 'section_leave';

COMMIT;

-- ============================================
-- 考勤：新增出勤状态 exempt（无需出勤）
-- ============================================
--
-- attendanceStatus 现有四值：present / late / absent / excused。
-- 新增 exempt「无需出勤」——由管理员在考勤弹窗手动设置，用于长期免出勤的成员
-- （如已毕业 / 保留团籍）。成员端只读展示，不参与签到与请假交互。
--
-- 注意事项：
--   · 枚举值一旦加进库就无法删除/改名（PostgreSQL 枚举的固有限制），前端
--     硬编码字符串跟着走——这是跨三仓库的契约。
--   · 引用该枚举的函数（sign_in_attendance_location / guard_leave_request_*）
--     只赋值 present/late/excused，不枚举全部值，无需改动。
--   · ALTER TYPE ... ADD VALUE 在 PG 12+ 可在事务内执行；限制是新值不能在同一
--     事务内使用——本迁移只加值，无此问题。
--
-- 回滚：枚举值无法删除，如需回滚只能重建类型并迁移列数据（不建议）。

BEGIN;

ALTER TYPE "attendanceStatus" ADD VALUE 'exempt';

COMMIT;

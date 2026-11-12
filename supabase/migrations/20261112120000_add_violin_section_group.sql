-- ============================================
-- 声部长作用域新增「小提琴」组（2026-11-12）
-- ============================================
--
-- 背景：乐团实际只有一位小提琴声部长，需要同时管理「第一小提琴」和
-- 「第二小提琴」两个声部。原字典里五个弦乐声部各自独立可任命，而
-- 「弦乐」组 can_lead=false，无法表达「一位部长管两支小提琴」。
--
-- 设计：复用既有的「组作用域」机制（木管/铜管同款），新增 kind='group' 的
-- 「小提琴」组，成员为第一小提琴、第二小提琴。
--   · `admin_set_section_leader` 对组作用域的候选人判据是「instrument 属于
--     组内任一乐器」，所以 instrument=第一小提琴 的成员可以任该组部长；
--   · 所有权限判据（考勤、请假、共享谱、默认分声部、请假通知）都经
--     `led_sections()` / `section_group_members` 展开，不需要改任何函数；
--   · 组与组内乐器互斥：任命「小提琴」组之前必须撤销第一/第二小提琴的
--     既有任命，否则 `admin_set_section_leader` 会以 scope_overlap 拒绝。
--
-- 本迁移只写字典数据：不改表结构、不碰既有任命、不影响首席（instrument_principals）。
-- `sort_order=205` 位于「弦乐」(200) 与「木管」(210) 之间，当前空闲。
--
-- 回滚：
--   DELETE FROM public.section_group_members WHERE group_name = '小提琴';
--   DELETE FROM public.sections WHERE name = '小提琴';

BEGIN;

INSERT INTO public.sections (name, kind, sort_order, can_lead, can_principal) VALUES
  ('小提琴', 'group', 205, true, false);

INSERT INTO public.section_group_members (group_name, member_name, sort_order) VALUES
  ('小提琴', '第一小提琴', 10),
  ('小提琴', '第二小提琴', 20);

COMMIT;

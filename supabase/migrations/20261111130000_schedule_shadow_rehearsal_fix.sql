-- ============================================
-- 排练影子预约：跟随排练删除 + 团长可删任意预约
-- ============================================
--
-- 背景（2026-11-11 用户报告）：
--   `function_rehearsal_to_schedule` 会在排练创建/更新后往 schedules 写一条
--   `author_id = NULL, rehearsal_id = <id>, title = '排练'` 的「影子预约」。
--   但 schedules.rehearsal_id 的外键是 ON DELETE SET NULL —— 删除排练后影子预约
--   会留下来，变成 author_id/rehearsal_id 都为 NULL 的孤儿预约。
--   mp 的冲突检查（useSchedule.checkConflict）把 `rehearsal_id IS NULL` 当成人工预约，
--   于是新建排练时会跟这条孤儿「自己」冲突。
--
-- 本迁移：
--   1. 清掉历史孤儿影子预约（null author + null rehearsal + title '排练'）；
--   2. 把外键改成 ON DELETE CASCADE：以后删排练自动删影子预约；
--   3. 加一条 RLS：团长（has_capability('rehearsal')）可以删除任何人的**人工预约**。
--      影子预约的删除入口在 UI 里会被引导到排练详情页（那里删除排练，连带删影子），
--      但 RLS 层面仍允许团长删除任意 schedules 行；这是产品允许的权限。
--
-- 回滚：
--   DELETE FROM pg_policies WHERE policyname = 'schedules: 团长可删除';
--   ALTER TABLE public.schedules DROP CONSTRAINT schedules_rehearsal_id_fkey;
--   ALTER TABLE public.schedules ADD CONSTRAINT schedules_rehearsal_id_fkey
--     FOREIGN KEY (rehearsal_id) REFERENCES public.rehearsals(id) ON DELETE SET NULL;
--   （孤儿数据已删除，回滚不会恢复）

BEGIN;

-- 1. 历史孤儿影子预约。只清 author_id 与 rehearsal_id 都为空、且标题是触发器固定写的
--    '排练' 的行，避免误删「作者账号被删 → author_id SET NULL」的人工预约。
DELETE FROM public.schedules
WHERE rehearsal_id IS NULL
  AND author_id IS NULL
  AND title = '排练';

-- 2. 删除排练时连带删除影子预约
ALTER TABLE public.schedules
  DROP CONSTRAINT schedules_rehearsal_id_fkey;

ALTER TABLE public.schedules
  ADD CONSTRAINT schedules_rehearsal_id_fkey
  FOREIGN KEY (rehearsal_id) REFERENCES public.rehearsals(id) ON DELETE CASCADE;

-- 3. 团长（rehearsal 能力）可删除任意人的预约
DROP POLICY IF EXISTS "schedules: 团长可删除" ON public.schedules;
CREATE POLICY "schedules: 团长可删除"
  ON public.schedules
  FOR DELETE TO authenticated
  USING (public.has_capability('rehearsal'));

COMMIT;

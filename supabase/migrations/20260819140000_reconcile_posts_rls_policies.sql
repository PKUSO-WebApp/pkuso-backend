-- Issue #206：posts 表 RLS 策略沉淀入库
--
-- 背景：posts 四条 RLS 策略为 dashboard 手工创建、不在仓库 migration 中，
-- db reset / 重建本地库会丢失，导致本地与远端行为不一致、CI 潜在误判。
-- 本 migration 按远端 pg_policies 原文幂等重放（DROP POLICY IF EXISTS +
-- CREATE POLICY 同定义），不改变任何行为。
--
-- 策略清单（远端实测原文）：
--   1. posts: 所有人可读       SELECT   TO authenticated  true
--   2. posts: 所有人可插入     INSERT   TO authenticated  WITH CHECK (auth.uid() = author_id)
--   3. posts: 作者或管理员可更新 UPDATE  TO public  USING (作者 OR profiles.role='admin')
--   4. posts: 作者或管理员可删除 DELETE  TO public  USING (同上)
--
-- 顺带记录（Issue #205 验证）：UPDATE/DELETE 策略无 is_locked 检查——锁定帖
-- 作者仍可编辑内容/删除（不可改 is_locked，由 20260819120000 触发器强制），
-- 语义暂可接受；若未来要求「锁定即只读」需另议。

BEGIN;

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "posts: 所有人可读" ON public.posts;
CREATE POLICY "posts: 所有人可读" ON public.posts
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "posts: 所有人可插入" ON public.posts;
CREATE POLICY "posts: 所有人可插入" ON public.posts
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS "posts: 作者或管理员可更新" ON public.posts;
CREATE POLICY "posts: 作者或管理员可更新" ON public.posts
  FOR UPDATE TO public
  USING (
    (auth.uid() = author_id)
    OR EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'::"profileRole"
    )
  );

DROP POLICY IF EXISTS "posts: 作者或管理员可删除" ON public.posts;
CREATE POLICY "posts: 作者或管理员可删除" ON public.posts
  FOR DELETE TO public
  USING (
    (auth.uid() = author_id)
    OR EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'::"profileRole"
    )
  );

COMMIT;

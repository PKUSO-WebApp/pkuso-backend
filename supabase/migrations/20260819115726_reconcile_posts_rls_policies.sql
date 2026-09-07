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

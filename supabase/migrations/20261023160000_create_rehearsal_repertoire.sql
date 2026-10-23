-- ============================================
-- 排练曲目映射（P10'）
-- ============================================
--
-- 一场排练练哪些曲子。一行 = 该场的一首曲目：
--   · sheet_music_id 非空 = 有谱曲目，指向谱务库；
--   · sheet_music_id 为空 = 无谱/自由文本曲目，title 即手输曲名；
--   · title 是快照：曲目改名或谱子被删后，这里仍保留当时的曲名。
--
-- 这张表是**考勤自动分配的判据来源**（见 20261023160100_attendance_allocation）；
-- 现有 `rehearsals.repertoire` 文本保留做展示/兼容，不再参与判定。
--
-- 写权限（用户 2026-10-23 定）：**仅 admin**。谱务只负责乐谱相关修改，
-- 不负责排练的创建/管理；团长能力（rehearsal）落地时再加 `has_capability('rehearsal')`。
-- 读：所有登录用户可读（成员端要显示曲目）。
--
-- 回滚：DROP TABLE IF EXISTS public.rehearsal_repertoire;

BEGIN;

CREATE TABLE public.rehearsal_repertoire (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rehearsal_id   bigint NOT NULL REFERENCES public.rehearsals(id) ON DELETE CASCADE,
  sheet_music_id uuid REFERENCES public.sheet_music(id) ON DELETE SET NULL,
  title          text NOT NULL CHECK (btrim(title) <> ''),
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rehearsal_repertoire IS
  '排练曲目映射：一场排练的曲目列表；有谱/无谱共用，考勤分配的判据来源。';
COMMENT ON COLUMN public.rehearsal_repertoire.sheet_music_id IS
  '有谱曲目指向谱务库；为空表示无谱/自由文本。曲子被删除时置空（保留 title）。';
COMMENT ON COLUMN public.rehearsal_repertoire.title IS
  '曲名快照；自由文本曲目即手输曲名。';

-- 同一场排练里曲名不重复
CREATE UNIQUE INDEX rehearsal_repertoire_title_uniq
  ON public.rehearsal_repertoire (rehearsal_id, title);

-- 同一场排练里同一份谱子只能选一次（无谱行不参与）
CREATE UNIQUE INDEX rehearsal_repertoire_score_uniq
  ON public.rehearsal_repertoire (rehearsal_id, sheet_music_id)
  WHERE sheet_music_id IS NOT NULL;

ALTER TABLE public.rehearsal_repertoire ENABLE ROW LEVEL SECURITY;

CREATE POLICY "排练曲目：所有登录用户可读" ON public.rehearsal_repertoire
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "排练曲目：仅管理员可写" ON public.rehearsal_repertoire
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

REVOKE ALL ON public.rehearsal_repertoire FROM anon;
REVOKE ALL ON public.rehearsal_repertoire FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rehearsal_repertoire TO authenticated;
GRANT ALL ON public.rehearsal_repertoire TO service_role;

COMMIT;

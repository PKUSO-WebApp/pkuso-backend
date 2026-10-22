-- ============================================
-- 声部字典：sections + section_group_members（P0a-1）
-- ============================================
--
-- 这是「乐器 / 声部 / 组 / 特殊值」的唯一真相。后续的声部长作用域、首席乐器、
-- 前端的 INSTRUMENT_ORDER / SECTION_GROUPS 都从这里派生，不再各仓手抄一份。
--
-- 设计依据：`声部长功能-数据模型与常量.md` §1.1–§1.4（2026-10-20 修订版）。
-- 关键决定：
--   · 16 个乐器全部 `can_lead=true` 且 `can_principal=true`（乐器本身可以当声部长作用域）；
--   · 只有「木管」「铜管」两个组 `can_lead=true`；「弦乐」「管乐」只做展示分组；
--   · `其他` 可作 `profiles.instrument`；`总谱` 只用于 `sheet_music_parts.section`；
--   · 字典只读：写只能走 migration，客户端没有任何写策略。
--
-- 本迁移是**纯新增**：不 ALTER 任何既有表、不碰任何存量数据。
-- 严格校验触发器在下一个 migration（20261023120100），两者分开是为了
-- 出事时能只回滚触发器、保留字典。
--
-- 回滚：
--   DROP TABLE IF EXISTS public.section_group_members;
--   DROP TABLE IF EXISTS public.sections;

BEGIN;

CREATE TABLE public.sections (
  name          text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('instrument','group','special')),
  sort_order    integer NOT NULL UNIQUE,
  can_lead      boolean NOT NULL DEFAULT false,
  can_principal boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sections IS
  '声部/乐器/组/特殊值字典。唯一真相；写只能走 migration。';
COMMENT ON COLUMN public.sections.kind IS
  'instrument=具体乐器（可作首席作用域）；group=展示分组（木管/铜管可作声部长作用域）；special=其他/总谱。';
COMMENT ON COLUMN public.sections.can_lead IS
  '能否作为声部长作用域。16 个乐器 + 木管/铜管 为真。';
COMMENT ON COLUMN public.sections.can_principal IS
  '能否作为首席作用域。仅 16 个乐器为真。';

CREATE TABLE public.section_group_members (
  group_name  text NOT NULL REFERENCES public.sections(name) ON UPDATE CASCADE ON DELETE CASCADE,
  member_name text NOT NULL REFERENCES public.sections(name) ON UPDATE CASCADE ON DELETE CASCADE,
  sort_order  integer NOT NULL,
  PRIMARY KEY (group_name, member_name)
);

COMMENT ON TABLE public.section_group_members IS
  '组 -> 成员乐器映射。顺序沿用现有 SECTION_GROUPS（不是 INSTRUMENT_ORDER）。';

INSERT INTO public.sections (name, kind, sort_order, can_lead, can_principal) VALUES
  ('第一小提琴','instrument', 10, true, true),
  ('第二小提琴','instrument', 20, true, true),
  ('中提琴',    'instrument', 30, true, true),
  ('大提琴',    'instrument', 40, true, true),
  ('低音提琴',  'instrument', 50, true, true),
  ('长笛',      'instrument', 60, true, true),
  ('双簧管',    'instrument', 70, true, true),
  ('单簧管',    'instrument', 80, true, true),
  ('大管',      'instrument', 90, true, true),
  ('圆号',      'instrument',100, true, true),
  ('小号',      'instrument',110, true, true),
  ('长号',      'instrument',120, true, true),
  ('大号',      'instrument',130, true, true),
  ('打击乐',    'instrument',140, true, true),
  ('键盘',      'instrument',150, true, true),
  ('竖琴',      'instrument',160, true, true),
  ('弦乐',      'group',     200, false, false),
  ('木管',      'group',     210, true,  false),
  ('铜管',      'group',     220, true,  false),
  ('管乐',      'group',     230, false, false),
  ('其他',      'special',   900, false, false),
  ('总谱',      'special',   910, false, false);

INSERT INTO public.section_group_members (group_name, member_name, sort_order) VALUES
  ('弦乐','第一小提琴',10),
  ('弦乐','第二小提琴',20),
  ('弦乐','中提琴',30),
  ('弦乐','大提琴',40),
  ('弦乐','低音提琴',50),
  ('木管','大管',10),
  ('木管','双簧管',20),
  ('木管','长笛',30),
  ('木管','单簧管',40),
  ('铜管','小号',10),
  ('铜管','长号',20),
  ('铜管','圆号',30),
  ('铜管','大号',40),
  ('管乐','大管',10),
  ('管乐','双簧管',20),
  ('管乐','长笛',30),
  ('管乐','单簧管',40),
  ('管乐','小号',50),
  ('管乐','长号',60),
  ('管乐','圆号',70),
  ('管乐','大号',80);

ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.section_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "声部字典：已登录可读" ON public.sections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "声部组：已登录可读" ON public.section_group_members
  FOR SELECT TO authenticated USING (true);

-- 显式收口，不依赖 Supabase 对新表的默认 GRANT。
-- RLS 本身没有写策略；这里再把表级写权限收掉，作为第二道保险。
REVOKE ALL ON public.sections FROM anon;
REVOKE ALL ON public.section_group_members FROM anon;
GRANT SELECT ON public.sections TO authenticated;
GRANT SELECT ON public.section_group_members TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.sections FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.section_group_members FROM authenticated;

COMMIT;

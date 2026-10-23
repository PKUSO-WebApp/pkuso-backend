-- ============================================
-- 声部长 / 首席 / 团长能力：三张表（P0b-1）
-- ============================================
--
-- 设计依据：`声部长功能-数据模型与常量.md` §2.1–§2.2 + §12.7（2026-10-23 最终版）。
--
-- · `section_leaders`：一个作用域至多一个声部长；section 可以是乐器或可作部长作用域的组
--   （木管/铜管）。一个人可以有多行（管多个作用域）。
-- · `instrument_principals`：一个乐器至多一个首席。
-- · `president_capabilities`：团长能力集。**本版只建表，不写任何行**；具体能力清单
--   等团长功能开发时再定。`is_admin()` 不扩成团长，团长用 `has_capability()` 判据。
--
-- 本迁移是**纯新增**：不 ALTER 既有表、不碰存量数据。
-- 下一迁移负责 `profiles.is_principal` + flags 强制重算 + 视图；再下一迁移放函数/RPC。
--
-- 回滚：
--   DROP TABLE IF EXISTS public.president_capabilities;
--   DROP TABLE IF EXISTS public.instrument_principals;
--   DROP TABLE IF EXISTS public.section_leaders;

BEGIN;

CREATE TABLE public.section_leaders (
  section     text PRIMARY KEY
              REFERENCES public.sections(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  leader_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX section_leaders_leader_idx ON public.section_leaders (leader_id);

COMMENT ON TABLE public.section_leaders IS
  '声部长：一个作用域至多一人。section 可以是乐器或木管/铜管组。';
COMMENT ON COLUMN public.section_leaders.leader_id IS
  '被任命者必须是本作用域成员（admin RPC 校验）；role 保持 member。';

CREATE TABLE public.instrument_principals (
  instrument   text PRIMARY KEY
               REFERENCES public.sections(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instrument_principals_principal_idx ON public.instrument_principals (principal_id);

COMMENT ON TABLE public.instrument_principals IS
  '声部首席：一个乐器至多一人。只能是具体乐器，不能是组。';

CREATE TABLE public.president_capabilities (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  capability text NOT NULL,
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);
CREATE INDEX president_capabilities_capability_idx
  ON public.president_capabilities (capability);

COMMENT ON TABLE public.president_capabilities IS
  '团长能力集。本版不写行；has_capability() 会把它和 is_admin() 合并判断。';
COMMENT ON COLUMN public.president_capabilities.capability IS
  '暂定值：attendance / rehearsal / room_booking / announcement / approval / shared_score / score_upload / export；清单待团长功能开发时定。';

ALTER TABLE public.section_leaders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instrument_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.president_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "声部长：已登录可读" ON public.section_leaders
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "首席：已登录可读" ON public.instrument_principals
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "团长能力：已登录可读" ON public.president_capabilities
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.section_leaders FROM anon;
REVOKE ALL ON public.instrument_principals FROM anon;
REVOKE ALL ON public.president_capabilities FROM anon;

GRANT SELECT ON public.section_leaders TO authenticated;
GRANT SELECT ON public.instrument_principals TO authenticated;
GRANT SELECT ON public.president_capabilities TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.section_leaders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.instrument_principals FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.president_capabilities FROM authenticated;

COMMIT;

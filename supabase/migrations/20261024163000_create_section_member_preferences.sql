-- ============================================
-- 默认分声部（P7a-1）：成员级偏好表
-- ============================================
--
-- 设计依据：`声部长功能-数据模型与常量.md` §9 + §12.6（2026-10-23 最终版）。
--
-- · 成员级**单一值**，不按曲子/文件；`null` = 未设置，正整数 = 分声部号。
-- · 用途只有谱务印制份数参考；不参与「分发给我的」筛选、排序或默认打开哪份谱。
-- · 不校验该号是否出现在某份文件里（同一成员在不同曲子里可能没有对应分声部）。
--
-- 读策略依赖 `can_set_preference()`，在下一迁移里随函数一起创建。
-- 写只经 `set_member_preference()`（security definer），表上不开放 authenticated 写权限。
--
-- 回滚：DROP TABLE IF EXISTS public.section_member_preferences;

BEGIN;

CREATE TABLE public.section_member_preferences (
  user_id            uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  preferred_sub_part integer,
  updated_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT section_member_preferences_sub_part_check
    CHECK (preferred_sub_part IS NULL OR preferred_sub_part > 0)
);

COMMENT ON TABLE public.section_member_preferences IS
  '成员默认分声部（P7）：成员级单一值，仅用于谱务统计印制份数。';
COMMENT ON COLUMN public.section_member_preferences.preferred_sub_part IS
  'null = 未设置；正整数 = 分声部号。不要求出现在当前文件里。';
COMMENT ON COLUMN public.section_member_preferences.updated_by IS
  '最后修改人（首席/声部长/团长/管理员）；审计用。';

CREATE OR REPLACE FUNCTION public.touch_section_member_preferences()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER section_member_preferences_touch
  BEFORE UPDATE ON public.section_member_preferences
  FOR EACH ROW EXECUTE FUNCTION public.touch_section_member_preferences();

ALTER TABLE public.section_member_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.section_member_preferences FROM anon;
REVOKE ALL ON public.section_member_preferences FROM authenticated;
GRANT SELECT ON public.section_member_preferences TO authenticated;

REVOKE EXECUTE ON FUNCTION public.touch_section_member_preferences() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_section_member_preferences() FROM anon;
GRANT EXECUTE ON FUNCTION public.touch_section_member_preferences() TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_section_member_preferences() TO service_role;

COMMIT;

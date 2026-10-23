-- ============================================
-- 声部字典：三个域的严格校验触发器（P0a-2）
-- ============================================
--
-- 目的：**所有写入**（INSERT 与 UPDATE）都不接受词典外的值。三个域：
--
--   · profiles.instrument          空 / 其他 / 16 个乐器（trim；拒 总谱 与未知值）
--   · sheet_music_parts.section    16 个乐器 / 总谱 / 其他
--   · rehearsals.target_section[]  每个元素必须是 16 个乐器；type='section' 时数组不能为空
--
-- ## 为什么和字典分开成两个 migration
--
-- 字典本身是纯新增、零行为变化；触发器会拒绝写入。分开之后，出问题可以只回滚
-- 这一个 migration（DROP TRIGGER / DROP FUNCTION），字典与种子不动。
--
-- ## 存量预检（阻断式）
--
-- 开闸之前先扫一遍存量；有任何词典外值就让整个 migration 失败，而不是带着脏数据
-- 开闸（那样这些行以后每次被 UPDATE 都会失败，问题会延迟到用户操作时才暴露）。
-- 2026-10-23 实查 dev 与 prod：三个域 + member_info 的词典外值、带首尾空白的值、
-- `type='section'` 但 target 为空的行，全部为 0。
--
-- ## 旧版小程序的 `Other`
--
-- `register-with-wechat` 同批会把 `Other` 归一为 `其他`。但 CI 的部署顺序是
-- `db push`（本 migration）先于 `functions deploy`：两者之间旧版 mp 英文环境注册
-- 仍会发 `Other`。所以触发器里也做一次同样的归一化 —— 这不是重复，是那几分钟
-- 窗口的兜底。等确认所有用户都升级之后，两处再一起删。
--
-- ## 回滚：
--   DROP TRIGGER IF EXISTS profiles_validate_instrument ON public.profiles;
--   DROP TRIGGER IF EXISTS sheet_music_parts_validate_section ON public.sheet_music_parts;
--   DROP TRIGGER IF EXISTS rehearsals_validate_target_section ON public.rehearsals;
--   DROP FUNCTION IF EXISTS public.validate_profile_instrument();
--   DROP FUNCTION IF EXISTS public.validate_sheet_music_section();
--   DROP FUNCTION IF EXISTS public.validate_rehearsal_target_section();

BEGIN;

-- ---------------------------------------------------------------------------
-- 存量预检：有脏数据就不开闸
-- ---------------------------------------------------------------------------
DO $precheck$
DECLARE
  bad_profiles int;
  bad_parts int;
  bad_targets int;
  bad_section_rehearsals int;
BEGIN
  SELECT count(*) INTO bad_profiles
  FROM public.profiles
  WHERE btrim(coalesce(instrument, '')) <> ''
    -- 旧版 mp 的 `Other` 由触发器归一，不算脏数据
    AND lower(btrim(instrument)) <> 'other'
    AND btrim(instrument) NOT IN (
      SELECT name FROM public.sections WHERE kind = 'instrument' OR name = '其他'
    );

  SELECT count(*) INTO bad_parts
  FROM public.sheet_music_parts
  WHERE section NOT IN (
    SELECT name FROM public.sections WHERE kind = 'instrument' OR name IN ('总谱','其他')
  );

  SELECT count(*) INTO bad_targets
  FROM public.rehearsals r, unnest(r.target_section) t(section)
  WHERE t.section NOT IN (
    SELECT name FROM public.sections WHERE kind = 'instrument'
  );

  SELECT count(*) INTO bad_section_rehearsals
  FROM public.rehearsals
  WHERE type = 'section' AND coalesce(cardinality(target_section), 0) = 0;

  IF bad_profiles + bad_parts + bad_targets + bad_section_rehearsals > 0 THEN
    RAISE EXCEPTION
      'section dictionary precheck failed: profiles=%, parts=%, targets=%, section_rehearsals=%',
      bad_profiles, bad_parts, bad_targets, bad_section_rehearsals;
  END IF;
END
$precheck$;

-- ---------------------------------------------------------------------------
-- profiles.instrument
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_profile_instrument()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = ''
AS $function$
DECLARE
  v text := btrim(coalesce(NEW.instrument, ''));
BEGIN
  -- 空值保留（只 trim）：profiles.instrument 允许为空
  IF v = '' THEN
    NEW.instrument := NULL;
    RETURN NEW;
  END IF;

  -- 旧版小程序英文环境把「其他」的 i18n label（Other）当值发过来。
  -- 与 `register-with-wechat` 的归一化是同一条兼容层，两处都保留，原因见文件头。
  IF lower(v) = 'other' THEN
    v := '其他';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sections
    WHERE name = v AND (kind = 'instrument' OR name = '其他')
  ) THEN
    RAISE EXCEPTION 'unknown_instrument: %', NEW.instrument USING ERRCODE = '23514';
  END IF;

  NEW.instrument := v;
  RETURN NEW;
END
$function$;

CREATE TRIGGER profiles_validate_instrument
  BEFORE INSERT OR UPDATE OF instrument ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_profile_instrument();

-- ---------------------------------------------------------------------------
-- sheet_music_parts.section
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_sheet_music_section()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sections
    WHERE name = NEW.section AND (kind = 'instrument' OR name IN ('总谱','其他'))
  ) THEN
    RAISE EXCEPTION 'unknown_sheet_music_section: %', NEW.section USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_parts_validate_section
  BEFORE INSERT OR UPDATE OF section ON public.sheet_music_parts
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_sheet_music_section();

-- ---------------------------------------------------------------------------
-- rehearsals.target_section[]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_rehearsal_target_section()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = ''
AS $function$
BEGIN
  -- 分排必须至少有一个目标声部
  IF NEW.type = 'section' AND coalesce(cardinality(NEW.target_section), 0) = 0 THEN
    RAISE EXCEPTION 'section_rehearsal_requires_target_section' USING ERRCODE = '23514';
  END IF;

  -- 每个元素都必须是具体乐器；组名不再落库
  IF NEW.target_section IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(NEW.target_section) t(section)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sections s
      WHERE s.name = t.section AND s.kind = 'instrument'
    )
  ) THEN
    RAISE EXCEPTION 'unknown_target_section: %', NEW.target_section USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER rehearsals_validate_target_section
  BEFORE INSERT OR UPDATE OF type, target_section ON public.rehearsals
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_rehearsal_target_section();

-- ---------------------------------------------------------------------------
-- 触发器函数的 EXECUTE 权限
-- ---------------------------------------------------------------------------
-- 与 `20260928120000_guard_profile_privileged_columns.sql` 同一条纪律：
-- 触发器函数只由触发器调用，不需要给客户端 EXECUTE。
REVOKE EXECUTE ON FUNCTION public.validate_profile_instrument() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_profile_instrument() FROM anon;
GRANT EXECUTE ON FUNCTION public.validate_profile_instrument() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_profile_instrument() TO service_role;

REVOKE EXECUTE ON FUNCTION public.validate_sheet_music_section() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_sheet_music_section() FROM anon;
GRANT EXECUTE ON FUNCTION public.validate_sheet_music_section() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_sheet_music_section() TO service_role;

REVOKE EXECUTE ON FUNCTION public.validate_rehearsal_target_section() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_rehearsal_target_section() FROM anon;
GRANT EXECUTE ON FUNCTION public.validate_rehearsal_target_section() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_rehearsal_target_section() TO service_role;

COMMIT;

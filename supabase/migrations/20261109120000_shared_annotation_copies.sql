-- ============================================
-- 0.6.1 共享批注副本（owner-only hard push + 其他人的个人层）
-- ============================================
--
-- 与 P5'（20261023170000 ~ 20261023170200）的关系：
--   · P5' 的共享层挂在**原文件**上，写权是 A2（本乐器首席 / 本作用域声部长 / shared_score）；
--   · 本 migration 把共享层改成**独立的副本实体**：一个 owner 对一份原文件最多一个副本。
--
-- 产品规则（2026-11-09 定）：
--   · 声部长/首席在「保存到…」里点「共享批注」，创建/更新自己的副本；
--   · 更新是 **hard push**：用 owner 当前在原文件上的整份个人批注覆盖共享层（含清空）；
--   · 只有 owner 能写共享层；其他人打开副本时把共享层合并进自己的个人层（冲突走现有三选一），
--     他人的修改永远只写个人层；
--   · owner 被撤职后 `can_push_shared_annotation` 变 false（冻结：仍可读，不能再 push）；
--   · 总谱不参与共享。
--
-- 为什么副本不写进 `sheet_music_files`：
--   · web 管理端按 part 直接 `select * from sheet_music_files`，真实行会被当成可删文件；
--     共用 storage_path 时会把原谱一起删掉；
--   · `get_score_print_plan` 按 files 行计数，副本会被算进印制份数。
--   所以副本是独立表 + 视图，mp 在「全部 → 曲目 → 声部」里合成展示。
--
-- 回滚（按依赖逆序）：
--   DROP VIEW IF EXISTS public.sheet_music_annotation_share_files;
--   DROP FUNCTION IF EXISTS public.push_share_user_annotation(uuid, integer, jsonb, text);
--   DROP FUNCTION IF EXISTS public.archive_share_user_annotation(uuid, integer, jsonb);
--   DROP FUNCTION IF EXISTS public.push_shared_annotation(uuid, integer, jsonb, text);
--   DROP FUNCTION IF EXISTS public.create_shared_annotation_share(uuid);
--   DROP FUNCTION IF EXISTS public.can_push_shared_annotation(uuid);
--   DROP FUNCTION IF EXISTS public.trim_sheet_music_share_user_annotation_history(uuid, uuid, integer, integer);
--   DROP FUNCTION IF EXISTS public.trim_sheet_music_share_annotation_history(uuid, integer, integer);
--   DROP TABLE IF EXISTS public.sheet_music_share_user_annotation_history;
--   DROP TABLE IF EXISTS public.sheet_music_share_user_annotations;
--   DROP TABLE IF EXISTS public.sheet_music_share_annotation_history;
--   DROP TABLE IF EXISTS public.sheet_music_share_annotations;
--   DROP TABLE IF EXISTS public.sheet_music_annotation_shares;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 共享副本
-- ---------------------------------------------------------------------------
CREATE TABLE public.sheet_music_annotation_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_id uuid NOT NULL REFERENCES public.sheet_music_files (id) ON DELETE CASCADE,
  -- 人退团/账号被删时保留副本（owner_id 置空 ⇒ 冻结），文件名用 owner_name 快照
  owner_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  owner_name text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sheet_music_annotation_shares_owner_unique
    UNIQUE (source_file_id, owner_id),
  CONSTRAINT sheet_music_annotation_shares_owner_name_check
    CHECK (length(btrim(owner_name)) > 0),
  CONSTRAINT sheet_music_annotation_shares_display_name_check
    CHECK (length(btrim(display_name)) > 0)
);

COMMENT ON TABLE public.sheet_music_annotation_shares IS
  '0.6.1 共享批注副本：一个 owner 对一份原文件最多一个副本；只有 owner 能写共享层。';
COMMENT ON COLUMN public.sheet_music_annotation_shares.owner_name IS
  '分享时的 full_name 快照（空值兜底「未命名成员」）；改名/退团不影响已生成的文件名。';

CREATE INDEX sheet_music_annotation_shares_source_idx
  ON public.sheet_music_annotation_shares (source_file_id);
CREATE INDEX sheet_music_annotation_shares_owner_idx
  ON public.sheet_music_annotation_shares (owner_id);

-- 总谱不参与共享。`sheet_music_files.part_id` 可空；没有 part 的文件也拒绝。
CREATE OR REPLACE FUNCTION public.validate_sheet_music_annotation_share_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_section text;
BEGIN
  SELECT p.section INTO v_section
  FROM public.sheet_music_files AS f
  LEFT JOIN public.sheet_music_parts AS p ON p.id = f.part_id
  WHERE f.id = NEW.source_file_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'file_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_section IS NULL OR btrim(v_section) = '总谱' THEN
    RAISE EXCEPTION 'source_not_shareable' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_annotation_shares_validate_source
  BEFORE INSERT OR UPDATE OF source_file_id ON public.sheet_music_annotation_shares
  FOR EACH ROW EXECUTE FUNCTION public.validate_sheet_music_annotation_share_source();

CREATE OR REPLACE FUNCTION public.touch_sheet_music_annotation_shares()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_annotation_shares_touch
  BEFORE INSERT OR UPDATE ON public.sheet_music_annotation_shares
  FOR EACH ROW EXECUTE FUNCTION public.touch_sheet_music_annotation_shares();

-- ---------------------------------------------------------------------------
-- 2. owner 的共享层（对应 P5' 的 sheet_music_shared_annotations，键换成 share_id）
-- ---------------------------------------------------------------------------
CREATE TABLE public.sheet_music_share_annotations (
  share_id   uuid NOT NULL REFERENCES public.sheet_music_annotation_shares (id) ON DELETE CASCADE,
  page       integer NOT NULL,
  strokes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_page_count integer,
  version    text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  PRIMARY KEY (share_id, page),
  CONSTRAINT sheet_music_share_annotations_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_share_annotations_strokes_type_check
    CHECK (jsonb_typeof(strokes) = 'array'),
  CONSTRAINT sheet_music_share_annotations_strokes_size_check
    CHECK (pg_column_size(strokes) < 262144)
);

COMMENT ON TABLE public.sheet_music_share_annotations IS
  '0.6.1 共享副本的共享层（owner 的批注；全团可读，写入只能经 RPC）。';

CREATE TABLE public.sheet_music_share_annotation_history (
  share_id    uuid NOT NULL REFERENCES public.sheet_music_annotation_shares (id) ON DELETE CASCADE,
  page        integer NOT NULL,
  version     text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  strokes     jsonb NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  replaced_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  PRIMARY KEY (share_id, page, version),
  CONSTRAINT sheet_music_share_annotation_history_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_share_annotation_history_type_check
    CHECK (jsonb_typeof(strokes) = 'array'),
  CONSTRAINT sheet_music_share_annotation_history_size_check
    CHECK (pg_column_size(strokes) < 262144)
);

CREATE INDEX sheet_music_share_annotation_history_trim_idx
  ON public.sheet_music_share_annotation_history (share_id, page, replaced_at DESC);

COMMENT ON TABLE public.sheet_music_share_annotation_history IS
  '共享副本共享层的历史（每页最近 10 版，覆盖/hard push 时归档）。';

CREATE OR REPLACE FUNCTION public.touch_sheet_music_share_annotations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_share_annotations_touch
  BEFORE INSERT OR UPDATE ON public.sheet_music_share_annotations
  FOR EACH ROW EXECUTE FUNCTION public.touch_sheet_music_share_annotations();

-- ---------------------------------------------------------------------------
-- 3. 其他人的个人层（与个人批注同形，键换成 share_id）
-- ---------------------------------------------------------------------------
-- 单独一张表而不是给 sheet_music_annotations 加 share_id：
--   · 不改动已经上了 prod 的个人批注表/主键/同步链路；
--   · 副本的个人层与「原文件的个人层」天然隔离（这正是产品要的）。
CREATE TABLE public.sheet_music_share_user_annotations (
  share_id   uuid NOT NULL REFERENCES public.sheet_music_annotation_shares (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  page       integer NOT NULL,
  strokes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  PRIMARY KEY (share_id, user_id, page),
  CONSTRAINT sheet_music_share_user_annotations_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_share_user_annotations_strokes_type_check
    CHECK (jsonb_typeof(strokes) = 'array'),
  CONSTRAINT sheet_music_share_user_annotations_strokes_size_check
    CHECK (pg_column_size(strokes) < 262144)
);

COMMENT ON TABLE public.sheet_music_share_user_annotations IS
  '0.6.1 其他人打开共享副本时的个人层（本人可见可写；写入经 CAS RPC）。';

CREATE TABLE public.sheet_music_share_user_annotation_history (
  share_id    uuid NOT NULL REFERENCES public.sheet_music_annotation_shares (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  page        integer NOT NULL,
  strokes     jsonb NOT NULL,
  version     text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, user_id, page, version),
  CONSTRAINT sheet_music_share_user_annotation_history_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_share_user_annotation_history_size_check
    CHECK (pg_column_size(strokes) < 262144)
);

CREATE INDEX sheet_music_share_user_annotation_history_trim_idx
  ON public.sheet_music_share_user_annotation_history (share_id, user_id, page, replaced_at DESC);

COMMENT ON TABLE public.sheet_music_share_user_annotation_history IS
  '共享副本个人层的历史（每页最近 10 版，覆盖时归档）。';

CREATE OR REPLACE FUNCTION public.touch_sheet_music_share_user_annotations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER sheet_music_share_user_annotations_touch
  BEFORE INSERT OR UPDATE ON public.sheet_music_share_user_annotations
  FOR EACH ROW EXECUTE FUNCTION public.touch_sheet_music_share_user_annotations();

-- ---------------------------------------------------------------------------
-- 4. 权限判据
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_push_shared_annotation(p_share_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.sheet_music_annotation_shares AS s
    WHERE s.id = p_share_id
      AND s.owner_id = auth.uid()
      AND public.can_edit_shared_annotation(s.source_file_id)
  );
$function$;

COMMENT ON FUNCTION public.can_push_shared_annotation(uuid) IS
  '0.6.1：只有 owner 且当前仍满足 A2（本乐器首席/本作用域声部长）才能写共享层；撤职即冻结。';

-- ---------------------------------------------------------------------------
-- 5. 历史裁剪（内部）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trim_sheet_music_share_annotation_history(
  p_share_id uuid,
  p_page integer,
  p_keep integer DEFAULT 10
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH ranked AS (
    SELECT h.version,
           row_number() OVER (ORDER BY h.replaced_at DESC, h.version DESC) AS rn
    FROM public.sheet_music_share_annotation_history AS h
    WHERE h.share_id = p_share_id AND h.page = p_page
  )
  DELETE FROM public.sheet_music_share_annotation_history AS h
  USING ranked AS r
  WHERE h.share_id = p_share_id
    AND h.page = p_page
    AND h.version = r.version
    AND r.rn > greatest(p_keep, 1);
$function$;

CREATE OR REPLACE FUNCTION public.trim_sheet_music_share_user_annotation_history(
  p_share_id uuid,
  p_user_id uuid,
  p_page integer,
  p_keep integer DEFAULT 10
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH ranked AS (
    SELECT h.version,
           row_number() OVER (ORDER BY h.replaced_at DESC, h.version DESC) AS rn
    FROM public.sheet_music_share_user_annotation_history AS h
    WHERE h.share_id = p_share_id AND h.user_id = p_user_id AND h.page = p_page
  )
  DELETE FROM public.sheet_music_share_user_annotation_history AS h
  USING ranked AS r
  WHERE h.share_id = p_share_id
    AND h.user_id = p_user_id
    AND h.page = p_page
    AND h.version = r.version
    AND r.rn > greatest(p_keep, 1);
$function$;

-- ---------------------------------------------------------------------------
-- 6. create_shared_annotation_share：创建/更新副本 + hard push
-- ---------------------------------------------------------------------------
-- 返回 created = true 表示这次新建了副本；false 表示更新了已有副本。
-- 首次创建时 owner 必须至少有一页非空笔迹（服务端兜底；UI 也会置灰入口）。
-- 更新允许把共享层清空（hard push 就是整份镜像）。
CREATE OR REPLACE FUNCTION public.create_shared_annotation_share(p_source_file_id uuid)
RETURNS TABLE (share_id uuid, display_name text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_file public.sheet_music_files;
  v_section text;
  v_name text;
  v_base text;
  v_display text;
  v_share_id uuid;
  v_created boolean := false;
  v_has_ink boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_source_file_id IS NULL THEN
    RAISE EXCEPTION 'bad_arguments' USING ERRCODE = '22023';
  END IF;

  SELECT f.* INTO v_file
  FROM public.sheet_music_files AS f
  WHERE f.id = p_source_file_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT p.section INTO v_section
  FROM public.sheet_music_parts AS p
  WHERE p.id = v_file.part_id;
  IF v_section IS NULL OR btrim(v_section) = '总谱' THEN
    RAISE EXCEPTION 'source_not_shareable' USING ERRCODE = '22023';
  END IF;

  IF NOT public.can_edit_shared_annotation(p_source_file_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  -- 人名：full_name 为空/空白时兜底；去掉文件系统不允许的字符与控制字符
  SELECT coalesce(nullif(btrim(p.full_name), ''), '未命名成员')
  INTO v_name
  FROM public.profiles AS p
  WHERE p.id = v_uid;
  IF v_name IS NULL THEN
    v_name := '未命名成员';
  END IF;
  v_name := regexp_replace(v_name, '[\\/:*?"<>|[:cntrl:]]', '-', 'g');
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  IF v_name = '' THEN
    v_name := '未命名成员';
  END IF;

  v_base := btrim(regexp_replace(v_file.file_name, '\.pdf$', '', 'i'));
  IF v_base = '' THEN
    v_base := '未命名乐谱';
  END IF;
  -- 与原文件名同形：`原名-批注by人名.pdf`（去掉原扩展名）
  v_display := left(v_base, 120) || '-批注by' || left(v_name, 60) || '.pdf';

  SELECT EXISTS (
    SELECT 1
    FROM public.sheet_music_annotations AS a
    WHERE a.file_id = p_source_file_id
      AND a.user_id = v_uid
      AND jsonb_array_length(a.strokes) > 0
  ) INTO v_has_ink;

  -- 先查后写（并发重复点按由唯一键兜住）
  SELECT s.id INTO v_share_id
  FROM public.sheet_music_annotation_shares AS s
  WHERE s.source_file_id = p_source_file_id AND s.owner_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.sheet_music_annotation_shares
        (source_file_id, owner_id, owner_name, display_name)
      VALUES
        (p_source_file_id, v_uid, v_name, v_display)
      RETURNING id INTO v_share_id;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT s.id INTO v_share_id
      FROM public.sheet_music_annotation_shares AS s
      WHERE s.source_file_id = p_source_file_id AND s.owner_id = v_uid
      FOR UPDATE;
      v_created := false;
    END;
  END IF;

  IF NOT v_created THEN
    UPDATE public.sheet_music_annotation_shares AS s
    SET owner_name = v_name,
        display_name = v_display
    WHERE s.id = v_share_id;
  END IF;

  IF v_created AND NOT v_has_ink THEN
    RAISE EXCEPTION 'no_annotations' USING ERRCODE = '22023';
  END IF;

  -- hard push 之前先把旧共享层归档（可回看最近 10 版）
  INSERT INTO public.sheet_music_share_annotation_history
    (share_id, page, strokes, replaced_by)
  SELECT v_share_id, a.page, a.strokes, v_uid
  FROM public.sheet_music_share_annotations AS a
  WHERE a.share_id = v_share_id
    AND jsonb_array_length(a.strokes) > 0
  ON CONFLICT (share_id, page, version) DO NOTHING;

  DELETE FROM public.sheet_music_share_annotations AS a
  WHERE a.share_id = v_share_id;

  -- 整份镜像：owner 原文件上**非空**的页原样写入；原文件上没有/为空的页就是没有
  INSERT INTO public.sheet_music_share_annotations
    (share_id, page, strokes, updated_by, source_page_count)
  SELECT v_share_id, a.page, a.strokes, v_uid, v_file.page_count
  FROM public.sheet_music_annotations AS a
  WHERE a.file_id = p_source_file_id
    AND a.user_id = v_uid
    AND jsonb_array_length(a.strokes) > 0;

  -- 每个页只留最近 10 版（hard push 可能一次归档很多页）
  WITH ranked AS (
    SELECT h.page,
           h.version,
           row_number() OVER (
             PARTITION BY h.page ORDER BY h.replaced_at DESC, h.version DESC
           ) AS rn
    FROM public.sheet_music_share_annotation_history AS h
    WHERE h.share_id = v_share_id
  )
  DELETE FROM public.sheet_music_share_annotation_history AS h
  USING ranked AS r
  WHERE h.share_id = v_share_id
    AND h.page = r.page
    AND h.version = r.version
    AND r.rn > 10;

  RETURN QUERY SELECT v_share_id, v_display, v_created;
END
$function$;

COMMENT ON FUNCTION public.create_shared_annotation_share(uuid) IS
  '0.6.1：创建/更新共享副本并 hard push（整份镜像 owner 在原文件上的个人批注）。';

-- ---------------------------------------------------------------------------
-- 7. push_shared_annotation：owner 直接编辑副本时的 CAS 写入
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.push_shared_annotation(
  p_share_id uuid,
  p_page integer,
  p_strokes jsonb,
  p_expected_version text DEFAULT NULL
)
RETURNS TABLE (ok boolean, version text, strokes jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_share public.sheet_music_annotation_shares;
  v_row public.sheet_music_share_annotations;
  v_new text;
  v_page_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_share_id IS NULL OR p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'bad_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_strokes IS NULL OR jsonb_typeof(p_strokes) <> 'array' THEN
    RAISE EXCEPTION 'bad_strokes' USING ERRCODE = '22023';
  END IF;
  IF NOT public.can_push_shared_annotation(p_share_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_share
  FROM public.sheet_music_annotation_shares AS s
  WHERE s.id = p_share_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'share_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT f.page_count INTO v_page_count
  FROM public.sheet_music_files AS f
  WHERE f.id = v_share.source_file_id;

  v_new := md5(p_strokes::text);

  SELECT a.* INTO v_row
  FROM public.sheet_music_share_annotations AS a
  WHERE a.share_id = p_share_id AND a.page = p_page
  FOR UPDATE;

  IF p_expected_version IS NOT NULL THEN
    IF v_row.share_id IS NULL THEN
      IF p_expected_version <> '' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::jsonb;
        RETURN;
      END IF;
    ELSIF v_row.version IS DISTINCT FROM p_expected_version THEN
      RETURN QUERY SELECT false, v_row.version, v_row.strokes;
      RETURN;
    END IF;
  END IF;

  IF v_row.share_id IS NULL THEN
    BEGIN
      INSERT INTO public.sheet_music_share_annotations
        (share_id, page, strokes, updated_by, source_page_count)
      VALUES
        (p_share_id, p_page, p_strokes, v_uid, v_page_count)
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      SELECT a.* INTO v_row
      FROM public.sheet_music_share_annotations AS a
      WHERE a.share_id = p_share_id AND a.page = p_page
      FOR UPDATE;
      IF p_expected_version IS NOT NULL THEN
        RETURN QUERY SELECT false, v_row.version, v_row.strokes;
        RETURN;
      END IF;
      INSERT INTO public.sheet_music_share_annotation_history
        (share_id, page, strokes, replaced_by)
      VALUES
        (p_share_id, p_page, v_row.strokes, v_uid)
      ON CONFLICT (share_id, page, version) DO NOTHING;
      PERFORM public.trim_sheet_music_share_annotation_history(p_share_id, p_page, 10);
      UPDATE public.sheet_music_share_annotations AS a
      SET strokes = p_strokes,
          updated_by = v_uid,
          source_page_count = v_page_count
      WHERE a.share_id = p_share_id AND a.page = p_page
      RETURNING * INTO v_row;
    END;
  ELSIF v_row.version <> v_new THEN
    INSERT INTO public.sheet_music_share_annotation_history
      (share_id, page, strokes, replaced_by)
    VALUES
      (p_share_id, p_page, v_row.strokes, v_uid)
    ON CONFLICT (share_id, page, version) DO NOTHING;
    PERFORM public.trim_sheet_music_share_annotation_history(p_share_id, p_page, 10);

    UPDATE public.sheet_music_share_annotations AS a
    SET strokes = p_strokes,
        updated_by = v_uid,
        source_page_count = v_page_count
    WHERE a.share_id = p_share_id AND a.page = p_page
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT true, v_row.version, NULL::jsonb;
END
$function$;

COMMENT ON FUNCTION public.push_shared_annotation(uuid, integer, jsonb, text) IS
  '0.6.1：owner 直接编辑副本时的 CAS 写入（唯一写共享层的入口）。';

-- ---------------------------------------------------------------------------
-- 8. push_share_user_annotation：其他人的个人层 CAS 写入
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.push_share_user_annotation(
  p_share_id uuid,
  p_page integer,
  p_strokes jsonb,
  p_expected_version text DEFAULT NULL
)
RETURNS TABLE (ok boolean, version text, strokes jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_row public.sheet_music_share_user_annotations;
  v_new text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_share_id IS NULL OR p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'bad_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_strokes IS NULL OR jsonb_typeof(p_strokes) <> 'array' THEN
    RAISE EXCEPTION 'bad_strokes' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sheet_music_annotation_shares AS s WHERE s.id = p_share_id
  ) THEN
    RAISE EXCEPTION 'share_not_found' USING ERRCODE = '22023';
  END IF;

  v_new := md5(p_strokes::text);

  SELECT a.* INTO v_row
  FROM public.sheet_music_share_user_annotations AS a
  WHERE a.share_id = p_share_id AND a.user_id = v_uid AND a.page = p_page
  FOR UPDATE;

  IF p_expected_version IS NOT NULL THEN
    IF v_row.share_id IS NULL THEN
      IF p_expected_version <> '' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::jsonb;
        RETURN;
      END IF;
    ELSIF v_row.version IS DISTINCT FROM p_expected_version THEN
      RETURN QUERY SELECT false, v_row.version, v_row.strokes;
      RETURN;
    END IF;
  END IF;

  IF v_row.share_id IS NULL THEN
    BEGIN
      INSERT INTO public.sheet_music_share_user_annotations
        (share_id, user_id, page, strokes)
      VALUES
        (p_share_id, v_uid, p_page, p_strokes)
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      SELECT a.* INTO v_row
      FROM public.sheet_music_share_user_annotations AS a
      WHERE a.share_id = p_share_id AND a.user_id = v_uid AND a.page = p_page
      FOR UPDATE;
      IF p_expected_version IS NOT NULL THEN
        RETURN QUERY SELECT false, v_row.version, v_row.strokes;
        RETURN;
      END IF;
      INSERT INTO public.sheet_music_share_user_annotation_history
        (share_id, user_id, page, strokes)
      VALUES
        (p_share_id, v_uid, p_page, v_row.strokes)
      ON CONFLICT (share_id, user_id, page, version) DO NOTHING;
      PERFORM public.trim_sheet_music_share_user_annotation_history(p_share_id, v_uid, p_page, 10);
      UPDATE public.sheet_music_share_user_annotations AS a
      SET strokes = p_strokes
      WHERE a.share_id = p_share_id AND a.user_id = v_uid AND a.page = p_page
      RETURNING * INTO v_row;
    END;
  ELSIF v_row.version <> v_new THEN
    INSERT INTO public.sheet_music_share_user_annotation_history
      (share_id, user_id, page, strokes)
    VALUES
      (p_share_id, v_uid, p_page, v_row.strokes)
    ON CONFLICT (share_id, user_id, page, version) DO NOTHING;
    PERFORM public.trim_sheet_music_share_user_annotation_history(p_share_id, v_uid, p_page, 10);

    UPDATE public.sheet_music_share_user_annotations AS a
    SET strokes = p_strokes
    WHERE a.share_id = p_share_id AND a.user_id = v_uid AND a.page = p_page
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT true, v_row.version, NULL::jsonb;
END
$function$;

COMMENT ON FUNCTION public.push_share_user_annotation(uuid, integer, jsonb, text) IS
  '0.6.1：其他人对共享副本的个人层 CAS 写入；永远不写共享层。';

-- ---------------------------------------------------------------------------
-- 9. archive_share_user_annotation：把本地那一份送进历史（「用远端」时用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_share_user_annotation(
  p_share_id uuid,
  p_page integer,
  p_strokes jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_share_id IS NULL OR p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'bad_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_strokes IS NULL OR jsonb_typeof(p_strokes) <> 'array' THEN
    RAISE EXCEPTION 'bad_strokes' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sheet_music_share_user_annotation_history
    (share_id, user_id, page, strokes)
  VALUES
    (p_share_id, v_uid, p_page, p_strokes)
  ON CONFLICT (share_id, user_id, page, version) DO NOTHING;
  PERFORM public.trim_sheet_music_share_user_annotation_history(p_share_id, v_uid, p_page, 10);
END
$function$;

-- ---------------------------------------------------------------------------
-- 10. 列表视图（mp 在「全部 → 曲目 → 声部」里合成条目）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.sheet_music_annotation_share_files
WITH (security_invoker = true)
AS
SELECT
  s.id AS share_id,
  s.source_file_id,
  s.owner_id,
  s.owner_name,
  s.display_name AS file_name,
  f.storage_path,
  f.file_size,
  f.page_count,
  f.part_id,
  p.section,
  sm.id AS score_id,
  sm.title,
  s.created_at,
  s.updated_at
FROM public.sheet_music_annotation_shares AS s
JOIN public.sheet_music_files AS f ON f.id = s.source_file_id
JOIN public.sheet_music_parts AS p ON p.id = f.part_id
JOIN public.sheet_music AS sm ON sm.id = p.sheet_music_id
WHERE btrim(p.section) <> '总谱';

COMMENT ON VIEW public.sheet_music_annotation_share_files IS
  '0.6.1：共享副本的文件形态（share_id + 源文件信息 + 声部/曲目），供 mp 合成到声部文件列表。';

-- ---------------------------------------------------------------------------
-- 11. RLS 与授权
-- ---------------------------------------------------------------------------
ALTER TABLE public.sheet_music_annotation_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_music_share_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_music_share_annotation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_music_share_user_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_music_share_user_annotation_history ENABLE ROW LEVEL SECURITY;

-- 共享内容全团可读（与谱务文件本身「所有人可读」同向）
CREATE POLICY sheet_music_annotation_shares_read
  ON public.sheet_music_annotation_shares
  FOR SELECT TO authenticated USING (true);

CREATE POLICY sheet_music_share_annotations_read
  ON public.sheet_music_share_annotations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY sheet_music_share_annotation_history_read
  ON public.sheet_music_share_annotation_history
  FOR SELECT TO authenticated USING (true);

-- 个人层：只读自己的；写入口只有 CAS RPC
CREATE POLICY sheet_music_share_user_annotations_own_read
  ON public.sheet_music_share_user_annotations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY sheet_music_share_user_annotation_history_own_read
  ON public.sheet_music_share_user_annotation_history
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- 表上没有 authenticated 写权限：唯一写入口是 SECURITY DEFINER 的 RPC
REVOKE ALL ON public.sheet_music_annotation_shares FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_annotation_shares TO authenticated;
GRANT ALL ON public.sheet_music_annotation_shares TO service_role;

REVOKE ALL ON public.sheet_music_share_annotations FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_share_annotations TO authenticated;
GRANT ALL ON public.sheet_music_share_annotations TO service_role;

REVOKE ALL ON public.sheet_music_share_annotation_history FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_share_annotation_history TO authenticated;
GRANT ALL ON public.sheet_music_share_annotation_history TO service_role;

REVOKE ALL ON public.sheet_music_share_user_annotations FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_share_user_annotations TO authenticated;
GRANT ALL ON public.sheet_music_share_user_annotations TO service_role;

REVOKE ALL ON public.sheet_music_share_user_annotation_history FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_share_user_annotation_history TO authenticated;
GRANT ALL ON public.sheet_music_share_user_annotation_history TO service_role;

REVOKE ALL ON public.sheet_music_annotation_share_files FROM anon;
GRANT SELECT ON public.sheet_music_annotation_share_files TO authenticated, service_role;

-- 触发器函数不需要客户端执行权
REVOKE EXECUTE ON FUNCTION public.validate_sheet_music_annotation_share_source() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_annotation_shares() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_share_annotations() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_sheet_music_share_user_annotations() FROM PUBLIC, anon, authenticated;

-- 内部裁剪工具：谁都不给
REVOKE ALL ON FUNCTION public.trim_sheet_music_share_annotation_history(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trim_sheet_music_share_user_annotation_history(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;

-- 客户端入口
REVOKE ALL ON FUNCTION public.can_push_shared_annotation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_push_shared_annotation(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_shared_annotation_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_shared_annotation_share(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.push_shared_annotation(uuid, integer, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_shared_annotation(uuid, integer, jsonb, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.push_share_user_annotation(uuid, integer, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_share_user_annotation(uuid, integer, jsonb, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.archive_share_user_annotation(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_share_user_annotation(uuid, integer, jsonb) TO authenticated, service_role;

COMMIT;

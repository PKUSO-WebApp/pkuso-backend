-- 谱务批注：版本 CAS（乐观并发）+ 每页最近 N 版的历史。
--
-- 背景（2026-10-14 定，决策底稿在 pkusoweb/批注同步改造-调查与方案.md）：
--   批注此前是「整页覆盖 + 客户端按内容指纹对账」。同一人多设备同时改同一页时，
--   冲突只能靠**设备时钟**判先后（LWW）——而时钟不可信，且**输的那一份是静默丢掉的**：
--   用户看不到、也没得选。这次把「悄悄覆盖」换成「看得见的冲突」。
--
-- 做法是 ETag / If-Match 那一类乐观并发：服务端给每一行算一个**内容版本号**，
-- 客户端推送时带上「我上次看到的是哪一版」，对不上就拒绝并**把远端当前内容带回去**。
--
-- 三件事：
--   1. `version` 生成列 —— 内容版本号，服务端算，客户端**只存不造**（当不透明令牌用）；
--   2. `sheet_music_annotation_history` —— 每页最近 N 版，**覆盖时归档被覆盖的那一份**。
--      批注没法做笔迹级合并（没有 per-stroke id / 墓碑，见主表 migration 的说明），
--      冲突只能选赢家；有了历史，「选错了」就还能切回来，而不是永久丢失；
--   3. 推送 / 归档两条 RPC —— CAS 与写历史都是多条语句，必须原子，也必须是**一条**
--      语句的往返（先读再写会把竞态重新引进来）。
--
-- ⚠️ 老客户端（不带版本号）**不挡**（用户 2026-10-14 定）：小程序没有灰度，
--   挡了等于强制升级。`p_expected_version IS NULL` 就是老客户端的路 —— 无条件覆盖，
--   与这次改动之前的行为一字不差；代价只是「老客户端的一次覆盖在新客户端看来像远端编辑」，
--   而那正是今天的行为。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. version：内容版本号（生成列 ⇒ 存量行不用回填，自动算出来）
-- ---------------------------------------------------------------------------
-- jsonb 的文本表示是**规范化**的（键序固定、空白归一）⇒ 同样内容必得同一个值，
-- 而客户端推来的 JSON 里键序/空白怎么写都不影响。
ALTER TABLE public.sheet_music_annotations
  ADD COLUMN IF NOT EXISTS version text GENERATED ALWAYS AS (md5(strokes::text)) STORED;

COMMENT ON COLUMN public.sheet_music_annotations.version IS
  '内容版本号 = md5(strokes 的规范化文本)，由服务端生成。客户端只把它当不透明令牌原样带回，不自己算。';

-- ---------------------------------------------------------------------------
-- 2. history：每页最近 N 版（覆盖时归档**被覆盖**的那一份）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sheet_music_annotation_history (
  file_id uuid NOT NULL REFERENCES public.sheet_music_files (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  page integer NOT NULL,
  strokes jsonb NOT NULL,
  -- 与主表同算法、同样由服务端算：同一份内容无论出现在主表还是历史里，version 都是同一个值
  version text GENERATED ALWAYS AS (md5(strokes::text)) STORED,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  -- 同一份内容只留一条（幂等）：反复覆盖成同一份内容不会把历史撑大
  PRIMARY KEY (file_id, user_id, page, version),
  CONSTRAINT sheet_music_annotation_history_page_check CHECK (page >= 1),
  -- 与主表同一条护栏，防止单行把表撑爆
  CONSTRAINT sheet_music_annotation_history_strokes_size_check CHECK (pg_column_size(strokes) < 262144)
);

COMMENT ON TABLE public.sheet_music_annotation_history IS
  '谱务批注的历史版本（每页最近 N 份，覆盖时由推送 RPC 归档）。让「冲突里选了一版」不再是破坏性的，并给误覆盖/误删留兜底。';

-- 裁剪要按 (册, 用户, 页) 取最近 N 条：主键的前缀能定位到页，但排序要 replaced_at
CREATE INDEX IF NOT EXISTS sheet_music_annotation_history_trim_idx
  ON public.sheet_music_annotation_history (file_id, user_id, page, replaced_at DESC);

ALTER TABLE public.sheet_music_annotation_history ENABLE ROW LEVEL SECURITY;

-- 只读自己的（与主表同形）；**写入口只有 SECURITY DEFINER 的 RPC**
CREATE POLICY sheet_music_annotation_history_own_read ON public.sheet_music_annotation_history
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 默认授权会把新表给 anon/authenticated 全权 ⇒ 显式收回（本仓有先例：20260929140000）。
-- authenticated 只给 SELECT（历史是**只读**的用户资产，写入只能经 RPC）——
-- 这不是形式主义：客户端能直接 DELETE 的话，「选错了还能切回来」就不成立了。
REVOKE ALL ON public.sheet_music_annotation_history FROM anon, authenticated;
GRANT SELECT ON public.sheet_music_annotation_history TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. 裁剪：每页只留最近 N 份
-- ---------------------------------------------------------------------------
-- 内部工具（两个 RPC 都要用）⇒ 不给任何客户端角色执行权限（下一段就 REVOKE）。
-- ⚠️ 不裁的话这张表就是「每次编辑都留一份全文」的无界增长。
CREATE OR REPLACE FUNCTION public.trim_sheet_music_annotation_history(
  p_file_id uuid,
  p_user_id uuid,
  p_page integer,
  p_keep integer DEFAULT 10
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH ranked AS (
    SELECT h.version,
           row_number() OVER (ORDER BY h.replaced_at DESC, h.version DESC) AS rn
    FROM public.sheet_music_annotation_history h
    WHERE h.file_id = p_file_id AND h.user_id = p_user_id AND h.page = p_page
  )
  DELETE FROM public.sheet_music_annotation_history h
  USING ranked r
  WHERE h.file_id = p_file_id
    AND h.user_id = p_user_id
    AND h.page = p_page
    AND h.version = r.version
    AND r.rn > greatest(p_keep, 1);
$function$;

-- ---------------------------------------------------------------------------
-- 4. push_sheet_music_annotation：CAS 写入（唯一写主表 + 历史的入口）
-- ---------------------------------------------------------------------------
-- 语义：
--   p_expected_version IS NULL  → 无条件覆盖（老客户端；也用于「我这条基线没有版本号」的旧数据）
--   p_expected_version = ''     → 期望「这一行不存在」（首次写）
--   其他                        → 期望当前行的 version 恰好等于它
--
-- 返回 (ok, version, strokes)：
--   成功 → ok=true，version = 写入后那一行的 version，strokes = NULL（客户端自己知道内容）
--   失败 → ok=false，version/strokes = **远端当前**那一行（没有行时都是 NULL）——
--          客户端必须拿到它才能判「这其实是我自己那次写（丢 ACK）」而不是冲突
--
-- ⚠️ 整个函数在一条语句的调用里完成「读 → 判 → 写」，且 `SELECT ... FOR UPDATE` 把行锁住：
--   先 GET 再 PATCH 的写法会在两次往返之间留下竞态窗口，而 CAS 的全部价值就在于那个窗口不存在。
CREATE OR REPLACE FUNCTION public.push_sheet_music_annotation(
  p_file_id uuid,
  p_page integer,
  p_strokes jsonb,
  p_expected_version text DEFAULT NULL
)
RETURNS TABLE (ok boolean, version text, strokes jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.sheet_music_annotations;
  v_new text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_file_id IS NULL OR p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'bad_arguments';
  END IF;
  -- 非数组一律拒绝：这一列的形状是客户端与合成函数共同的契约
  IF p_strokes IS NULL OR jsonb_typeof(p_strokes) <> 'array' THEN
    RAISE EXCEPTION 'bad_strokes';
  END IF;

  v_new := md5(p_strokes::text);

  -- 锁住这一行（不存在则锁不到，下面的唯一键冲突兜住并发插入）
  SELECT a.* INTO v_row
  FROM public.sheet_music_annotations a
  WHERE a.file_id = p_file_id AND a.user_id = v_uid AND a.page = p_page
  FOR UPDATE;

  IF p_expected_version IS NOT NULL THEN
    IF v_row.file_id IS NULL THEN
      -- 期望一个「存在且是某个版本」的行，而它不在 ⇒ 冲突（把「远端没有这一行」原样带回）
      IF p_expected_version <> '' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::jsonb;
        RETURN;
      END IF;
    ELSIF v_row.version IS DISTINCT FROM p_expected_version THEN
      -- 版本对不上 ⇒ 冲突：**什么都不写**，把远端当前内容带回去给客户端判读
      RETURN QUERY SELECT false, v_row.version, v_row.strokes;
      RETURN;
    END IF;
    -- 走到这里：要么期望不存在且确实不存在，要么版本恰好命中
  END IF;

  IF v_row.file_id IS NULL THEN
    BEGIN
      INSERT INTO public.sheet_music_annotations (file_id, user_id, page, strokes)
      VALUES (p_file_id, v_uid, p_page, p_strokes)
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      -- 并发插入（两条首次写撞在一起）：CAS 下这就是冲突，无条件写则按覆盖处理
      SELECT a.* INTO v_row
      FROM public.sheet_music_annotations a
      WHERE a.file_id = p_file_id AND a.user_id = v_uid AND a.page = p_page
      FOR UPDATE;
      IF p_expected_version IS NOT NULL THEN
        RETURN QUERY SELECT false, v_row.version, v_row.strokes;
        RETURN;
      END IF;
      PERFORM public.archive_sheet_music_annotation(p_file_id, p_page, v_row.strokes);
      UPDATE public.sheet_music_annotations a
      SET strokes = p_strokes
      WHERE a.file_id = p_file_id AND a.user_id = v_uid AND a.page = p_page
      RETURNING * INTO v_row;
    END;
  ELSIF v_row.version <> v_new THEN
    -- 有行且内容真的变了：先把**被覆盖的那一份**归档，再写
    PERFORM public.archive_sheet_music_annotation(p_file_id, p_page, v_row.strokes);
    UPDATE public.sheet_music_annotations a
    SET strokes = p_strokes
    WHERE a.file_id = p_file_id AND a.user_id = v_uid AND a.page = p_page
    RETURNING * INTO v_row;
  END IF;
  -- 内容与现状一字不差（v_row.version = v_new）时什么都不做：不写库、不归档、不碰 updated_at

  RETURN QUERY SELECT true, v_row.version, NULL::jsonb;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. archive_sheet_music_annotation：把一份内容存进历史（**不动主表**）
-- ---------------------------------------------------------------------------
-- 两个调用方：
--   · 推送 RPC（内部）—— 覆盖前把**被覆盖的那一份**归档；
--   · 客户端（「用远端版」）—— 那一按会用远端的笔迹覆盖本地的，而服务端自始至终
--     没见过本地那份 ⇒ 不主动送上来就等于一按就没了。与「用本地版」对称：那条路里
--     被覆盖的远端内容由推送 RPC 归档，这条路由客户端显式调用。两条路之后，
--     历史里都留着对方的那一版。
CREATE OR REPLACE FUNCTION public.archive_sheet_music_annotation(
  p_file_id uuid,
  p_page integer,
  p_strokes jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_file_id IS NULL OR p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'bad_arguments';
  END IF;
  IF p_strokes IS NULL OR jsonb_typeof(p_strokes) <> 'array' THEN
    RAISE EXCEPTION 'bad_strokes';
  END IF;

  -- 只归档自己的内容（user_id 恒取 auth.uid()，客户端无从指定别人的）
  INSERT INTO public.sheet_music_annotation_history (file_id, user_id, page, strokes)
  VALUES (p_file_id, v_uid, p_page, p_strokes)
  ON CONFLICT (file_id, user_id, page, version) DO NOTHING;
  PERFORM public.trim_sheet_music_annotation_history(p_file_id, v_uid, p_page, 10);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 授权
-- ---------------------------------------------------------------------------
-- 内部工具（裁剪）：**谁都不给**，只由上面几个 SECURITY DEFINER 的函数调用
REVOKE ALL ON FUNCTION public.trim_sheet_music_annotation_history(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;

-- 客户端入口：登录用户可调，匿名一律不给（Postgres 的函数默认对 PUBLIC 开放执行权）
REVOKE ALL ON FUNCTION public.push_sheet_music_annotation(uuid, integer, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_sheet_music_annotation(uuid, integer, jsonb, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.archive_sheet_music_annotation(uuid, integer, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_sheet_music_annotation(uuid, integer, jsonb)
  TO authenticated;

COMMIT;

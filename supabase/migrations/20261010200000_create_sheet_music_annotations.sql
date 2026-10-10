-- 谱务批注：按「一册 + 一页」一行存，**个人内容**（只有本人可见可写）。
--
-- 为什么需要它：批注此前**只存在设备本地**（pkuso-mp 的 Storage，键 score-annotation:<fileId>），
-- 换设备/重装小程序就没了。上云同时解决两件事：批注跟着账号走；以及「云端合成一份带批注的
-- PDF 再分享」有了输入（那个需求在 pkuso-mp 侧另议）。
--
-- 为什么粒度是「页」而不是「整份文档」：
--   多设备同步时**冲突面越小越好**。整份文档的粒度下，只要两台设备改过同一份谱就会互相覆盖
--   ——一台存着旧副本的设备一推，就把别处的新改动静默抹掉。按页之后，冲突只可能发生在
--   「两边都改了同一页」，而一份谱十几页，这很罕见；且真发生时损失也只是一页。
--
-- 为什么不需要 per-stroke 的 id / 墓碑：这个粒度不用。
--   页内是**整页覆盖**，「撤销 / 擦除」在数据上就是「这一页少了几笔」——不存在需要同步的
--   删除操作，也就没有「合并时把删掉的笔迹复活」那个经典问题。要做笔迹级合并才需要它们，
--   而那件事现在不值得（改动大得多）。
--
-- ⚠️ 客户端**不靠时间戳判定冲突**（pkuso-mp 用每页的内容指纹对账）：时钟不可靠，内容才可靠。
--   `updated_at` 只用于诊断与排查，不参与任何同步判定。
--
-- 容量：一页的笔迹 JSON 正常量级是几 KB（坐标已量化到 4 位小数、近重复点已过滤）。
--   下面那条 256KB 的护栏是**防呆**：越界直接拒绝，而不是让单行把表撑爆。

BEGIN;

CREATE TABLE IF NOT EXISTS public.sheet_music_annotations (
  file_id uuid NOT NULL REFERENCES public.sheet_music_files (id) ON DELETE CASCADE,
  -- 本人内容：册子被删时一并消失（CASCADE），用户被删时同样
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  page integer NOT NULL,
  strokes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, user_id, page),
  CONSTRAINT sheet_music_annotations_page_check CHECK (page >= 1),
  CONSTRAINT sheet_music_annotations_strokes_size_check CHECK (pg_column_size(strokes) < 262144)
);

COMMENT ON TABLE public.sheet_music_annotations IS
  '谱务批注（按册+页一行，个人内容）。客户端按页内容指纹对账，不依赖时间戳。';

ALTER TABLE public.sheet_music_annotations ENABLE ROW LEVEL SECURITY;

-- 只允许本人读写本人的批注：批注是个人笔记，不是共享内容（与谱务文件本身的「所有人可读」相反）
CREATE POLICY sheet_music_annotations_own ON public.sheet_music_annotations
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 显式收回匿名角色的权限：本表的 RLS 策略只给了 authenticated，但**默认授权**仍可能让 anon
-- 拿到表级权限（本仓有过这类先例：20260929140000 专门回收过 profiles/attendances 的匿名写）。
REVOKE ALL ON public.sheet_music_annotations FROM anon;

-- updated_at 由服务端盖章：客户端的时间不可信，且 upsert 时不该由它来写
CREATE OR REPLACE FUNCTION public.touch_sheet_music_annotations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sheet_music_annotations_touch
  BEFORE INSERT OR UPDATE ON public.sheet_music_annotations
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_sheet_music_annotations();

COMMIT;

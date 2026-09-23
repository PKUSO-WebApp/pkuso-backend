-- ============================================
-- 谱务：把「声部」与「乐器名」拆成两个语义
-- ============================================
--
-- 原本 sheet_music_parts.instrument 一个列同时承担两个语义。识别改造
-- （pkuso-backend#12）之后两者分离，且集合性质相反：
--
--   sheet_music_parts.section     闭集 —— 乐团 16 个声部之一，或「其他」
--   sheet_music_files.instrument  开集 —— LLM 直接产出的中文乐器名，不归一
--
-- ⚠️ 本迁移只「加列」，不改名、不删列。
--
-- 原因：Web 端的配套改造（pkuso-web#283）是一次大改（全屏层 + 逐行状态机），
-- 会在本迁移之后相当久才上线。期间旧版前端仍按 sheet_music_parts.instrument
-- 分组写入 —— 旧列必须保持可读写。一旦改名，旧前端的 getOrCreatePart() 会直接
-- 撞 column "instrument" does not exist，整个谱务上传功能报错。
--
-- 加列式让两个仓库的部署顺序变得无关紧要：新前端只写 section，
-- 旧前端只写 instrument，两者互不干扰。
--
-- ⚠️ 但加列只解决了 **schema** 那一半。识别语义变了同样会打断旧前端：
-- 它的 generateFileName 仅在 instrument === "Violin" 时才拼声部名，而新契约
-- 不再返回 "Violin"，两支小提琴会算成同一个存储路径，加上上传用 upsert:true
-- 就会静默覆盖、丢一份分谱。那一半由 llm-analyze 侧兜住 —— 小提琴的 subPart
-- 改由声部反推 1/2（见 analyze.ts 的 VIOLIN_SUB_PART），与列名无关。
--
-- 另有一处**不丢数据但会留痕**的过渡态：窗口期内旧前端往 instrument 写的是
-- **中文乐器名**，而新前端写的是声部名 —— 跨过切换点重新上传同一首曲子，
-- `sheet_music_parts` 里会同时留下「Violin」与「小提琴」两行。
-- #283 之后的清理迁移回填 section 时要面对这种不一致。
--
-- 清理（回填 section、SET NOT NULL、DROP 掉旧列）留到 #283 上线后的独立迁移。
--
-- 回滚：
--   ALTER TABLE public.sheet_music_parts DROP COLUMN section;
--   ALTER TABLE public.sheet_music_files DROP COLUMN instrument;
--   ALTER TABLE public.sheet_music_parts ALTER COLUMN instrument SET NOT NULL;

BEGIN;

-- 1. 声部：闭集
ALTER TABLE public.sheet_music_parts ADD COLUMN section TEXT;

-- 2. 乐器名：开集
--    与 storage_path 里的文件名分开存 —— 便于区分「LLM 答错」与「文件名生成错」
ALTER TABLE public.sheet_music_files ADD COLUMN instrument TEXT;

-- 3. 旧列改为可空：新前端只写 section，不再写这个列
ALTER TABLE public.sheet_music_parts ALTER COLUMN instrument DROP NOT NULL;

COMMENT ON COLUMN public.sheet_music_parts.section IS
  '声部（闭集）：第一小提琴/第二小提琴/中提琴/大提琴/低音提琴/长笛/双簧管/单簧管/大管/圆号/小号/长号/大号/打击乐/键盘/竖琴/其他';

COMMENT ON COLUMN public.sheet_music_parts.instrument IS
  '【已废弃】过渡期保留以兼容旧版前端。语义已迁移到 section，待 pkuso-web#283 上线后由独立迁移回填并删除。';

COMMENT ON COLUMN public.sheet_music_files.instrument IS
  'LLM 识别的中文乐器名（开集，不归一）。与 storage_path 中的文件名分开存，便于区分识别错误与文件名生成错误。';

COMMIT;

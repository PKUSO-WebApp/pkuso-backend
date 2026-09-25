-- ============================================
-- 谱务：sub_parts 收成「恒非 NULL」，退役 NULL/{} 的二分法（技术债 A2）
-- ============================================
--
-- 20260923140000 引入 `sub_parts INTEGER[]` 时**不做回填**，并立了一条语义二分：
--
--   NULL  = 「号不在库里」（那份文件历史行，号只活在 file_name 里，**可回填**）
--   '{}'  = 「没有分声部」
--
-- 为此另有一个回填迁移（20260924013000）把能从 file_name 里读出来的号补进这一列，
-- 而读取侧要**两种都兜**（前端的 sort-parts.ts 对 NULL 取 0；列 COMMENT 明写"读取侧两种都要兜"）。
--
-- 那套二分法是**过渡期**的产物：它的存在只为了「迁移没跑完时也读得出东西」。现在：
--
--   · 回填迁移早已跑完，而**剩下的 NULL 都不是「可回填」而是「确实没有号」**——
--     实测 prod（要复现就跑，别信"应该没有"）：
--       select count(*) filter (where sub_parts is null)                         as null_rows,
--              count(*) filter (where sub_parts is null and file_name ~ '[0-9]') as null_with_digit
--       from public.sheet_music_files;
--     结果是 13 行 NULL、其中**文件名里带数字的 0 行**。
--
--     ⚠️ 判据必须是 `[0-9]` 而**不是** `_[0-9]`：库里两种命名并存 —— 老行是
--     `F调圆号_1.pdf`，新行是 `F调圆号1.pdf`（**不带下划线**）。只查下划线形态会漏掉后者
--     （实测库里就有 16 个不带下划线的号）。
--
--     而「文件名里还有数字」这件事**本身就是信号**：回填迁移 `20260924013000` 特意把
--     「号超过 32 个」的行留成 NULL 等人工看（它自己的注释写着「超界的行宁可不填」）——
--     把那种行抹成 '{}' 等于把「等人来看」变成「肯定没有号」，而且不可逆。
--     所以下面第 1 步先守卫再回填。
--   · 用户已明确：现在的谱务数据不是业务数据，可以清空/迁移。
--
-- 所以这一步把 NULL 彻底收掉：**先回填、再 SET NOT NULL**（顺序不能换）。
-- 之后「空数组 = 没有分声部」成为唯一含义，读取侧的兜底代码可以随之删掉
--（前端 `sort-parts.ts` 的 NULL→0、`[id]/page.tsx` 的 `number[] | null`）——
-- ⚠️ **那些兜底要等本迁移上了 prod 之后再删**：先删的话，万一还有 NULL 行，
-- 详情页会在取 `sub_parts[0]` 时抛错。
--
-- 回滚：
--   ALTER TABLE public.sheet_music_files ALTER COLUMN sub_parts DROP NOT NULL;
--   -- 列说明的**逐字原文**在 20260923140000 的 COMMENT ON COLUMN 里，照那一份贴回去
--   （注意：**读不回 NULL 行**了 —— 「本来没有号」与「号不在库里」从此分不开）

BEGIN;

-- 1a. 守卫：**先挡住「文件名里还有数字」的行**，别把上一版故意留下的信号抹掉
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM public.sheet_music_files
  WHERE sub_parts IS NULL AND file_name ~ '[0-9]';
  IF n > 0 THEN
    RAISE EXCEPTION
      '有 % 行的 sub_parts 为 NULL 而文件名里带数字 —— 多半是回填迁移因「号超过上界」故意留的，先人工看一眼再收这一列',
      n;
  END IF;
END $$;

-- 1b. 回填（prod 上 13 行、且都真的没有号 —— 见上面那段实测）
UPDATE public.sheet_music_files
SET sub_parts = '{}'::integer[]
WHERE sub_parts IS NULL;

-- 2. 从此恒非 NULL：默认值本来就是 '{}'，新行不受影响
ALTER TABLE public.sheet_music_files ALTER COLUMN sub_parts SET NOT NULL;

-- 3. 列说明跟着改：旧那句「读取侧两种都要兜」是二分法时代的话，留着会把下一个人带偏
COMMENT ON COLUMN public.sheet_music_files.sub_parts IS
  '分声部号（升序去重，**恒非 NULL**）。一份文件覆盖多个分声部时全部列出，如 Horn_1,2,3,4 → {1,2,3,4}；没有分声部时是空数组 {}。与 file_name 里派生出的编号分开存，便于区分「识别错」与「文件名生成错」。';

COMMIT;

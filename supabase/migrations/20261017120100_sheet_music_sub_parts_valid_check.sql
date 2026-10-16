-- ============================================
-- 谱务：给 sheet_music_files.sub_parts 补元素级 CHECK
-- ============================================
--
-- `sub_parts`（`INTEGER[] NOT NULL DEFAULT '{}'`，见 20260923140000 / 20260926130000）
-- 此前**没有任何元素级约束**。而「号的规范形态」是三处契约共同声明的一件事：
--
--   · 列说明（20260926130000 写入）：`分声部号（升序去重，恒非 NULL）`
--   · 后端 `supabase/functions/llm-analyze/analyze.test.ts` 有一条不变量用例：
--     「subParts 恒为**升序去重的正整数**数组」（搜这句注释就能定位，别写行号）
--   · 前端 `pkuso-web/src/app/admin/sheet-music/sub-parts.ts` 的两个入口函数各自保证它：
--     `parseSubPartsInput`（用户手输）与 `sanitizeSubParts`（模型响应收敛）
--
-- 但**库这一层一个都没写下来**，全靠上面三处应用层代码各自守 —— 而它们分布在两个仓，
-- 没有任何机制能发现漂移（`sub-parts.ts` 里 `MAX_SUB_PARTS` 那段的注释自己就写着这件事）。
-- 本迁移把那三件事落成一条约束。
--
-- ## 为什么是一个辅助函数，而不是把条件直接写在 CHECK 里
--
-- **CHECK 里不能写子查询**，所以「每个元素都 >= 1」没法写成
-- `NOT EXISTS (SELECT … unnest(…) …)`。只能在 `IMMUTABLE` 的 SQL 函数里做，
-- CHECK 引用它（`public.is_valid_sub_parts(sub_parts)`）。
--
-- ## 三条不变量，以及为什么「去重 / 升序」也入约束
--
-- 1. **每个元素 >= 1** —— 号的合法区间是 `[1, +∞)`。**上界故意不设**：prompt 明写
--    「不要假设最大值」，拍一个上界会把将来合法的号挡在门外。个数上界（32）由应用层守，
--    它属于「识别质量」而不属于「数据合法性」，不进这一层。
-- 2. **无 NULL 元素** —— PG 的数组可以含 NULL 元素，**列的 `NOT NULL` 挡不住它**。
-- 3. **去重 + 升序** —— 不是洁癖：读取侧按 `sub_parts[0]` 排序（前端 `sort-parts.ts`
--    与 `pkuso-mp/src/lib/sheet-music-sort.ts` 的 `f.sub_parts?.[0]`），**升序是那条排序
--    正确的前提**（`{2,1}` 的首元素是 2，会让这一行排错位置）；而重复元素会让同一个号
--    在界面上出现两次、文件名生成出 `圆号1,1.pdf`。两者都是上面三处契约已经声明的形态，
--    所以落成约束而不是留一句提醒。
--
-- ⚠️ **没有把 `MAX_SUB_PARTS`（32）写成 `array_length <= 32`**：那是识别质量的上界，
-- 不是数据合法性。写进来的后果是「库里已有的、超过 32 个号的合法数据」被判非法，
-- 而那种行的正确处理是人工看一眼（见 20260924013000 里「超界的行宁可不填」那段）。
--
-- ## 存量数据：本次实查两个库都满足约束
--
-- 上约束**之前**必须先确认存量数据过得去（否则迁移会红在 `VALIDATE` 那一步）。
-- 本次实查（2026-10-17，dev 与 prod 各跑一次）：
--
--   select count(*) as 总行数,
--          count(*) filter (where exists (select 1 from unnest(sub_parts) e where e is null or e < 1))     as 有非法元素,
--          count(*) filter (where coalesce(array_length(sub_parts,1),0)
--                             <> (select count(distinct e) from unnest(sub_parts) e))                       as 有重复,
--          count(*) filter (where sub_parts is distinct from
--                             (select coalesce(array_agg(e order by e), '{}'::integer[]) from unnest(sub_parts) e)) as 非升序
--   from public.sheet_music_files;
--
-- 两个库的**三个计数都是 0**（prod 90 行、dev 52 行；取值只用到了 `{}` 与单元素 `{1}`…`{4}`）。
-- 判据是**命令**不是上面那句话 —— 部署 prod 之前重跑一遍上面的查询即可。
--
-- ## 写法上的三点
--
-- · **先 `DROP CONSTRAINT IF EXISTS` 再 `ADD`**：本迁移可重入。
--   （⚠️ 已经核过：两个库在这个列上**都没有**任何 CHECK 约束 —— 用下面这条查，
--   所以不存在「同名 / 异名约束并存」的那种漂移，`DROP IF EXISTS` 用固定名字是安全的。
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--      where conrelid = 'public.sheet_music_files'::regclass and contype = 'c';
--    ）
-- · **`NOT VALID` + `VALIDATE` 而不是裸 `ADD`**：`ADD` 那一步不扫全表、不长时间持
--   ACCESS EXCLUSIVE 锁；校验失败时报错也落在 `VALIDATE` 上，看得出是「存量数据不满足」
--   而不是「语句写错了」。两个动作在同一个事务里，`NOT VALID` 只是一个中间态。
-- · **函数带 `SET search_path = ''`**：与仓内既有的 `SECURITY DEFINER` 函数同一套写法。
--   本函数只读入参、只用 pg_catalog 的内建（`pg_catalog` 恒在搜索路径最前，改不了），
--   但写死它能让将来往函数体里加东西时**立刻**暴露未限定的引用。
--
-- 回滚：
--   ALTER TABLE public.sheet_music_files DROP CONSTRAINT IF EXISTS sheet_music_files_sub_parts_check;
--   DROP FUNCTION IF EXISTS public.is_valid_sub_parts(integer[]);

BEGIN;

-- ---------------------------------------------------------------------------
-- 辅助谓词：`sub_parts` 的规范形态（升序去重的正整数，无 NULL 元素）
-- ---------------------------------------------------------------------------
-- ⚠️ **必须 `IMMUTABLE`**：CHECK 里引用的表达式必须是「只由本行各列决定」的 ——
-- 非 IMMUTABLE 的函数放进 CHECK，PG 不报错，但同一行在两次校验里可能得到不同结果
-- （约束就成了一纸空文），而且将来想用这个谓词建索引也不成立。
--
-- ⚠️ **返回值恒为 `true`/`false`，永不返回 NULL**：CHECK 对 NULL 的判定是**放行**，
-- 所以只要这个函数可能返回 NULL，约束就会出现「悄悄不生效」的行。开头的
-- `nums IS NOT NULL AND` 就是为这件事 —— 少了它，`nums` 为 NULL 时整个表达式是 NULL，
-- 而 NULL 在 CHECK 里等于通过。
CREATE OR REPLACE FUNCTION public.is_valid_sub_parts(nums integer[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT
    nums IS NOT NULL
    -- 每个元素都是 >= 1 的非 NULL 整数（一条 NOT EXISTS 同时挡掉 NULL 元素与 0/负数）
    AND NOT EXISTS (
      SELECT 1 FROM unnest(nums) AS e WHERE e IS NULL OR e < 1
    )
    -- 去重：元素个数与去重后的个数相等（空数组两边都是 0，合法）
    AND coalesce(array_length(nums, 1), 0)
        = (SELECT count(DISTINCT e) FROM unnest(nums) AS e)
    -- 升序：数组恒等于它自己排序后的形态（空数组两边都是 `{}`，合法）
    AND nums = (SELECT coalesce(array_agg(e ORDER BY e), '{}'::integer[]) FROM unnest(nums) AS e);
$function$;

COMMENT ON FUNCTION public.is_valid_sub_parts(integer[]) IS
  '分声部号数组是否满足规范形态：升序去重的正整数、无 NULL 元素。服务于 sheet_music_files.sub_parts 的 CHECK，也可用于查询侧预校验。空数组 {} 合法（= 没有分声部）。';

-- ---------------------------------------------------------------------------
-- 约束
-- ---------------------------------------------------------------------------
ALTER TABLE public.sheet_music_files
  DROP CONSTRAINT IF EXISTS sheet_music_files_sub_parts_check;

-- NOT VALID：先只对**新写入的行**生效，不扫存量（也就不会长时间持 ACCESS EXCLUSIVE）
ALTER TABLE public.sheet_music_files
  ADD CONSTRAINT sheet_music_files_sub_parts_check
  CHECK (public.is_valid_sub_parts(sub_parts)) NOT VALID;

-- 再扫一遍存量把它坐实。失败了整个事务回滚，约束不会留下「NOT VALID」的半成品
ALTER TABLE public.sheet_music_files
  VALIDATE CONSTRAINT sheet_music_files_sub_parts_check;

COMMIT;

-- ============================================
-- 谱务：从 file_name 回填 sub_parts
-- ============================================
--
-- 起因：`20260923140000` 只加了列、**不做回填**，于是历史行的 `sub_parts` 全是 NULL。
-- 当时判断「该功能尚无人在实际使用」，但 prod 实测有 33 行真实上传（其中 20 行的
-- `file_name` 里带着分声部号），所以那个前提是错的；而详情页的三级排序
-- （pkuso-web#289）第三级正是按 `sub_parts[0]` 排 —— 不回填的话那一级对存量数据
-- 完全失效，界面上的号看起来「排了但没排」。
--
-- ⚠️ **只碰 `sub_parts IS NULL` 的行。** 三种取值语义不同，混淆会写坏数据：
--
--   NULL  = 「号不在库里」——本迁移之前的历史行，**可回填**
--   {}    = 「没有分声部」——新行的默认值，是一个**肯定**的陈述
--   {1,2} = 已知的号
--
-- 特别注意**窗口期**（后端已上线、前端未改的那段）：那时上传的行，号在文件名里
-- **也没有**（旧前端读 `data.subPart` 拿到 undefined），所以它们匹配不上、会留在
-- NULL —— 那是诚实的：那些号真的丢了，回填不出来。
--
-- 依据：号在 `file_name` 的尾巴上（旧 `generateFileName` 的产物 `F调圆号_3.pdf`）。
-- 与 `20260923140000` 的注释里说的「文件名不是数据」不矛盾 —— 那说的是**不该把
-- 文件名当长期存储**，而这里是**一次性的数据抢救**，抢完就不再看文件名了。
--
-- 回滚：把本迁移写入的行改回 NULL 即可（回滚语句见文件末尾注释）。
--
-- 回填前看一眼影响面（我实测 prod 是 33 行全 NULL、其中 20 行可回填）：
--   select count(*) filter (where sub_parts is null) as 待回填,
--          count(*) filter (where sub_parts is null
--                             and file_name ~ '_[0-9]+(,[0-9]+)*\.pdf$') as 能解析出号
--   from public.sheet_music_files;

BEGIN;

WITH parsed AS (
  SELECT
    id,
    -- 只认**名字尾部**的 `_数字[,数字...].pdf`。放中间会误抓乐器名里的数字
    -- （如 `降B调小号_1.pdf` 的 `B`、或 `PMLASIA01165-13-Horn_2.pdf` 里的 `01165-13`）。
    (regexp_match(file_name, '_([0-9]+(?:,[0-9]+)*)\.pdf$'))[1] AS nums
  FROM public.sheet_music_files
  WHERE sub_parts IS NULL
    AND file_name ~ '_[0-9]+(,[0-9]+)*\.pdf$'
),
expanded AS (
  SELECT
    id,
    -- 去重 + 升序：与前后端 `parseSubParts` 的规范形态一致（契约：升序去重的正整数）
    (SELECT array_agg(DISTINCT n::integer ORDER BY n::integer)
       FROM unnest(string_to_array(parsed.nums, ',')) AS n) AS arr
  FROM parsed
  WHERE parsed.nums IS NOT NULL
)
UPDATE public.sheet_music_files f
SET sub_parts = e.arr
FROM expanded e
WHERE f.id = e.id
  AND e.arr IS NOT NULL
  -- 上界与 `MAX_SUB_PARTS` 同值。**超界的行宁可不填**：写一个契约外的值，
  -- 读侧（文件名生成、排序）会按契约假设它合法，而 `{}` / NULL 至少是诚实的
  -- 「不知道」。真出现这种行，人工看一眼比自动写坏好。
  AND array_length(e.arr, 1) BETWEEN 1 AND 32;

COMMIT;

-- 回填后核对（应看到「可回填」那批已经变成有值的，其余仍是 NULL）：
--   select sub_parts, count(*) from public.sheet_music_files group by 1 order by 1;
--   select file_name, sub_parts from public.sheet_music_files
--    where file_name ~ '_[0-9]+(,[0-9]+)*\.pdf$' order by file_name;
--
-- 回滚（只回滚本迁移写进去的那批 —— 即「文件名里有号」的行）：
--   UPDATE public.sheet_music_files SET sub_parts = NULL
--    WHERE file_name ~ '_[0-9]+(,[0-9]+)*\.pdf$';

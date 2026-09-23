-- ============================================
-- 谱务：分声部号改为数组，并落库
-- ============================================
--
-- 起因（见 pkuso-backend#15）：真实谱子里大量存在「一份文件覆盖多个分声部」——
--
--   IMSLP807975-...-_Horn_1,_2,_3,_4.pdf     4 个圆号订成一份，19 页
--   IMSLP807971-...-_Piccolo,_Flute_1,_2.pdf
--   IMSLP807972-...-_Oboe_1,_2.pdf
--
-- 识别契约里原本是 `subPart: number | null`（单个数字），表达不了它：
-- 模型返 `1` 会存成「圆号 1」（**错**，那份含 1-4），返 `"1,2,3,4"` 会整串丢掉。
--
-- 更要紧的是**它从来没有落过库**：分声部号此前只活在 `sheet_music_files.file_name`
-- 这个字符串里（`F调圆号_3.pdf`）。于是详情页刷新后拿不到分声部，
-- 排序、显示、将来的发谱都无从谈起 —— 文件名不是数据。
--
-- ⚠️ 本迁移只**加列**，不动 `file_name`、不动旧列。回滚：
--   ALTER TABLE public.sheet_music_files DROP COLUMN sub_parts;
--
-- ⚠️ **必须与 pkuso-web 的读写改动同批上线 —— 两种顺序单独上都坏，且坏法不同：**
--
--  · **前端先上**（列还没到）：前端写 `sub_parts`，而 **prod 的迁移是手动触发的**
--    （dev 才是推 main 自动同步）。PostgREST 会因未知列拒掉整条 insert ——
--    **不是少一个字段，是那行记录根本传不上去**（错误码按 PostgREST 惯例是 PGRST204）。
--    另注：`storage.upload` 发生在 `insert` **之前**，所以每次失败都会在 bucket 里
--    留下一个孤儿对象（同一行的重试复用 storageId，只留一个、不累积），而详情页看不到它。
--
--  · **后端先上**（本迁移 + 新 llm-analyze 到了 prod，前端还没改）：**号会静默丢掉**。
--    新后端返回的是 `subParts`（数组），而现网前端读的是 `data.subPart`（单数）——
--    取到 `undefined` → `?? null` → `generateFileName(instrument, null)`：
--    文件名里连号都没了，而这一列前端又还没开始写。
--    **这条比上一条隐蔽**：上传看起来完全成功，号却**哪儿都没留下** ——
--    既不在 `file_name`，也不在 `sub_parts`，事后补不回来。
--
-- 所以只能是**同批**。「合了 main」≠「后端已上线」—— prod 要走 `Deploy to Prod`
-- （`workflow_dispatch`，需手输 `deploy`），别把前者当成后者。
--
-- 关于回填：本迁移**不做回填**。窗口期之前的行留 NULL —— 这里的 NULL 是
-- 「号不在库里」，恰恰属于**可恢复**的那一类：依据就躺在 `file_name` 里（`_3` / `_1,2`），
-- 需要时另开一个迁移回填。所以别把 NULL 与 `{}` 混为一谈。
--
-- ⚠️ 这段注释此前写着「该功能尚无人在实际使用，窗口期已确认无所谓」——**那是错的**，
-- 现网已经有一整套带号上传的真实数据。判断窗口期风险请**查数据**，不要靠「应该没人用」：
--   select count(*) filter (where file_name ~ '_[0-9]') from public.sheet_music_files;
-- （注：日常读库的 MCP 连的是 **prod**，所以这条能直接反映线上。）

BEGIN;

-- 用 INTEGER[] 而不是逗号串：号码是有序整数集合，排序要按首元素比较
-- （详情页的三级排序见 pkuso-web#289），数组能直接用，字符串还要再切一遍。
ALTER TABLE public.sheet_music_files ADD COLUMN sub_parts INTEGER[];

-- 默认空数组。契约是「`{}` = 没有分声部；NULL 只出现在本迁移之前的历史行上」，
-- 而只 ADD COLUMN 不设默认的话，**窗口期里由旧前端写入的新行也会是 NULL**，
-- 于是 NULL 把两种语义不同的行混成一类（历史行：号还在 `file_name` 里，可补；
-- 窗口行：号已经丢了，补不回来），上面那句不变量当场失效。
--
-- 拆成两条语句正是为了让两个语义各自成立：ADD COLUMN 不带默认值 → 已有行留 NULL；
-- SET DEFAULT → 之后的新行是 `{}`（不再依赖「写的人记得带上这一列」这种纪律）。
-- 想显式写 NULL 的调用方仍然写得进去。
ALTER TABLE public.sheet_music_files ALTER COLUMN sub_parts SET DEFAULT '{}'::integer[];

COMMENT ON COLUMN public.sheet_music_files.sub_parts IS
  '分声部号（升序去重）。一份文件覆盖多个分声部时全部列出，如 Horn_1,2,3,4 → {1,2,3,4}。与 file_name 里派生出的编号分开存，便于区分「识别错」与「文件名生成错」。【新行默认为空数组 {} = 没有分声部；NULL = 「号不在库里」（本迁移之前的历史行），与「没有分声部」不是一回事 —— 读取侧两种都要兜。】';

COMMIT;

-- ============================================
-- 谱务：删掉已废弃的 sheet_music_parts.instrument
-- ============================================
--
-- 收尾 20260923000000 那条「只加列、不删列」的迁移。当时不删列，是为了让两个仓库的
-- 部署顺序无关紧要：旧版前端按 instrument 分组写、新版只写 section。**那个窗口期已经结束**：
--
--   · pkuso-web#283 已关闭 —— 那条迁移的 COMMENT 里写着「待 pkuso-web#283 上线后由独立
--     迁移回填并删除」，这就是那条独立迁移
--   · 旧版前端早已不在线上（#286 已部署）
--   · 两仓现在同版本（函数契约与词表都是同一份）
--
-- 三步，顺序不能换（删完列就无从回填了）：回填 → 收 NOT NULL → 删列。
--
-- **回填规则**：section 为空的行都出自过渡期的旧前端 —— 它把「声部」写在 instrument 里，
-- 而同一个列上还躺过中文乐器名与英文 `Violin`（见 20260923000000 里那段「不丢数据但会留痕」
-- 的说明）。所以只有**恰好是标准声部之一**时才照抄（16 个声部 + 「总谱」，后者见下面那段的说明），
-- 其余一律落「其他」—— 「其他」是契约里合法的弃权声部，用户可以在详情页改。
--
-- ⚠️ 那份名字清单在这里是**第三份副本**（另两份是 pkuso-web 的 `INSTRUMENT_ORDER` 与
-- pkuso-backend 的 `SECTIONS`；「总谱」不在那两份里，它是 `FULL_SCORE_SECTION`）。这里可以照抄：**迁移是不可变快照**，不会再随词表增长而腐烂；
-- 反过来也**别把它当成运行时的事实来源**。
--
-- ⚠️ 写这次回填前实测过 prod（要复现就跑）：
--     select count(*) filter (where section is null)        as section_null,
--            count(*) filter (where instrument is not null) as instrument_notnull
--     from public.sheet_music_parts;
--   结果是 section 全非空、instrument **全为 NULL**，也就是这次回填在 prod 上是 0 行。
--   仍然写它，是因为 **dev 读不到**（MCP 连的是 prod），它上面可能留着过渡期的行，
--   而「删列之前不抢救」是不可逆的。
--
-- ⚠️ 删列之后，任何**还在按旧契约写 instrument 的客户端**会**响亮地失败**（PostgREST 会因
-- payload 里的未知列回 PGRST204：`Could not find the 'instrument' column of
-- 'sheet_music_parts' in the schema cache`）—— 这正是可以接受它的原因：那种客户端
-- 已经不存在了（见上面那段数据侧的证据链）。
--
-- 回滚（**是近似的**，别当成逐字还原）：
--   ALTER TABLE public.sheet_music_parts ADD COLUMN instrument TEXT NOT NULL DEFAULT '';  -- 原文 NOT NULL（无默认值）
--   ALTER TABLE public.sheet_music_parts ALTER COLUMN section DROP NOT NULL;
--   COMMENT ON COLUMN public.sheet_music_parts.instrument IS '【已废弃】…';                -- 原文见 20260923000000
-- 哪些东西**回不来**：`instrument` 里的值在 DROP 时就丢了（prod 上本来就全 NULL，所以
-- 实际没丢东西）；真正回不来的是 **`section` 这一侧的 NULL 信息** —— 回填把「本来没有声部」
-- 写成了具体值（照抄或「其他」），而 NULL 与否没有被任何列记下来，`DROP NOT NULL` 也读不回
-- 「哪几行原本是空的」。所以回滚只是让 schema 长得像，语义上是新的起点。

BEGIN;

-- 1. 回填（prod 上是空操作，见上面那段）
--
-- ⚠️ 闭集里**必须有「总谱」**（它不在 `SECTIONS` 里，因为它是「整份都在里面」的标记而不是
-- 声部 —— 但它**是 `section` 的合法值**：前端 `isKnownSection()` 认它、排序给它排最前，
-- 后端 `FULL_SCORE_SECTION` 也是同一个词，prod 上就已经有 1 行是这个值）。
-- 漏掉它的话，`instrument = '总谱'` 的过渡期行会被 `ELSE` 判成「其他」—— 而「总谱」是
-- 「不参与切分检测」那个**唯一人工标记入口**，落成「其他」之后再没有列能分辨它。
UPDATE public.sheet_music_parts
SET section = CASE
  WHEN instrument IN (
    '第一小提琴', '第二小提琴', '中提琴', '大提琴', '低音提琴',
    '长笛', '双簧管', '单簧管', '大管', '圆号', '小号', '长号', '大号',
    '打击乐', '键盘', '竖琴', '总谱'
  ) THEN instrument
  ELSE '其他'
END
WHERE section IS NULL;

-- 2. section 从此**必填**：它是详情页分组与落库的键，空值没有任何含义
--    （前端 `getOrCreatePart` 一直传的是非空声部，所以这一步不会拒掉任何合法写入）
ALTER TABLE public.sheet_music_parts ALTER COLUMN section SET NOT NULL;

-- 3. 「一首曲子里一个声部只有一行」—— 把这条**本就存在的不变量**用唯一索引钉住。
--
-- 它不是为了回填才加的，但回填正是能把它打破的东西：上面那个 `ELSE '其他'` 会把同一首曲子里
-- 若干过渡期行**塌成同一个「其他」**。而没有这条索引时，`getOrCreatePart` 的
-- 「先 SELECT 再 INSERT」会坏掉 —— 它用 `.maybeSingle()`，命中**两行以上**时 PostgREST
-- 回的是 error（PGRST116）而不是 data，而调用点 `const { data: existing }` **把 error 丢掉了**
-- → 于是每次都当「不存在」再插一行，**越传越多**。今天库里没有反例（查过没有重复的
-- (sheet_music_id, section)），所以现在加是安全的。
ALTER TABLE public.sheet_music_parts
  ADD CONSTRAINT sheet_music_parts_score_section_key UNIQUE (sheet_music_id, section);

-- 4. 删列
ALTER TABLE public.sheet_music_parts DROP COLUMN instrument;

COMMIT;

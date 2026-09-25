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
-- 的说明）。所以只有**恰好是 16 声部之一**时才照抄，其余一律落「其他」—— 「其他」是契约里
-- 合法的弃权声部，用户可以在详情页改。
--
-- ⚠️ 那 16 个名字在这里是**第三份副本**（另两份是 pkuso-web 的 `INSTRUMENT_ORDER` 与
-- pkuso-backend 的 `SECTIONS`）。这里可以照抄：**迁移是不可变快照**，不会再随词表增长而腐烂；
-- 反过来也**别把它当成运行时的事实来源**。
--
-- ⚠️ 写这次回填前实测过 prod（要复现就跑）：
--     select count(*) filter (where section is null)           as section_null,
--            count(*) filter (where instrument is not null)    as instrument_notnull
--     from public.sheet_music_parts;
--   结果是 section 全非空、instrument **全为 NULL**，也就是这次回填在 prod 上是 0 行。
--   仍然写它，是因为 dev 上可能留着过渡期的行，而「删列之前不抢救」是不可逆的。
--
-- ⚠️ 删列之后，任何**还在按旧契约写 instrument 的客户端**会在 `getOrCreatePart()` 处
-- 直接报 `column "instrument" does not exist`（**响亮的失败**，不是静默降级）—— 这正是
-- 可以接受它的原因：那种客户端已经不存在了。
--
-- 回滚（列能回来，**数据回不来** —— instrument 里的值在 DROP 时就丢了）：
--   ALTER TABLE public.sheet_music_parts ADD COLUMN instrument TEXT;
--   ALTER TABLE public.sheet_music_parts ALTER COLUMN section DROP NOT NULL;

BEGIN;

-- 1. 回填（prod 上是空操作，见上面那段）
UPDATE public.sheet_music_parts
SET section = CASE
  WHEN instrument IN (
    '第一小提琴', '第二小提琴', '中提琴', '大提琴', '低音提琴',
    '长笛', '双簧管', '单簧管', '大管', '圆号', '小号', '长号', '大号',
    '打击乐', '键盘', '竖琴'
  ) THEN instrument
  ELSE '其他'
END
WHERE section IS NULL;

-- 2. section 从此**必填**：它是详情页分组与落库的键，空值没有任何含义
--    （前端 `getOrCreatePart` 一直传的是非空声部，所以这一步不会拒掉任何合法写入）
ALTER TABLE public.sheet_music_parts ALTER COLUMN section SET NOT NULL;

-- 3. 删列
ALTER TABLE public.sheet_music_parts DROP COLUMN instrument;

COMMIT;

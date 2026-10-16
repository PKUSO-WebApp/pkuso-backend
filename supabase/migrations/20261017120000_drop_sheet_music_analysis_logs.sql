-- ============================================
-- 谱务：删掉死表 sheet_music_analysis_logs
-- ============================================
--
-- 这张表由 20260922000001 建立，此后**没有任何写入方、也没有任何读取方**：
--
--   · 行数：两个库都是 0
--       select count(*) from public.sheet_music_analysis_logs;
--   · 全仓引用：pkuso-backend / pkuso-web / pkuso-mp 三个仓里，运行时代码**零命中** ——
--       除了这张表的建表语句与自动生成的 `types/database.types.ts`，
--       它只出现在 pkuso-web 的 `AGENTS.md` 数据表清单里（本次一并改掉）。
--
-- **它最坏的地方不是占空间，是「一张名字里写着 logs 的空表」会让人以为有分析日志可查。**
-- 谱务这条链路恰恰最需要观测（一次分析 = 几十次 llm-analyze + ocr-analyze + segment-parts
-- 调用，成本几乎全在调用次数上），而一张恒空的表给出的信号正好相反。
-- 真要做观测应当按「要看什么」重新设计（记被拒的切点、记 prompt 版本……），
-- 而不是留着这张当年顺手建的宽表 —— 那属于另一条 issue，本迁移只负责不让它继续以
-- 「死表」的形态存在。
--
-- ⚠️ **DEPENDENCY 已核**（两个库各查一次，写在这里是为了下一个人能复现，不是流程要求）：
--
--   select d.classid::regclass::text as 依赖方类别, d.objid::regclass::text as 依赖方, d.deptype
--   from pg_depend d
--   where d.refobjid = 'public.sheet_music_analysis_logs'::regclass
--     and d.classid <> 'pg_class'::regclass::oid;
--
-- 结果只有它**自己**的东西（`pg_type` / 两条 `pg_policy` / 两个 `pg_attrdef` / 一条
-- `pg_constraint`），没有任何视图或函数引用它。索引、RLS 策略、行类型都是表的
-- auto-dependent，`DROP TABLE` 会一并带走，**不需要 CASCADE**。
--
-- ⚠️ **故意不写 `CASCADE`**：本仓上一次删表（20260919000000）带了它，那是因为当时真有外部
-- 依赖。这里没有，而加上它只有一个后果 —— 万一将来有人建了个引用本表的视图，`CASCADE`
-- 会**静默**把它一起删掉（不可逆），不带则会当场报错、由人来看一眼。两个方向的代价不对称，
-- 往保守那边倒。
--
-- ⚠️ **故意写 `IF EXISTS`**：本迁移可重入。表名已对两个库核过，这里不是为了容忍笔误，
-- 是为了让「万一某个环境已经先删过」不至于把整批 `db push` 卡红。
--
-- 回滚（把 20260922000001 里那段原样贴回来即可 —— 表结构、RLS 与两条策略）：
--
--   CREATE TABLE sheet_music_analysis_logs (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     file_name TEXT NOT NULL,
--     extracted_text TEXT,
--     llm_result JSONB,
--     user_correction JSONB,
--     created_at TIMESTAMPTZ DEFAULT now()
--   );
--   ALTER TABLE sheet_music_analysis_logs ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "管理员可查看分析日志" ON sheet_music_analysis_logs FOR SELECT USING (is_admin());
--   CREATE POLICY "系统可插入分析日志" ON sheet_music_analysis_logs FOR INSERT WITH CHECK (true);
--
--   （回滚只把**结构**还回来，行回不来 —— 本来也没有行。）

BEGIN;

DROP TABLE IF EXISTS public.sheet_music_analysis_logs;

COMMIT;

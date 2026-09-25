-- ============================================
-- 谱务：同一 part 下文件名唯一（让「响应丢了再重试」幂等）
-- ============================================
--
-- 起因（见 pkuso-backend#29）：上传是 `storage.upload`（upsert）+ `sheet_music_files.insert`。
-- **请求已经提交、而响应在路上丢了**（网关 504 / 断网）时，客户端只知道失败 ——
-- 用户再点一次「确认上传」，同一个 `storageId` 算出同一批路径（storage 那边 upsert，
-- 不产生新对象），而 `insert` 会**再插一遍行**。于是库里出现两份内容相同的记录，
-- 详情页当成两份谱，而**事后无法分辨哪行是多的**（`storage_path` 也相同）。
--
-- ⚠️ 前端已有的「一次批量 insert 而不是循环 N 次」只挡住**部分提交**那一半
--（单条多行 INSERT 在 PG 里是原子的），**挡不住这一半** —— 那边代码的注释里写明了。
--
-- 约束形态选 `(part_id, file_name)` 而不是 `(storage_path)`：前者顺带表达了一条产品规则
-- ——**同一个声部下不该有两份同名的谱**（详情页会出现分不清的两行；前端 `duplicatedInGroup`
-- 在「同一次拆分」的范围内已经在拦同一件事）。`storage_path` 只表达「这一次上传」的身份，
-- 拦不住「不同源文件恰好生成同一个名字」。
--
-- ⚠️ **加约束前必须先确认库里没有重复**，否则整条迁移失败。日常读库的 MCP 连的是 **prod**，
--    所以下面这条直接反映线上（2026-09-25 实查：33 行，两种键都是 0 个重复组，无 NULL）：
--      select count(*) from public.sheet_music_files;                                  -- 总行数
--      select part_id, file_name, count(*) from public.sheet_music_files
--        group by 1,2 having count(*)>1;                                               -- 应为空
--
-- ⚠️ **这是行为变更，不只是兜底**：今天「同一 part 下两个不同源文件恰好生成同一个
--    `file_name`」是能传上去的（详情页出现两行同名），加约束之后**那一次批量 insert 会整体失败**。
--    所以前端必须把这种失败翻译成用户看得懂的话（「这一声部下已有同名文件」），
--    而不是把 PG 的原始报文甩出去 —— 见 pkuso-web 那边的配套改动。
--
-- ⚠️ **顺序：本迁移先上，前端的 `upsert(onConflict)` 随后** —— 不能反过来。
--    PostgREST 的 `on_conflict=part_id,file_name` 要求**匹配的唯一索引已经存在**，
--    否则 PG 直接报 42P10（no unique or exclusion constraint matching the ON CONFLICT
--    specification），前端那条路当场就走不通。
--    窗口期（约束已上、前端未上）里，重试会从「静默插重复行」变成「报一个唯一冲突」——
--    **不比现状差**：文件其实已经在库里了，只是用户看到一句错。窗口只有一次部署那么长。
--
-- ⚠️ `part_id` 可为 NULL，而唯一索引**默认把 NULL 视作互不相同** —— 也就是说
--    `part_id IS NULL` 的行不受本约束保护。今天这类行有 0 条，且前端每条都带 part_id
--    （`getOrCreatePart(section)`），所以不额外处理；哪天要有 NULL 行，得改成
--    `UNIQUE NULLS NOT DISTINCT (part_id, file_name)`（PG 15+）。
--
-- 回滚：
--   ALTER TABLE public.sheet_music_files
--     DROP CONSTRAINT sheet_music_files_part_id_file_name_key;

BEGIN;

ALTER TABLE public.sheet_music_files
  ADD CONSTRAINT sheet_music_files_part_id_file_name_key
  UNIQUE (part_id, file_name);

COMMIT;

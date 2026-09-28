-- 客户端错误记录：补一列客户端生成的稳定 id，让**补送变成幂等**
--
-- 背景：pkuso-mp 的 flushErrorQueue 是「至少一次投递」——只有拿到响应才 removeSent；
-- 插入其实已提交、但响应丢失或中断时（postgrest 的网络失败会 resolve 出 status:0），
-- 整队被保留，下次 flush 把同一批再 INSERT 一遍。而本表没有任何去重约束
-- （id 是插入时新生成的 identity），于是同一条错误在库里出现两行。
-- 生产库实测已发生过：96 行里有 21 组是完全重复的（created_at/event/message 全同，
-- 一行 user_id 为空、一行带 user_id——正是「未登录时投递失败、登录后重投」的形状）。
--
-- 为什么现在必须修：同一批改动给 taroFetch 加了 8 秒超时。超时会把
-- 「慢但成功」的插入误判成失败 → 队列保留 → 下次重复插入。
-- **也就是说那次改动会主动抬高这张表的重复率**，不补这一刀就是明知故犯。
--
-- 契约：
-- - client_id 由**客户端**为每条记录生成一次、随本地队列持久化，补送时复用同一个值；
--   upsert 以它为冲突目标，重复补送变成 no-op。
-- - 旧版本客户端不传该列 → 由 default 兜底（等于退回「不去重」），不会因此插入失败。
--   所以这个改动对已发布的版本是**纯兼容**的，不需要两端同时上线。
--
-- 索引取舍：建表那支的注释写着「仅两个索引…不建第三个」。这里**有意破例**——
-- 唯一约束必然带一个索引，而幂等只能由库端保证（客户端说了不算：重复的根源就是
-- 客户端没收到响应）。代价是一个 uuid 索引，在 90 天保留 + 现有量级下可忽略。

ALTER TABLE public.client_error_logs
  ADD COLUMN client_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.client_error_logs
  ADD CONSTRAINT client_error_logs_client_id_key UNIQUE (client_id);

COMMENT ON COLUMN public.client_error_logs.client_id IS
  '客户端为每条记录生成的稳定 id（随本地队列持久化）。补送幂等靠它：客户端 upsert 时以它为 on_conflict 目标。旧客户端不传时由 default 兜底。';

-- 表级 GRANT INSERT 覆盖新增列，无需再授一次。
-- RLS 亦无需改：ignoreDuplicates 走的是 ON CONFLICT DO NOTHING，不读冲突行，
-- 因此不需要（也不该有）这张表的 SELECT 权限。

-- 回滚：
-- ALTER TABLE public.client_error_logs DROP CONSTRAINT client_error_logs_client_id_key;
-- ALTER TABLE public.client_error_logs DROP COLUMN client_id;

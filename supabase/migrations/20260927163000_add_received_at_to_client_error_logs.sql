-- 客户端错误记录：补一列「入库时刻」
--
-- 背景：created_at 由客户端按**错误发生时刻**写入（断网补送时也带原时刻，这是刻意的），
-- 于是库里看到的永远是发生时间——一条记录究竟是当场送达、还是断网后补送的，
-- 从数据上分不出来。而这恰恰是排查网络故障时最想知道的事：
-- 「发生 23:40、入库次日 01:10」的差值本身就是断网时段的直接证据。
--
-- 该列只由库端默认值填充，客户端不传（QueueItem 里没有这个字段）；
-- 即便客户端误传，`default now()` 也只在未提供时生效——但这不是依赖点，
-- 真正的保证是客户端不上报该列。

ALTER TABLE public.client_error_logs
  ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.client_error_logs.received_at IS
  '库端写入时刻（now()）。与 created_at（客户端上报的发生时刻）之差 = 上报延迟；断网补送时会显著大于 0。';

-- 已有行（如有）是加列前的历史数据，真实入库时刻不可追溯，用 created_at 近似（延迟记 0）
UPDATE public.client_error_logs SET received_at = created_at;

-- 回滚：ALTER TABLE public.client_error_logs DROP COLUMN received_at;

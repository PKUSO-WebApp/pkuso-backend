-- attendances：把「(rehearsal_id, user_id) 唯一」这条约束**落到仓库里**
--
-- ## 为什么需要这一刀
--
-- 这条约束在 prod 上存在（`attendances_rehearsal_id_user_id_key`），但**从未被任何
-- migration 定义过** —— 是当年直接在库上建的，没落盘。后果不是「少一条记录」：
--
--   · dev 上**没有**它（2026-09-29 用 MCP 逐个读 `pg_constraint` 核实：dev 只有
--     PK + 两条 FK，共 3 条；prod 有 5 条）。
--   · 而三个 migration 里的 RPC 以**名字**引用它做冲突目标：
--       pkuso-web/supabase/migrations/20260826130000_rehearsal_checkin_location.sql:122
--       pkuso-web/supabase/migrations/20260826140000_harden_geo_checkin_and_block_bypass.sql:142
--       pkuso-backend/supabase/migrations/20260927100000_exempt_blocks_sign_in.sql:131
--     （`INSERT … ON CONFLICT ON CONSTRAINT attendances_rehearsal_id_user_id_key`）
--   · plpgsql 到**首次执行**才解析这个目标 ⇒ 建函数时不报错、部署一路绿，
--     于是 **dev 上签到 RPC 一调就报错**（`constraint … does not exist`）。
--
-- 也就是说：这是「仓库不是 schema 事实来源」的直接后果，不是孤立事故。
--
-- ## 契约
--
-- · 若该名字的 UNIQUE 约束已存在（prod 的情形）⇒ **no-op**，不重复建、不报错。
-- · 若不存在（dev 及任何新环境）⇒ 用**同一个名字**建，让上面那三个 RPC 都能解析。
-- · **不做去重**。若某个环境里已经有重复的 (rehearsal_id, user_id)（= 约束缺失期间
--   攒下的脏数据），本 migration 会**直接失败**并让部署变红，而不是静默删掉考勤行。
--   少一次签到可以补，被悄悄删掉的考勤记录没人能发现。真要清，单独写一条 migration
--   并在 PR 描述里写清删了哪些行、凭什么判据保留哪一行。
--
-- 索引取舍：唯一约束自带一个索引。这个索引本来就是 RPC 的冲突目标所需要的
-- （`ON CONFLICT` 必须有唯一索引），不是为了「顺手加索引」。
--
-- 回滚：
--   ALTER TABLE public.attendances DROP CONSTRAINT attendances_rehearsal_id_user_id_key;
--   ⚠️ 但回滚它等于把 dev 的签到再打回「一调就报错」，且 prod 会退回「靠手工建的约束」。

DO $$
DECLARE
  -- 现有 UNIQUE 约束的「列集合」指纹：`{rehearsal_id,user_id}` 这种形状
  -- （`array_agg(attname ORDER BY attname)::text` 的结果，按字母序）。
  -- 为什么不比 `pg_get_constraintdef()` 的字符串：那是**格式化结果**，换个 PG 版本
  -- 或写法就可能不同，而这条判据一旦误判就会 RAISE EXCEPTION ⇒ 挡住 prod 部署。
  -- 按列比是精确的，也没有格式歧义。
  v_wanted constant text := '{rehearsal_id,user_id}';
  v_actual text;
BEGIN
  SELECT array_agg(a.attname ORDER BY a.attname)::text
    INTO v_actual
    FROM pg_constraint c
    JOIN unnest(c.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'public.attendances'::regclass
     AND c.contype = 'u'
     AND c.conname = 'attendances_rehearsal_id_user_id_key';

  IF v_actual IS NULL THEN
    ALTER TABLE public.attendances
      ADD CONSTRAINT attendances_rehearsal_id_user_id_key UNIQUE (rehearsal_id, user_id);
    RAISE NOTICE '已建 attendances_rehearsal_id_user_id_key UNIQUE (rehearsal_id, user_id)';
    RETURN;
  END IF;

  -- 名字撞上了但列不对：**不静默跳过**——那会让三个 RPC 继续以错误的列做冲突目标，
  -- 而「跳过」会让这次部署看起来是绿的。
  IF v_actual <> v_wanted THEN
    RAISE EXCEPTION
      'attendances_rehearsal_id_user_id_key 已存在但列是 %，与 RPC 期望的 % 不符',
      v_actual, v_wanted;
  END IF;

  -- 名字对、列也对 ⇒ 目标已达成。prod 就落在这一支（这条约束本就存在，只是从未落盘）。
  RAISE NOTICE 'attendances_rehearsal_id_user_id_key 已存在且列正确（%），跳过', v_actual;
END $$;

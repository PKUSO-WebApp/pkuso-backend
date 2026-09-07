-- Migration: Clean up all old overloaded versions of verify_and_use_invitation_code
-- Issue: #69
-- Reason: 旧版本函数参数类型不确定，使用 DO 块动态查找并删除所有多参数重载版本
--         只保留单参数版本 (p_code text)
-- Rollback: 无需回滚（删除的是旧版本函数，新版本仍在）

BEGIN;

DO $$
DECLARE
  rec record;
BEGIN
  -- 查找所有名为 verify_and_use_invitation_code 且参数数量 != 1 的函数
  FOR rec IN
    SELECT
      p.oid::regprocedure AS func_signature,
      format('DROP FUNCTION IF EXISTS %s;', p.oid::regprocedure) AS drop_stmt
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'verify_and_use_invitation_code'
      AND array_length(p.proargtypes, 1) != 1
  LOOP
    EXECUTE rec.drop_stmt;
    RAISE NOTICE 'Dropped old function: %', rec.func_signature;
  END LOOP;
END $$;

COMMIT;

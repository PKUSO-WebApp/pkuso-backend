-- Issue #171 返工：updated_fields 改为累积语义（自创建以来改动字段的并集）
-- 追加式修复，不修改 20260816100000_add_rehearsals_updated_fields.sql
BEGIN;

-- 累积语义：badge 持续展示至排练结束，多次编辑改不同字段时需保留
-- 全部历史变更字段（并集），而非仅本次差集
CREATE OR REPLACE FUNCTION public.function_set_rehearsals_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    -- 变更字段细分（Issue #171，累积）：CASE 条件并入对现有值的 OR，
    -- 已记录过的字段在后续编辑中持续保留
    NEW.updated_fields := array_to_string(
        ARRAY[
            CASE WHEN NEW.start_time IS DISTINCT FROM OLD.start_time
                   OR NEW.end_time IS DISTINCT FROM OLD.end_time
                   OR OLD.updated_fields LIKE '%time%' THEN 'time' END,
            CASE WHEN NEW.location IS DISTINCT FROM OLD.location
                   OR OLD.updated_fields LIKE '%location%' THEN 'location' END,
            CASE WHEN NEW.repertoire IS DISTINCT FROM OLD.repertoire
                   OR OLD.updated_fields LIKE '%repertoire%' THEN 'repertoire' END
        ], ','
    );
    -- 无细分字段变更（如仅改 sign_in_code）时写 'other' 哨兵，
    -- 与存量行（NULL）区分——避免误触发全量兜底文案；
    -- 已有细分字段则保留原值
    IF NEW.updated_fields = '' THEN
        NEW.updated_fields := CASE WHEN OLD.updated_fields IS NULL THEN 'other' ELSE OLD.updated_fields END;
    END IF;
    RETURN NEW;
END;
$function$;

COMMIT;

-- 触发器语义收窄（Issue #173 返工 1）：仅 time/location/repertoire 实际变化
-- 才视为"编辑排练信息"——签到码/类型/声部等变更不刷新 updated_at、
-- 不写入 updated_fields，因此不置顶、不产生「更新排练」提醒
-- 'other' 哨兵在新语义下不再产生；存量 'other' 行由前端防御兼容，无需回填。
-- 追加式修改，不修改 20260816100000_add_rehearsals_updated_fields.sql
-- 与 20260816151503_fix_updated_fields_cumulative.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.function_set_rehearsals_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.start_time IS DISTINCT FROM OLD.start_time
       OR NEW.end_time IS DISTINCT FROM OLD.end_time
       OR NEW.location IS DISTINCT FROM OLD.location
       OR NEW.repertoire IS DISTINCT FROM OLD.repertoire THEN
        NEW.updated_at = now();
        -- 累积并集语义保持（多次编辑改不同字段不丢字段）
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
    END IF;
    RETURN NEW;
END;
$function$;

COMMIT;

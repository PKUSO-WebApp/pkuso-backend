-- 排练更新字段细分（Issue #171）：记录每次更新改动了哪些字段
-- 存量行为 null 表示从未更新（与 updated_at=created_at 的既有语义兼容）
BEGIN;

ALTER TABLE rehearsals ADD COLUMN updated_fields text;

-- 既有触发器函数：保留 updated_at 刷新逻辑，新增字段细分写入
CREATE OR REPLACE FUNCTION public.function_set_rehearsals_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    -- 变更字段细分（Issue #171）：按字段记录本次更新改动了哪些内容
    NEW.updated_fields := array_to_string(
        ARRAY[
            CASE WHEN NEW.start_time IS DISTINCT FROM OLD.start_time
                 OR NEW.end_time IS DISTINCT FROM OLD.end_time THEN 'time' END,
            CASE WHEN NEW.location IS DISTINCT FROM OLD.location THEN 'location' END,
            CASE WHEN NEW.repertoire IS DISTINCT FROM OLD.repertoire THEN 'repertoire' END
        ], ','
    );
    -- 无字段变更（如仅改其他列）时保持 null
    IF NEW.updated_fields = '' THEN
        NEW.updated_fields := NULL;
    END IF;
    RETURN NEW;
END;
$function$;

COMMIT;

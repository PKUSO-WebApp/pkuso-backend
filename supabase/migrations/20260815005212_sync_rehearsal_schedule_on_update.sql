-- 排练改时间时同步影子预约（Issue #136）
-- 原触发器仅 AFTER INSERT：编辑排练后 schedules 影子行停留旧时间
-- 扩展为 INSERT OR UPDATE OF start_time, end_time，UPDATE 时同步影子行，
-- 无影子行（历史排练）则补建；同时将触发器/函数补进 migration 历史
BEGIN;

CREATE OR REPLACE FUNCTION public.function_rehearsal_to_schedule()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- 防御：排练未设置时间时不生成/更新影子预约（schedules.start_time 为 NOT NULL）
    IF NEW.start_time IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO schedules (start_time, end_time, author_id, title, rehearsal_id)
        VALUES (NEW.start_time::timestamp, NEW.end_time::timestamp, NULL, '排练', NEW.id);
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE schedules
           SET start_time = NEW.start_time::timestamp,
               end_time = NEW.end_time::timestamp
         WHERE rehearsal_id = NEW.id;
        IF NOT FOUND THEN
            INSERT INTO schedules (start_time, end_time, author_id, title, rehearsal_id)
            VALUES (NEW.start_time::timestamp, NEW.end_time::timestamp, NULL, '排练', NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_rehearsal_to_schedule ON rehearsals;
CREATE TRIGGER trigger_rehearsal_to_schedule
AFTER INSERT OR UPDATE OF start_time, end_time
ON rehearsals
FOR EACH ROW EXECUTE FUNCTION function_rehearsal_to_schedule();

COMMIT;

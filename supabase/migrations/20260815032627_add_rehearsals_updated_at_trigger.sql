-- 排练编辑时自动刷新 updated_at（Issue #140）
-- 统一由数据库时钟写入，避免客户端时钟漂移导致「更新」提示假阴性
BEGIN;

CREATE OR REPLACE FUNCTION public.function_set_rehearsals_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_set_rehearsals_updated_at ON rehearsals;
CREATE TRIGGER trigger_set_rehearsals_updated_at
BEFORE UPDATE ON rehearsals
FOR EACH ROW EXECUTE FUNCTION function_set_rehearsals_updated_at();

COMMIT;

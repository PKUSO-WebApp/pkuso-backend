-- 锁定归属（locked_by）：替代 Issue #212 的 admin-only 限制触发器。
-- 语义：上锁按操作者写 user/admin；重复锁定一律拒绝；
--       解锁仅归属者本人，他人之锁分别报「帖子被用户/管理员锁定，无法解锁」。
BEGIN;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_locked_by_check;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_locked_by_check CHECK (locked_by IN ('admin','user'));
UPDATE public.posts SET locked_by = 'admin' WHERE is_locked AND locked_by IS NULL;

CREATE OR REPLACE FUNCTION public.function_restrict_posts_is_locked()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE actor_is_admin boolean := public.is_admin();
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.locked_by := CASE WHEN NEW.is_locked THEN
      CASE WHEN actor_is_admin THEN 'admin' ELSE 'user' END ELSE NULL END;
    RETURN NEW;
  END IF;
  IF NEW.is_locked IS NOT DISTINCT FROM OLD.is_locked
     AND NEW.locked_by IS NOT DISTINCT FROM OLD.locked_by THEN
    RETURN NEW;
  END IF;
  IF OLD.is_locked AND NEW.is_locked THEN RAISE EXCEPTION '帖子已被锁定'; END IF;
  IF NEW.is_locked THEN
    NEW.locked_by := CASE WHEN actor_is_admin THEN 'admin' ELSE 'user' END;
    RETURN NEW;
  END IF;
  IF OLD.locked_by = 'admin' THEN
    IF NOT actor_is_admin THEN RAISE EXCEPTION '帖子被管理员锁定，无法解锁'; END IF;
  ELSE
    IF actor_is_admin AND OLD.author_id <> auth.uid() THEN
      RAISE EXCEPTION '帖子被用户锁定，无法解锁';
    END IF;
    IF NOT actor_is_admin AND OLD.author_id <> auth.uid() THEN
      RAISE EXCEPTION '只有发帖人可以解锁';
    END IF;
  END IF;
  NEW.locked_by := NULL;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trigger_restrict_posts_is_locked ON public.posts;
CREATE TRIGGER trigger_restrict_posts_is_locked
BEFORE INSERT OR UPDATE OF is_locked ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.function_restrict_posts_is_locked();
COMMIT;

-- 锁定归属（locked_by）：替代 Issue #212 的 admin-only 限制触发器。
-- 语义：
--   上锁(未锁→锁)      作者⇒'user' / 管理员⇒'admin'（由触发器按身份写入，不信任客户端）
--   重复锁定(已锁→已锁) 一律拒绝：「帖子已被锁定」
--   解锁(true→false)    仅归属者本人；他人之锁分别报「帖子被用户/管理员锁定，无法解锁」
--   INSERT 自带锁       允许，归属同上（原“创建禁带锁”随双主体语义废止）
BEGIN;

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_locked_by_check;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_locked_by_check CHECK (locked_by IN ('admin','user'));

-- 存量已锁帖归因管理员（历史上仅管理员可锁）
UPDATE public.posts SET locked_by = 'admin' WHERE is_locked AND locked_by IS NULL;

CREATE OR REPLACE FUNCTION public.function_restrict_posts_is_locked()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_is_admin boolean := public.is_admin();
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.locked_by := CASE WHEN NEW.is_locked THEN
      CASE WHEN actor_is_admin THEN 'admin' ELSE 'user' END
    ELSE NULL END;
    RETURN NEW;
  END IF;

  -- 锁定状态与归属均未变化：普通编辑放行
  IF NEW.is_locked IS NOT DISTINCT FROM OLD.is_locked
     AND NEW.locked_by IS NOT DISTINCT FROM OLD.locked_by THEN
    RETURN NEW;
  END IF;

  -- 已锁 → 已锁：重复锁定一律显式拒绝（不分身份）
  IF OLD.is_locked AND NEW.is_locked THEN
    RAISE EXCEPTION '帖子已被锁定';
  END IF;

  -- 未锁 → 锁：按操作者身份写归属
  IF NEW.is_locked THEN
    NEW.locked_by := CASE WHEN actor_is_admin THEN 'admin' ELSE 'user' END;
    RETURN NEW;
  END IF;

  -- 锁 → 未锁：仅归属者本人可解锁
  IF OLD.locked_by = 'admin' THEN
    IF NOT actor_is_admin THEN
      RAISE EXCEPTION '帖子被管理员锁定，无法解锁';
    END IF;
  ELSE
    -- 归属为 user（或历史脏数据无归属，视同受保护）
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
$$;

DROP TRIGGER IF EXISTS trigger_restrict_posts_is_locked ON public.posts;
CREATE TRIGGER trigger_restrict_posts_is_locked
BEFORE INSERT OR UPDATE OF is_locked ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.function_restrict_posts_is_locked();

COMMIT;

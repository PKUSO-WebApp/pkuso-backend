-- 迁移说明：非 admin 禁止修改 posts.is_locked（Issue #212 成员禁止锁定/解锁自己的帖子）
--
-- 背景：
--   posts 现有 RLS「作者或管理员可更新」允许成员更新自己帖子的所有列，
--   包括 is_locked。成员若自行锁定帖子，会绕过管理员对帖子状态的管控
--   （锁帖后成员无法编辑/删除，管理员端用于控制帖子收敛）。
--
-- 实现（选型：BEFORE UPDATE OF is_locked 行触发器 + 触发器函数）：
--   1. 触发器在 RLS 之后执行，只拦截通过 RLS 的更新；不新增/不修改 posts 的
--      RLS 策略，posts 现有「作者或管理员可更新」策略保持不动（成员编辑标题/
--      内容等不受影响）。
--   2. 函数内调用 public.is_admin()（已存在，SECURITY DEFINER，search_path 固定
--      public）判断角色；非 admin 且 is_locked 发生变化 → RAISE EXCEPTION。
--      is_locked 值未变化（NEW IS NOT DISTINCT FROM OLD）时放行，避免无意义拒绝。
--   3. UPDATE OF is_locked 限定仅当语句显式 SET is_locked 列时触发——成员更新
--      标题/内容等其他字段的语句不会触发本触发器（零开销、零误伤）。
--   4. auth.role() = 'service_role' 直接放行：未来若 admin 端经 API route 用
--      service role key 锁帖，不受此限制（当前 admin 浏览器端锁帖走用户 JWT +
--      anon key，由 is_admin() 放行，行为不变）。
--   5. 命名风格与既有触发器一致（trigger_xxx / function_xxx，
--      参考 trigger_set_rehearsals_updated_at / function_set_rehearsals_updated_at）。
--
-- 幂等性：
--   - 函数：CREATE OR REPLACE
--   - 触发器：DROP TRIGGER IF EXISTS + CREATE TRIGGER
-- 回滚：DROP TRIGGER trigger_restrict_posts_is_locked ON public.posts;
--       DROP FUNCTION public.function_restrict_posts_is_locked();
-- 不涉及 schema 变更，gen-types 产物无变化。

BEGIN;

-- ==================== 1. 触发器函数 ====================
CREATE OR REPLACE FUNCTION public.function_restrict_posts_is_locked()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- service_role（API route 服务端操作）直接放行
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- 非 admin 尝试修改 is_locked → 拒绝（中文异常信息）
  IF NOT public.is_admin() AND NEW.is_locked IS DISTINCT FROM OLD.is_locked THEN
    RAISE EXCEPTION '只有管理员可以锁定或解锁帖子';
  END IF;

  RETURN NEW;
END;
$$;

-- ==================== 2. 触发器 ====================
DROP TRIGGER IF EXISTS trigger_restrict_posts_is_locked ON public.posts;

CREATE TRIGGER trigger_restrict_posts_is_locked
BEFORE UPDATE OF is_locked ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.function_restrict_posts_is_locked();

COMMIT;

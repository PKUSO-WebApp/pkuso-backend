-- 多设备同时登录：把「一个用户一个 session_token」换成「每设备一行」。
--
-- 背景（2026-10-13 调查）：服务端**从来没有拦过第二台设备** —— 登录拿到的就是真 Supabase
-- session，三台设备同时持有三份有效会话，服务端一张纸都不反对。现在这套「同时只能一台」
-- 完全是客户端自制的：`profiles.session_token` 是一个**单值列**，谁登录/冷启动就覆写它，
-- 别的设备 15 秒轮询发现不一致就自己弹窗登出（旧设备的 JWT 从头到尾都有效）。
-- 所以这个改动是**加法**，不是去撬一条既有防线。
--
-- ⚠️ 与老机制的并存：`profiles.session_token` 与 `touch_session()` / `get_my_session()`
-- **一个字节都不动**。线上老版本客户端仍走老的（它们之间照旧互相顶号），新客户端走这张表
-- 与新 RPC ⇒ **不需要强制升级、不需要等版本分布**；将来要收掉老的那对 RPC，得先看版本分布。
--
-- 口径（用户 2026-10-13 定）：
--   · **无上限**：不限制同时登录的设备台数（列表里自己看、自己拒绝）；
--   · **登录即信任**：任何设备登录后立即可用；
--   · **可手动「设为不信任」**：在线则被踢下线（客户端自查），**且之后拒绝该设备登录**。
--     所以被拒绝的行**必须保留**（`trusted = false`）—— 那正是「之后不能再登录」与
--     「可恢复」这两件事的判据；删行等于把门拆了；
--   · **永远不能拒绝自己**：在 `set_device_trust` 里硬拦（见那里的注释）。
--
-- 设备身份：客户端本地生成并持久化的随机 id（**不能用 openid** —— 同一个人的手机和平板
-- 是同一个 openid，区分不了）。它拦不住刻意绕过的人（清缓存/重装会生成新 id），
-- 能做的只是让「被动共享」有一道明确的门 —— 这一点写在文档里，别指望它更强。

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_devices (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  device_id text NOT NULL,
  -- 本设备当前的会话令牌：登录/冷启动时轮换。**只标识这一行**，
  -- 不再承担「顶号」判据（判据是 trusted，见上）。
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  -- 展示名（机型 · 系统，客户端给）。用户看的就是它，所以给足长度但防呆截断
  name text NOT NULL DEFAULT '',
  platform text,
  trusted boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id),
  CONSTRAINT user_devices_device_id_len CHECK (char_length(device_id) BETWEEN 8 AND 64)
);

COMMENT ON TABLE public.user_devices IS
  '登录设备（每设备一行）。trusted=false = 被设为不信任：踢下线且拒绝该设备再登录；行保留以便恢复。';
COMMENT ON COLUMN public.user_devices.last_seen_at IS
  '只在登录/冷启动时更新（不做 15 秒心跳写库 —— 那是 5000+ 次写/人/天）。';

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

-- 只读自己的行。**写一律走下面的 SECURITY DEFINER RPC**：这里刻意不给
-- INSERT/UPDATE/DELETE 策略 —— 客户端要是能直接改 `trusted`，那道门就是摆设。
CREATE POLICY user_devices_own_read ON public.user_devices
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Supabase 对新表的默认授权会把 anon / authenticated 都放进来：显式收紧。
-- anon 一行都不该看见（这张表没有「公开可读」的部分）。
REVOKE ALL ON public.user_devices FROM anon;
REVOKE ALL ON public.user_devices FROM authenticated;
GRANT SELECT ON public.user_devices TO authenticated;

-- ---------------------------------------------------------------------------
-- RPC：客户端只经这四个入口读写（与老的那对同风格：SECURITY DEFINER + 空 search_path）
-- ---------------------------------------------------------------------------

-- 登录 / 冷启动：登记或刷新**本设备**这一行，并轮换它自己的 token。
-- 返回本行的 token 与 trusted；被拒绝时**抛异常**（客户端据 message 提示「该设备被拒绝登录」）。
CREATE OR REPLACE FUNCTION public.touch_session_v2(
  p_device_id text,
  p_name text DEFAULT '',
  p_platform text DEFAULT ''
)
RETURNS TABLE (token uuid, trusted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.user_devices;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_device_id IS NULL OR char_length(p_device_id) < 8 OR char_length(p_device_id) > 64 THEN
    RAISE EXCEPTION 'bad_device_id';
  END IF;

  SELECT d.* INTO v_row
  FROM public.user_devices d
  WHERE d.user_id = v_uid AND d.device_id = p_device_id;

  IF NOT FOUND THEN
    INSERT INTO public.user_devices (user_id, device_id, name, platform)
    VALUES (
      v_uid,
      p_device_id,
      left(coalesce(p_name, ''), 64),
      left(coalesce(p_platform, ''), 32)
    )
    RETURNING * INTO v_row;

    -- 新设备登录 ⇒ 给本人落一条通知（用户 2026-10-13 定）。多设备之后「被顶下线」这个
    -- 强信号没有了，这条通知是唯一的补偿：账号被别人登了，至少看得见。
    INSERT INTO public.notifications (user_id, category, title, content)
    VALUES (
      v_uid,
      'system',
      '新设备登录',
      coalesce(nullif(v_row.name, ''), '未知设备')
        || ' 于 '
        || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI')
        || ' 登录了你的账号'
    );
  ELSIF NOT v_row.trusted THEN
    -- 被设为不信任：**之后拒绝该设备登录**（行保留，所以这道门记得住）
    RAISE EXCEPTION 'device_rejected';
  ELSE
    UPDATE public.user_devices d
    SET token = gen_random_uuid(),
        last_seen_at = now(),
        name = left(coalesce(p_name, ''), 64),
        platform = left(coalesce(p_platform, ''), 32)
    WHERE d.user_id = v_uid AND d.device_id = p_device_id
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.token, v_row.trusted;
END;
$function$;

-- 自查（15 秒轮询 + 回前台）：只看**本设备这一行**还在不在、信不信。
-- ⚠️ 是 STABLE + 只读：轮询绝不能写库（`last_seen_at` 只在登录时更新，见上面的注释）。
-- 返回空 = 服务端不认识这个 device_id（新装机/换 id），客户端重新 touch 即可，**不算被踢**；
-- 被踢的判据只有一个：这一行存在且 trusted = false。
CREATE OR REPLACE FUNCTION public.get_my_session_v2(p_device_id text)
RETURNS TABLE (token uuid, trusted boolean, last_seen_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT d.token, d.trusted, d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = auth.uid() AND d.device_id = p_device_id
  LIMIT 1;
$function$;

-- 设置页那份列表：**包含被拒绝的那几台**（要能恢复，就不能把它们藏起来）
CREATE OR REPLACE FUNCTION public.list_my_devices()
RETURNS TABLE (
  device_id text,
  name text,
  platform text,
  trusted boolean,
  created_at timestamptz,
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT d.device_id, d.name, d.platform, d.trusted, d.created_at, d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = auth.uid()
  ORDER BY d.trusted DESC, d.last_seen_at DESC;
$function$;

-- 设为不信任 / 恢复信任。
CREATE OR REPLACE FUNCTION public.set_device_trust(
  p_self_device_id text,
  p_device_id text,
  p_trusted boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  -- ★ 永远不能拒绝自己。真那么做的话：本机当场被踢，而「恢复信任」的入口在设置页里、
  -- 需要先登录 ⇒ 手上只有这一台设备的人会被永久锁在账号外（那台设备从此登不进来）。
  -- 做成**硬约束**而不是靠界面藏按钮：按钮藏得住，藏不住一条直接调用的请求。
  IF p_self_device_id IS NOT DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'cannot_untrust_self';
  END IF;

  UPDATE public.user_devices d
  SET trusted = p_trusted
  WHERE d.user_id = v_uid AND d.device_id = p_device_id;
END;
$function$;

-- 函数授权：与老的那对 RPC 对齐 —— 只有 authenticated 能执行（anon / PUBLIC 一律收回）
REVOKE ALL ON FUNCTION public.touch_session_v2(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_session_v2(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_my_devices() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_device_trust(text, text, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.touch_session_v2(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_session_v2(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_devices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_device_trust(text, text, boolean) TO authenticated;

COMMIT;

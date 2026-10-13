-- 「删除设备」：让一台设备回到「从未登录过」的状态。
--
-- 与「设为不信任」的区别（用户 2026-10-14 定）：
--   · 设为不信任 = **之后一直拒绝**该设备登录（行留着，列表里看得见，可恢复）；
--   · 删除设备   = 从列表里消失、在线则被踢，**下一次它登录时当作新设备**（照发一条
--                  「新设备登录」通知）—— 也就是「我不认识这台，让它忘了我，但下次它
--                  再进来要告诉我」。
--
-- ⚠️ 为什么「删除」不能真的把行删掉：踢人的判据查的就是那一行（`get_my_session_v2` 只看
-- 本设备那一行还在不在、信不信）。行真没了，在线的那台**反而不会被踢**（客户端对「查不到行」
-- 的态度必须是保守的：新装机、存储被清都会查不到行，那时踢人等于把正常用户踢下线）。
-- 所以删除 = 留一条**看不见的墓碑**（deleted_at 非空）：列表里不出现、行为上就是「从未登录过」，
-- 而那一行还在，才记得住「在线就踢」。
--
-- 本次改动**只加不改**（除 `list_my_devices` 与 `get_my_session_v2` 的返回体会多/少一列，
-- 见下）：正在真机验收的 dev 客户端（0.5.2-dev.209）不受影响 —— 它看到的 `trusted` 语义
-- 一字未变，被删除的设备对它来说就是「trusted = false」⇒ 照旧踢下线。新版客户端多拿到
-- `deleted_at`，据此把提示从「该设备被拒绝登录」换成「该设备已从账号中移除」。

BEGIN;

ALTER TABLE public.user_devices ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 机制：被删除的设备**必然是**不信任的 —— 否则「在线则被踢」那条判据会漏掉它
-- （客户端看的是 trusted）。写成约束，别写成注释里的一句提醒。
ALTER TABLE public.user_devices
  ADD CONSTRAINT user_devices_deleted_untrusted CHECK (deleted_at IS NULL OR trusted = false);

COMMENT ON COLUMN public.user_devices.deleted_at IS
  '非空 = 已被「删除设备」：列表里不出现、在线则被踢；下一次它登录时重置为新设备并重发通知。';

-- ---------------------------------------------------------------------------
-- touch_session_v2：加「已删除 ⇒ 复活成新设备」分支（签名与返回**一字未变**）
-- ---------------------------------------------------------------------------
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
  v_notify boolean := false;
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
    v_notify := true;
  ELSIF v_row.trusted IS FALSE AND v_row.deleted_at IS NULL THEN
    -- 被设为不信任：**之后拒绝该设备登录**（行保留，所以这道门记得住）
    RAISE EXCEPTION 'device_rejected';
  ELSE
    -- 普通登录，**或**这台设备曾被「删除设备」（deleted_at 非空）：
    -- 后者按用户的要求复活成新设备 —— 清掉墓碑、轮换 token、照发一条新设备通知
    v_notify := v_row.deleted_at IS NOT NULL;
    UPDATE public.user_devices d
    SET token = gen_random_uuid(),
        last_seen_at = now(),
        trusted = true,
        deleted_at = null,
        name = left(coalesce(p_name, ''), 64),
        platform = left(coalesce(p_platform, ''), 32)
    WHERE d.user_id = v_uid AND d.device_id = p_device_id
    RETURNING * INTO v_row;
  END IF;

  IF v_notify THEN
    INSERT INTO public.notifications (user_id, category, title, content)
    VALUES (
      v_uid,
      'system',
      '新设备登录',
      coalesce(nullif(v_row.name, ''), '未知设备')
        || ' 于 '
        || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH:MM')
        || ' 登录了你的账号'
    );
  END IF;

  RETURN QUERY SELECT v_row.token, v_row.trusted;
END;
$function$;

-- ---------------------------------------------------------------------------
-- get_my_session_v2：多返回 deleted_at（客户端据此区分两种提示）
--
-- ⚠️ 返回体变了 ⇒ **必须先 DROP**（CREATE OR REPLACE 改不了 OUT 参数的行类型），
-- 而 DROP 会把上一版给的函数授权一起丢掉 ⇒ 后面要重新 REVOKE/GRANT 一遍。
-- 参数列表没变 ⇒ 调用方（postgrest 的 rpc()）不受影响，只是多拿到一列。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_my_session_v2(text);

CREATE OR REPLACE FUNCTION public.get_my_session_v2(p_device_id text)
RETURNS TABLE (token uuid, trusted boolean, deleted_at timestamptz, last_seen_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT d.token, d.trusted, d.deleted_at, d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = auth.uid() AND d.device_id = p_device_id
  LIMIT 1;
$function$;

-- ---------------------------------------------------------------------------
-- list_my_devices：**排除已删除的**（「从未登录过」在用户眼里就是列表里没有它）
-- ---------------------------------------------------------------------------
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
  WHERE d.user_id = auth.uid() AND d.deleted_at IS NULL
  ORDER BY d.trusted DESC, d.last_seen_at DESC;
$function$;

-- ---------------------------------------------------------------------------
-- delete_device：删除一台设备（踢下线 + 从列表消失 + 下次登录当新设备）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_device(
  p_self_device_id text,
  p_device_id text
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

  -- ★ 永远不能删除自己（与「不能拒绝自己」同一条理由：本机当场被踢，而恢复的入口在设置页里，
  -- 需要先登录 ⇒ 手上只有这一台设备的人会被永久锁在账号外）。
  IF p_self_device_id IS NOT DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'cannot_block_self';
  END IF;

  UPDATE public.user_devices d
  SET trusted = false,
      deleted_at = now()
  WHERE d.user_id = v_uid AND d.device_id = p_device_id;
END;
$function$;

-- get_my_session_v2 刚被 DROP 过 ⇒ 授权要重做（其余函数是 CREATE OR REPLACE，授权不受影响）
REVOKE ALL ON FUNCTION public.get_my_session_v2(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_session_v2(text) TO authenticated;

REVOKE ALL ON FUNCTION public.delete_device(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_device(text, text) TO authenticated;

COMMIT;

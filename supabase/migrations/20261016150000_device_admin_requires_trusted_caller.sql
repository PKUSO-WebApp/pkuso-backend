-- 设备管理（设为不信任 / 恢复信任 / 删除设备）：**发起方自己必须仍是受信设备**
--
-- 起因（2026-10-16，用户真机验收 + 群聊）：两台设备可以**同时**把对方设为不信任 —— 两边都成功，
-- 于是这个账号一台受信设备都不剩，而「恢复信任」的入口在设置页里、需要先登录 ⇒ **谁都进不来**。
-- 心跳（客户端自查 / 最长半分钟的窗口）只负责把已被不信任的设备**踢下线**，
-- 它挡不住「还没被踢掉的那几十秒里，那台设备反过来操作别人」。
--
-- 定下的规则（用户 2026-10-16 定，代号 C）：**做任何设备管理之前，先检查发起方自己是不是
-- 已被设为不信任 / 已被删除；是就不允许操作。**
--   · 放在**服务端**（就是这里）才有意义：界面藏得住按钮，藏不住一条直接调用的请求；
--   · 客户端另有一道自查（`devices` 页操作前 `verifySession`，发现即**直接踢出**）——
--     那一道只管体验，挡不住竞态。
--   · **「行不存在」不算不可信**：那台设备只是还没登记成功过（`touch_session_v2` 没跑成），
--     与「被拒绝 / 被删除」是两件事；把它也一起拒了会造出无谓的失败路径。
--
-- ⚠️ 这道检查**消不掉真正同时的那两下**（双方在同一个瞬间都还没被标记）——那是这条规则
-- 认下的残留。要根治得引入「主设备不可被不信任」那类不变量（本次没做，见群聊里的方案 B）。
--
-- 函数签名没变，`CREATE OR REPLACE` 会保留既有授权（上一版迁移里那对 REVOKE/GRANT），
-- 所以这里不再重申。
BEGIN;

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
  v_caller_bad boolean;
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

  -- ★ 发起方自己必须仍然受信（规则 C）。行不存在 ⇒ v_caller_bad 为 NULL ⇒ 放行。
  SELECT (d.trusted = false OR d.deleted_at IS NOT NULL)
  INTO v_caller_bad
  FROM public.user_devices d
  WHERE d.user_id = v_uid AND d.device_id = p_self_device_id;

  IF v_caller_bad THEN
    RAISE EXCEPTION 'caller_not_trusted' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_devices d
  SET trusted = p_trusted
  WHERE d.user_id = v_uid AND d.device_id = p_device_id;
END;
$function$;

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
  v_caller_bad boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  -- ★ 永远不能删除自己（与「不能拒绝自己」同一条理由：本机当场被踢，而恢复的入口在设置页里，
  -- 需要先登录 ⇒ 手上只有这一台设备的人会被永久锁在账号外）。
  IF p_self_device_id IS NOT DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'cannot_block_self';
  END IF;

  -- ★ 发起方自己必须仍然受信（规则 C）。行不存在 ⇒ v_caller_bad 为 NULL ⇒ 放行。
  SELECT (d.trusted = false OR d.deleted_at IS NOT NULL)
  INTO v_caller_bad
  FROM public.user_devices d
  WHERE d.user_id = v_uid AND d.device_id = p_self_device_id;

  IF v_caller_bad THEN
    RAISE EXCEPTION 'caller_not_trusted' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_devices d
  SET trusted = false,
      deleted_at = now()
  WHERE d.user_id = v_uid AND d.device_id = p_device_id;
END;
$function$;

COMMIT;

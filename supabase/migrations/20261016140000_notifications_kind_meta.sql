-- ---------------------------------------------------------------------------
-- notifications 加 kind / meta：让服务端生成的通知能被客户端**本地化**
--
-- 起因：`touch_session_v2` 写「新设备登录」那条通知时，标题与正文都是中文常量拼出来的
--（`'新设备登录'`、`'<设备名> 于 <时刻> 登录了你的账号'`）。小程序是双语的，英文用户
-- 在那条通知里看到的是整段中文。而正文里真正的变量只有两个：**设备名**与**时刻** ——
-- 客户端只要拿到这两个量，就能用自己的 i18n 渲染。
--
-- 所以：加 `kind`（稳定机读键）+ `meta`（参数），**title / content 保留作兜底**：
--   · 老行、认不得的 kind、以及不做本地化的消费方（Web 端 / 将来的后台）照旧读原文；
--   · 客户端遇到认得的 kind 就用 i18n 渲染，认不得就原样显示。
-- 这条通知是「账号被别人登了」唯一的信号（多设备之后没有顶号这个强信号），措辞得能随语言变。
--
-- 顺手修一处**回归**：2026-10-14 那次重写把时间格式从 `HH24:MI` 写成了 `HH:MM` ——
-- Postgres 里 `HH` 是 12 小时制、`MM` 是**月份**，于是正文里的时间既错小时又错分钟。
-- dev 实测：真实时刻 2026-10-15 21:17 的那条写成「10-15 09:10」。改回 `HH24:MI`。
--（两类行并存过：10-14 之前的行是对的，之后的三条是错的；全在 dev，prod 没有这个功能。）
-- ---------------------------------------------------------------------------

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS meta jsonb;

COMMENT ON COLUMN public.notifications.kind IS
  '机读类型（当前只有 device_login）。客户端按它挑 i18n 文案；为空则回退到 title/content 原文。';
COMMENT ON COLUMN public.notifications.meta IS
  'kind 的渲染参数（device_login ⇒ {"deviceName": string|null}）。只作展示数据，不含权限语义。';

-- 授权不用动：notifications 上是**表级** SELECT（authenticated / anon），新列自动覆盖；
-- 写入方是 SECURITY DEFINER 的 touch_session_v2，本就不吃 RLS 的「仅管理员可插入」。

-- ---------------------------------------------------------------------------
-- touch_session_v2：只改「发通知」那一段（签名、分支、返回值一字未动）
--   · 规格化元数据不写中文：设备名为空时 meta.deviceName 给 null 而不是「未知设备」，
--     好让英文端自己挑词；而 `content` 的兜底文案仍要自带「未知设备」，它得能独立读懂。
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
    INSERT INTO public.notifications (user_id, category, title, content, kind, meta)
    VALUES (
      v_uid,
      'system',
      '新设备登录',
      coalesce(nullif(v_row.name, ''), '未知设备')
        || ' 于 '
        || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI')
        || ' 登录了你的账号',
      'device_login',
      jsonb_build_object('deviceName', nullif(v_row.name, ''))
    );
  END IF;

  RETURN QUERY SELECT v_row.token, v_row.trusted;
END;
$function$;

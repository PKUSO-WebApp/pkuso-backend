-- ============================================
-- 声部长作用域收敛（P0c 验收反馈，2026-10-24）
-- ============================================
--
-- 用户明确：声部长目前只设计 **木管 / 铜管 / 五个弦乐声部**。
-- 不设「长笛声部长」「打击乐声部长」这类单件乐器（弦乐五声部除外）。
--
-- P0a 种子当时把 16 个乐器都写成 `can_lead=true`，比设计宽；本迁移只改字典数据，
-- 不动表结构、不删既有任命。`admin_set_section_leader` 用 `sections.can_lead` 把关，
-- web P0c 也按同一列渲染作用域，因此这一处更新同时收口 RPC 与 UI。
--
-- 收敛后 `can_lead=true` 的 7 个作用域：
--   第一小提琴 / 第二小提琴 / 中提琴 / 大提琴 / 低音提琴 / 木管 / 铜管
--
-- 首席不受影响：16 个乐器的 `can_principal` 仍为 true。
--
-- 回滚：把 can_lead 恢复为 P0a 种子值（16 个乐器 + 木管/铜管 = true）。

BEGIN;

UPDATE public.sections
   SET can_lead = (name IN (
     '第一小提琴', '第二小提琴', '中提琴', '大提琴', '低音提琴',
     '木管', '铜管'
   ))
 WHERE kind IN ('instrument', 'group');

COMMENT ON COLUMN public.sections.can_lead IS
  '能否作为声部长作用域。当前仅五个弦乐声部 + 木管/铜管为真；单件管乐/打击乐/键盘/竖琴不设声部长。';

-- 防呆：收敛后不允许残留指向「不再是作用域」的既有任命，否则 UI 会看不到它，
-- 管理员只能靠 SQL 撤销。发现就中止迁移，先人工清理。
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('%s←%s', sl.section, sl.leader_id), ', ')
    INTO v_bad
    FROM public.section_leaders sl
    JOIN public.sections s ON s.name = sl.section
   WHERE NOT s.can_lead;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'section_leaders 存在不再可任命的作用域，请先撤销：%', v_bad;
  END IF;
END
$$;

COMMIT;

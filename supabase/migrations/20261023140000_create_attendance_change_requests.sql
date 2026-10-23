-- ============================================
-- 出勤修改申请：枚举 + 表 + RLS（P3-1）
-- ============================================
--
-- 设计依据：`声部长功能-数据模型与常量.md` §5 + §12.3（2026-10-23 最终版）。
--
-- 关键决定：
--   · 声部长/首席「提出」申请，管理员（web）或团长（mp，后续）审批；
--   · `reason` **可空**（2026-10-23：暂不需要理由，留空位）；
--   · `to_status` **允许 `exempt`**，当前 `exempt` 的行也允许提修改；
--   · 每人每排练至多一条 pending（部分唯一索引）；
--   · 写只能经 RPC；表上只给 SELECT 策略（本人或管理员）。
--
-- 本迁移只建表；RPC / 审计列 / Realtime 在下一迁移。

BEGIN;

CREATE TYPE public."attendanceChangeRequestStatus" AS ENUM
  ('pending','approved','rejected','canceled');

CREATE TABLE public.attendance_change_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rehearsal_id   bigint NOT NULL REFERENCES public.rehearsals(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_by   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  from_status    public."attendanceStatus" NOT NULL,
  to_status      public."attendanceStatus" NOT NULL,
  reason         text,
  status         public."attendanceChangeRequestStatus" NOT NULL DEFAULT 'pending',
  decided_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  reject_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.attendance_change_requests IS
  '出勤修改申请：声部长/首席提出，管理员/团长审批。写只能经 RPC。';
COMMENT ON COLUMN public.attendance_change_requests.from_status IS
  '提交时考勤状态的快照；审批时用它判 stale。';
COMMENT ON COLUMN public.attendance_change_requests.reason IS
  '可选（2026-10-23）；驳回原因仍必填。';

CREATE UNIQUE INDEX attendance_change_requests_one_pending
  ON public.attendance_change_requests (rehearsal_id, target_user_id)
  WHERE status = 'pending';

CREATE INDEX attendance_change_requests_requested_by_idx
  ON public.attendance_change_requests (requested_by, created_at DESC);
CREATE INDEX attendance_change_requests_status_idx
  ON public.attendance_change_requests (status, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_attendance_change_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER attendance_change_requests_touch
  BEFORE UPDATE ON public.attendance_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_attendance_change_request();

ALTER TABLE public.attendance_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "出勤申请：本人或管理员可读" ON public.attendance_change_requests
  FOR SELECT TO authenticated
  USING (requested_by = (SELECT auth.uid()) OR public.is_admin());

REVOKE ALL ON public.attendance_change_requests FROM anon;
REVOKE ALL ON public.attendance_change_requests FROM authenticated;
GRANT SELECT ON public.attendance_change_requests TO authenticated;

REVOKE EXECUTE ON FUNCTION public.touch_attendance_change_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_attendance_change_request() FROM anon;
GRANT EXECUTE ON FUNCTION public.touch_attendance_change_request() TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_attendance_change_request() TO service_role;

COMMIT;

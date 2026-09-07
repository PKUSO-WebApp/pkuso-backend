-- 取消请假（Issue #149）：leaveStatus 枚举加 canceled + RLS 白名单扩展 + storage 删除策略
-- 注意：ALTER TYPE ... ADD VALUE 添加的新值不能在同一个事务内被引用，
-- 因此 ADD VALUE 单独一个事务提交后，再在下一个事务中更新策略。

-- 事务 1：枚举加值
BEGIN;
ALTER TYPE "leaveStatus" ADD VALUE 'canceled';
COMMIT;

-- 事务 2：RLS 与 storage 策略（此时 'canceled' 已提交，可安全使用）
BEGIN;

-- 成员合法流转新增：pending 申请可更新为 canceled（取消请假）
DROP POLICY IF EXISTS "leave_requests: 用户可更新自己的申请" ON leave_requests;
CREATE POLICY "leave_requests: 用户可更新自己的申请" ON leave_requests
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND status IN ('pending'::"leaveStatus", 'withdrawn'::"leaveStatus", 'canceled'::"leaveStatus"));

-- Storage：本人可删除自己目录下的附件（storage.objects 的 DELETE 无默认策略）
CREATE POLICY "leave-attachments: 用户可删除自己的附件" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'leave-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

COMMIT;

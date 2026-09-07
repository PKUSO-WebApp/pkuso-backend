-- 请假/补请假申请（Issue #142）
BEGIN;

CREATE TYPE "leaveStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  rehearsal_id bigint NOT NULL REFERENCES public.rehearsals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason text NOT NULL,
  attachment_url text,
  target_status "attendanceStatus" NOT NULL DEFAULT 'excused',
  status "leaveStatus" NOT NULL DEFAULT 'pending',
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS：用户仅可见/操作自己的申请；admin 经 API route（service role）审批
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leave_requests: 用户可插入自己的申请" ON leave_requests
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "leave_requests: 用户可读自己的申请" ON leave_requests
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "leave_requests: 用户可更新自己的申请" ON leave_requests
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Storage：私有 bucket leave-attachments，按 <user_id>/<filename> 路径存放
INSERT INTO storage.buckets (id, name, public)
VALUES ('leave-attachments', 'leave-attachments', false);

-- 仅本人可上传/读取自己目录下的附件（策略名带 bucket 前缀，避免与 community-images 现有策略重名）
CREATE POLICY "leave-attachments: 认证用户可上传" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'leave-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "leave-attachments: 用户可读自己的附件" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'leave-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

COMMIT;

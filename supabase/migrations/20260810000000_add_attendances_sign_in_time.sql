-- 为 attendances 表添加签到时间列（本地时间，无时区）
ALTER TABLE public.attendances ADD COLUMN sign_in_time timestamp NULL;

-- 添加 attendances.user_id → profiles.id 外键，使 PostgREST 能解析 profiles 嵌入
ALTER TABLE public.attendances
  ADD CONSTRAINT attendances_user_id_profiles_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 回填存量排练的出勤记录（所有已批准非管理员团员标记为缺席）
INSERT INTO public.attendances (rehearsal_id, user_id, status)
SELECT r.id, p.id, 'absent'::"attendanceStatus"
FROM public.rehearsals r
JOIN public.profiles p
  ON p.status = 'approved' AND p.role <> 'admin'
ON CONFLICT (rehearsal_id, user_id) DO NOTHING;

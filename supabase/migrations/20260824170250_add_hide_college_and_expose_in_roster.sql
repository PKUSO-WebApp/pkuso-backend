ALTER TABLE public.profiles ADD COLUMN hide_college boolean NOT NULL DEFAULT false;

-- 重建 roster 视图，暴露新增的 hide_college 标志（其余列与掩码逻辑保持不变）
CREATE OR REPLACE VIEW public.profiles_roster AS
SELECT id,
       CASE
         WHEN auth.uid() = id OR is_admin() OR NOT hide_email THEN email
         ELSE NULL::text
       END AS email,
       full_name,
       instrument,
       status,
       role,
       college,
       CASE
         WHEN auth.uid() = id OR is_admin() OR NOT hide_phone THEN phone_number
         ELSE NULL::text
       END AS phone_number,
       CASE
         WHEN auth.uid() = id OR is_admin() OR NOT hide_join_date THEN join_date
         ELSE NULL::text
       END AS join_date,
       created_at,
       is_section_leader,
       hide_email,
       hide_phone,
       hide_join_date,
       hide_college
FROM profiles
WHERE status = 'approved'::"profileStatus" OR auth.uid() = id OR is_admin();

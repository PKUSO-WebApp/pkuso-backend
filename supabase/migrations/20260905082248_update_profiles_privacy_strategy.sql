-- 1. 撤销 anon/authenticated 对 college 的列级 SELECT
REVOKE SELECT (college) ON profiles FROM anon, authenticated;

-- 2. 恢复 anon/authenticated 对 join_date 的列级 SELECT
GRANT SELECT (join_date) ON profiles TO anon, authenticated;

-- 3. 删除旧视图并重建：college 加掩码，join_date 取消掩码
DROP VIEW IF EXISTS profiles_roster;

CREATE OR REPLACE VIEW profiles_roster AS
SELECT id,
    CASE
        WHEN (( SELECT auth.uid() AS uid)) = id OR ( SELECT is_admin() AS is_admin) OR NOT hide_email THEN email
        ELSE NULL::text
    END AS email,
    full_name,
    instrument,
    status,
    role,
    CASE
        WHEN (( SELECT auth.uid() AS uid)) = id OR ( SELECT is_admin() AS is_admin) OR NOT hide_college THEN college
        ELSE NULL::text
    END AS college,
    CASE
        WHEN (( SELECT auth.uid() AS uid)) = id OR ( SELECT is_admin() AS is_admin) OR NOT hide_phone THEN phone_number
        ELSE NULL::text
    END AS phone_number,
    join_date,
    created_at,
    is_section_leader,
    hide_email,
    hide_phone,
    hide_join_date,
    hide_college,
    is_in_orchestra,
    avatar_url
FROM profiles
WHERE status = 'approved'::"profileStatus"
   OR (( SELECT auth.uid() AS uid)) = id
   OR ( SELECT is_admin() AS is_admin);

GRANT SELECT ON profiles_roster TO anon, authenticated;

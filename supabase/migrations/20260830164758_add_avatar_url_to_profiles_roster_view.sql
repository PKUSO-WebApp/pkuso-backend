CREATE OR REPLACE VIEW profiles_roster AS
SELECT id,
    CASE
        WHEN ((auth.uid() = id) OR is_admin() OR (NOT hide_email)) THEN email
        ELSE NULL::text
    END AS email,
    full_name,
    instrument,
    status,
    role,
    college,
    CASE
        WHEN ((auth.uid() = id) OR is_admin() OR (NOT hide_phone)) THEN phone_number
        ELSE NULL::text
    END AS phone_number,
    CASE
        WHEN ((auth.uid() = id) OR is_admin() OR (NOT hide_join_date)) THEN join_date
        ELSE NULL::text
    END AS join_date,
    created_at,
    is_section_leader,
    hide_email,
    hide_phone,
    hide_join_date,
    hide_college,
    is_in_orchestra,
    avatar_url
FROM profiles
WHERE ((status = 'approved'::"profileStatus") OR (auth.uid() = id) OR is_admin());

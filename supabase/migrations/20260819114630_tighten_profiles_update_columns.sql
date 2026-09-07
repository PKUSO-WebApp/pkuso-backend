BEGIN;

REVOKE UPDATE ON public.profiles FROM authenticated;

GRANT UPDATE (
  full_name,
  instrument,
  college,
  email,
  phone_number,
  join_date,
  hide_email,
  hide_phone,
  hide_join_date,
  is_section_leader
) ON public.profiles TO authenticated;

COMMIT;

CREATE OR REPLACE FUNCTION public.get_my_profile_entry()
RETURNS TABLE (
  full_name text,
  email text,
  status public."profileStatus"
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $function$
  SELECT p.full_name, p.email, p.status
  FROM public.profiles p
  WHERE p.id = auth.uid()
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_my_profile_entry() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_profile_entry() TO authenticated;

ALTER TABLE public.attendances ADD CONSTRAINT attendances_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

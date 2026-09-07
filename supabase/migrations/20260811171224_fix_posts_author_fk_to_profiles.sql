ALTER TABLE public.posts DROP CONSTRAINT posts_author_id_fkey;
ALTER TABLE public.posts ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

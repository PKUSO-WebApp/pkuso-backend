ALTER TABLE public.attendances ALTER COLUMN sign_in_time TYPE timestamp USING sign_in_time AT TIME ZONE 'UTC';

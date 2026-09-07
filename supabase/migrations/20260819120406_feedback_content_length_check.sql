BEGIN;
ALTER TABLE public.feedback
  ADD CONSTRAINT feedback_content_length_check
  CHECK (char_length(content) BETWEEN 1 AND 2000);
COMMIT;

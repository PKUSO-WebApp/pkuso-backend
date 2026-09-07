-- 入团时间治理③：格式约束锁死，杜绝再次写入日期型/其他脏值（空串与 NULL 视为未填写放行）
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_join_date_format_ck
  CHECK (join_date IS NULL OR join_date = '' OR join_date ~ '^\d{4}(春|秋)$');

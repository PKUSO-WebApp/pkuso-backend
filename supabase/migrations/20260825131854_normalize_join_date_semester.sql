-- 入团时间治理①：日期型历史值归一为「YYYY春/YYYY秋」（上半年=春，下半年=秋）
UPDATE public.profiles AS p
SET join_date = s.m[1] || CASE WHEN s.m[2]::int <= 6 THEN '春' ELSE '秋' END
FROM (
  SELECT id, regexp_match(join_date, '^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$') AS m
  FROM public.profiles
  WHERE join_date ~ '^\d{4}[-/.](\d{1,2})(?:[-/.]\d{1,2})?$'
) AS s
WHERE p.id = s.id;

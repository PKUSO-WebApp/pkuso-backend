-- 将 rehearsals.target_section 从 text 改为 text[]
-- 同时修正 prod 环境中唯一的分排记录：将 "弦乐（全体弦乐同学）" 替换为弦乐声部组的具体声部

ALTER TABLE rehearsals 
  ALTER COLUMN target_section TYPE text[] 
  USING CASE 
    WHEN target_section IS NULL THEN NULL
    WHEN target_section = '' THEN '{}'
    ELSE ARRAY[target_section]
  END;

ALTER TABLE rehearsals ALTER COLUMN target_section SET DEFAULT '{}';

-- 修正 prod 记录（如果存在）
UPDATE rehearsals 
SET target_section = ARRAY['第一小提琴','第二小提琴','中提琴','大提琴','低音提琴']::text[]
WHERE target_section = ARRAY['弦乐（全体弦乐同学）']::text[];
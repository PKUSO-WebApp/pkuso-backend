-- 将历史 late 记录全部改为 present
UPDATE attendances SET status = 'present' WHERE status = 'late'

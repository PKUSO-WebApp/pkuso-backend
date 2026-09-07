-- Migration: Add foreign key constraint from schedules.group_id to schedule_groups.id
-- Purpose: Establish referential integrity between schedules and schedule_groups
-- Rollback: ALTER TABLE schedules DROP CONSTRAINT schedules_group_id_fkey;

BEGIN;

-- First, migrate existing group_ids to schedule_groups table
INSERT INTO schedule_groups (id, title, repeat_mode, author_id, created_at, updated_at)
SELECT DISTINCT ON (s.group_id)
  s.group_id,
  COALESCE(s.title, 'Recurring Group'),
  'weekly',
  s.author_id,
  s.created_at,
  s.created_at
FROM schedules s
WHERE s.group_id IS NOT NULL
ORDER BY s.group_id, s.created_at;

-- Then add the foreign key constraint
ALTER TABLE schedules
ADD CONSTRAINT schedules_group_id_fkey
FOREIGN KEY (group_id) REFERENCES schedule_groups(id)
ON DELETE CASCADE;

COMMIT;

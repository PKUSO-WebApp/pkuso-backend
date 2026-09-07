-- 删除 profile 时级联删除关联的排练日程和日程分组

-- 1. 删除旧外键，重建为 ON DELETE CASCADE
ALTER TABLE schedules
  DROP CONSTRAINT schedules_author_id_fkey,
  ADD CONSTRAINT schedules_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- 2. 同理 schedule_groups
ALTER TABLE schedule_groups
  DROP CONSTRAINT schedule_groups_author_id_fkey,
  ADD CONSTRAINT schedule_groups_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;

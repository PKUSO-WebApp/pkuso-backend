-- 迁移说明：为schedules表添加group_id字段，用于标识同一预约组的预约
-- 支持周重复和月重复预约功能，同一组的预约共享相同的group_id
-- 回滚说明：ALTER TABLE schedules DROP COLUMN group_id; DROP INDEX IF EXISTS schedules_group_id_idx;

BEGIN;

-- 为schedules表添加group_id字段（UUID类型，可为空）
ALTER TABLE schedules
ADD COLUMN group_id UUID NULL;

-- 创建索引以提高按group_id查询的性能
CREATE INDEX IF NOT EXISTS schedules_group_id_idx
ON schedules (group_id);

COMMIT;
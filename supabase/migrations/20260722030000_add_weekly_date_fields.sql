-- Migration: Add weekly date fields to schedule_groups table
-- Purpose: Replace year-month-week based weekly repeat logic with date-based logic
--          (weekly_start_date + weekly_end_date instead of weekly_start_year/month/week)
--          Old fields are kept for backward compatibility, but frontend should migrate to new fields.
-- Rollback: ALTER TABLE schedule_groups DROP COLUMN IF EXISTS weekly_start_date, DROP COLUMN IF EXISTS weekly_end_date;

BEGIN;

-- Add new date fields for weekly repeat mode
ALTER TABLE schedule_groups
ADD COLUMN weekly_start_date DATE,
ADD COLUMN weekly_end_date DATE;

-- Add comments to document the fields
COMMENT ON COLUMN schedule_groups.weekly_start_date IS '周重复开始日期，替代旧的 weekly_start_year/month/week';
COMMENT ON COLUMN schedule_groups.weekly_end_date IS '周重复结束日期，替代旧的 weekly_end_year/month/week';

-- Note: Old fields (weekly_start_year, weekly_start_month, weekly_start_week, etc.) are kept for backward compatibility.
-- Frontend code should be updated to use the new date fields for both creation and display.

COMMIT;
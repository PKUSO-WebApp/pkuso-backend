-- Migration: Create schedule_groups table for managing recurring booking groups
-- Purpose: Currently recurring booking groups only use group_id in schedules table,
--          lacking group-level metadata (repeat pattern, date ranges, etc.)
-- Rollback: ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_group_id_fkey; DROP TABLE IF EXISTS schedule_groups;

BEGIN;

CREATE TABLE schedule_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  repeat_mode TEXT NOT NULL CHECK (repeat_mode IN ('weekly', 'monthly')),
  weekly_day INTEGER CHECK (weekly_day >= 0 AND weekly_day <= 6),
  weekly_start_year INTEGER,
  weekly_start_month INTEGER,
  weekly_start_week INTEGER,
  weekly_end_year INTEGER,
  weekly_end_month INTEGER,
  weekly_end_week INTEGER,
  monthly_day INTEGER CHECK (monthly_day >= 1 AND monthly_day <= 31),
  monthly_start_year INTEGER,
  monthly_start_month INTEGER,
  monthly_end_year INTEGER,
  monthly_end_month INTEGER,
  author_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX schedule_groups_author_id_idx ON schedule_groups (author_id);

CREATE INDEX schedule_groups_repeat_mode_idx ON schedule_groups (repeat_mode);

ALTER TABLE schedule_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY schedule_groups_admin_all ON schedule_groups FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY schedule_groups_self ON schedule_groups FOR ALL USING (author_id = (select auth.uid())) WITH CHECK (author_id = (select auth.uid()));

COMMIT;

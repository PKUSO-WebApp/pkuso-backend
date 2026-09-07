ALTER TABLE profiles
ADD COLUMN is_section_leader boolean NOT NULL DEFAULT false;

ALTER TABLE profiles
ADD COLUMN phone_number text;

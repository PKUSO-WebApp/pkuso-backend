-- 排练更新时间戳（Issue #140：编辑后显示「更新排练时间/地点/曲目」提示）
-- 判定条件 updated_at > created_at；存量行回填 created_at 避免误标已更新
BEGIN;

ALTER TABLE rehearsals ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE rehearsals SET updated_at = created_at WHERE updated_at > created_at;

COMMIT;

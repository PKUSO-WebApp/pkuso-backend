-- 系统通知发布历史（admin「我的」- 发布系统通知，Issue #227）
CREATE TABLE system_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  publisher_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE system_notifications IS '系统通知发布历史：admin 向全体已批准成员广播的系统通知记录，仅用于管理端历史展示；实际投递走 notifications 表';
COMMENT ON COLUMN system_notifications.title IS '通知标题';
COMMENT ON COLUMN system_notifications.content IS '通知正文';
COMMENT ON COLUMN system_notifications.publisher_id IS '发布人（profiles.id），发布人账号注销后保留历史记录并置 NULL';

ALTER TABLE system_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "system_notifications: 管理员可查看" ON system_notifications
  FOR SELECT TO authenticated USING (is_admin());

ALTER TABLE system_notifications
  ADD CONSTRAINT system_notifications_title_length_check
  CHECK (char_length(title) BETWEEN 1 AND 100);

ALTER TABLE system_notifications
  ADD CONSTRAINT system_notifications_content_length_check
  CHECK (char_length(content) BETWEEN 1 AND 2000);

CREATE INDEX system_notifications_created_at_idx ON system_notifications (created_at DESC);

-- 系统通知发布历史（admin「我的」- 发布系统通知，Issue #227）
-- 记录每次向全体已批准成员广播的系统通知（标题 + 内容 + 发布人 + 发布时间），用于管理端历史展示。
-- 实际投递给成员通过 notifications 表（category='system'）完成（由 service role API 批量插入），
-- 本表仅作历史存档，不承载投递逻辑。风格与 feedback 表（20260819120000）、announcements 表一致。
BEGIN;

-- ==================== 1. 系统通知历史表 ====================
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

-- ==================== 2. RLS ====================
-- 仅管理员可查看历史（is_admin()，SECURITY DEFINER，EXECUTE 已授予 authenticated）；
-- 插入由 service role（/api/admin/notify-system）完成，绕过 RLS，不开放 authenticated 直接插入；
-- 不开放 UPDATE/DELETE（系统通知发布后不可篡改/撤回，保持历史真实）。
ALTER TABLE system_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "system_notifications: 管理员可查看" ON system_notifications
  FOR SELECT TO authenticated USING (is_admin());

-- ==================== 3. 长度约束 ====================
-- 与前端输入 maxLength 一致；下限 1 兜底空串垃圾（标题/正文均不允许空）。
ALTER TABLE system_notifications
  ADD CONSTRAINT system_notifications_title_length_check
  CHECK (char_length(title) BETWEEN 1 AND 100);

ALTER TABLE system_notifications
  ADD CONSTRAINT system_notifications_content_length_check
  CHECK (char_length(content) BETWEEN 1 AND 2000);

-- ==================== 4. 索引 ====================
-- 管理端历史列表：按发布时间倒序
CREATE INDEX system_notifications_created_at_idx ON system_notifications (created_at DESC);

COMMIT;

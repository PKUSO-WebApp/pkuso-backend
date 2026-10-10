-- 「带批注的 PDF」的产物桶。
--
-- 由 `compose-annotated-pdf` Edge Function 写入（用 service role），客户端**只**通过
-- 该函数签发的 signed URL 读。所以这里刻意**不加任何 storage.objects 策略**：
-- RLS 默认拒绝 ⇒ `anon` / `authenticated` 都读不到、写不了这个桶，
-- 而 signed URL 是带签名的、不经过策略（那正是它存在的理由）。
--
-- ⚠️ 别为了「一致」照 `sheet-music` 那份加一条 `USING (bucket_id = ...)` 的读策略 ——
-- 那等于把每个人的批注产物变成公开可读（对象路径是 `<user_id>/<file_id>.pdf`，
-- 而这两个 id 在前端不是秘密：前者是登录用户自己的 id，后者在文件列表里就有）。

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sheet-music-annotated',
  'sheet-music-annotated',
  false,
  33554432, -- 32MB：函数侧的输入上限是 20MB，产物 = 原件 + 追加的内容流，留足余量
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

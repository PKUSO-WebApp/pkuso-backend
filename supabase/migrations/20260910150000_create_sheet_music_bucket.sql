-- 创建谱务公开 bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('sheet-music', 'sheet-music', true);

-- 仅管理员可上传乐谱
CREATE POLICY "管理员可上传乐谱" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'sheet-music' AND is_admin());

-- 仅管理员可更新乐谱
CREATE POLICY "管理员可更新乐谱" ON storage.objects
  FOR UPDATE USING (bucket_id = 'sheet-music' AND is_admin());

-- 仅管理员可删除乐谱
CREATE POLICY "管理员可删除乐谱" ON storage.objects
  FOR DELETE USING (bucket_id = 'sheet-music' AND is_admin());

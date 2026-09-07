-- 删除旧策略
DROP POLICY IF EXISTS "所有人可查看和上传 1sthiho_0" ON storage.objects;
DROP POLICY IF EXISTS "所有人可查看和上传 1sthiho_1" ON storage.objects;
DROP POLICY IF EXISTS "认证用户可删除" ON storage.objects;

-- 1. 任何人可查看图片
CREATE POLICY "任何人可查看" ON storage.objects
  FOR SELECT USING (bucket_id = 'community-images');

-- 2. 认证用户可上传（含管理员）
CREATE POLICY "认证用户可上传" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'community-images' AND auth.role() = 'authenticated');

-- 3. 所有者或管理员可更新
CREATE POLICY "所有者或管理员可更新" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'community-images'
    AND (owner = auth.uid() OR is_admin())
  );

-- 4. 所有者或管理员可删除
CREATE POLICY "所有者或管理员可删除" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'community-images'
    AND (owner = auth.uid() OR is_admin())
  );

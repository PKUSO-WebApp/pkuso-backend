CREATE POLICY "认证用户可删除" ON storage.objects FOR DELETE USING (bucket_id = 'community-images' AND auth.role() = 'authenticated');

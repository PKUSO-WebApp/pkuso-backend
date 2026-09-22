-- ============================================
-- 谱务系统数据库表
-- ============================================

-- 1. 曲子表
CREATE TABLE sheet_music (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  composer TEXT,
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. 声部表
CREATE TABLE sheet_music_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_music_id UUID REFERENCES sheet_music(id) ON DELETE CASCADE,
  instrument TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. 文件表
CREATE TABLE sheet_music_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID REFERENCES sheet_music_parts(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  page_count INTEGER,
  uploaded_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. 分发表
CREATE TABLE sheet_music_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID REFERENCES sheet_music_parts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  distributed_by UUID REFERENCES profiles(id),
  distributed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(part_id, user_id)
);

-- 5. 分析日志表
CREATE TABLE sheet_music_analysis_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  extracted_text TEXT,
  llm_result JSONB,
  user_correction JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 枚举类型扩展
-- ============================================

-- 扩展用户角色（如果 profileRole 枚举不存在则创建）
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'profileRole') THEN
    CREATE TYPE "profileRole" AS ENUM ('member', 'admin');
  END IF;
  
  -- 添加 score_manager 角色（如果不存在）
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'profileRole'::regtype AND enumlabel = 'score_manager') THEN
    ALTER TYPE "profileRole" ADD VALUE 'score_manager';
  END IF;
END $$;

-- ============================================
-- RLS 策略
-- ============================================

-- 启用 RLS
ALTER TABLE sheet_music ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_music_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_music_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_music_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheet_music_analysis_logs ENABLE ROW LEVEL SECURITY;

-- 曲子表策略
CREATE POLICY "所有人可查看曲子" ON sheet_music
  FOR SELECT USING (true);

CREATE POLICY "管理员和谱务工作者可管理曲子" ON sheet_music
  FOR ALL USING (
    is_admin() OR 
    (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
  );

-- 声部表策略
CREATE POLICY "所有人可查看声部" ON sheet_music_parts
  FOR SELECT USING (true);

CREATE POLICY "管理员和谱务工作者可管理声部" ON sheet_music_parts
  FOR ALL USING (
    is_admin() OR 
    (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
  );

-- 文件表策略
CREATE POLICY "所有人可查看文件" ON sheet_music_files
  FOR SELECT USING (true);

CREATE POLICY "管理员和谱务工作者可管理文件" ON sheet_music_files
  FOR ALL USING (
    is_admin() OR 
    (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
  );

-- 分发表策略
CREATE POLICY "用户可查看自己的分发" ON sheet_music_distributions
  FOR SELECT USING (
    user_id = auth.uid() OR 
    is_admin() OR 
    (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "管理员和谱务工作者可管理分发" ON sheet_music_distributions
  FOR ALL USING (
    is_admin() OR 
    (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
  );

-- 分析日志表策略
CREATE POLICY "管理员可查看分析日志" ON sheet_music_analysis_logs
  FOR SELECT USING (is_admin());

CREATE POLICY "系统可插入分析日志" ON sheet_music_analysis_logs
  FOR INSERT WITH CHECK (true);

-- ============================================
-- Storage Bucket 策略
-- ============================================

-- 修改 sheet-music bucket 的 RLS 策略
-- 允许 score_manager 上传
CREATE POLICY "score_manager can upload to sheet-music"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'sheet-music' AND (
      is_admin() OR 
      (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
    )
  );

-- 允许 score_manager 删除
CREATE POLICY "score_manager can delete from sheet-music"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'sheet-music' AND (
      is_admin() OR 
      (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
    )
  );

-- 所有人可读取
CREATE POLICY "所有人可读取 sheet-music"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sheet-music');

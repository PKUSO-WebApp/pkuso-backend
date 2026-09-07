-- 创建团员信息导入相关表
--
-- 1. import_config: 导入配置（字段映射 + 声部映射）
-- 2. member_info: 团员信息表（每年全量替换）

BEGIN;

-- 1. 导入配置表（单行配置）
CREATE TABLE public.import_config (
  id INT PRIMARY KEY DEFAULT 1,
  field_mapping JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- 格式: [{"excel_header": "1、您的声部", "target_field": "instrument_code"}, ...]
  instrument_map JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- 格式: {"1": "女高音", "2": "女低音", ...}
  year INT NOT NULL EXTRACT(YEAR FROM NOW()),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row_check CHECK (id = 1)
);

-- 2. 团员信息表
CREATE TABLE public.member_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  instrument_code INT,
  instrument_name TEXT,  -- 冗余存储映射后的乐器名称，便于查询
  email TEXT,
  college TEXT,
  grade TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 姓名唯一索引（防止重复导入）
CREATE UNIQUE INDEX idx_member_info_full_name ON public.member_info (full_name);

-- RLS 策略
ALTER TABLE public.import_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_info ENABLE ROW LEVEL SECURITY;

-- admin 完全控制
CREATE POLICY "admin_all_import_config" ON public.import_config
  FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_member_info" ON public.member_info
  FOR ALL USING (public.is_admin());

-- authenticated 只读（用于 approved 时预填）
CREATE POLICY "authenticated_select_member_info" ON public.member_info
  FOR SELECT USING (auth.role() = 'authenticated');

COMMIT;

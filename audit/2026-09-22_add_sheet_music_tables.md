# MCP 操作记录

- **时间**: 2026-09-22 11:14
- **操作者**: agent
- **环境**: dev/prod
- **操作类型**: apply_migration

## 操作内容

创建5张新表和相关RLS策略：

```sql
-- 1. sheet_music 曲子表
-- 2. sheet_music_parts 声部表
-- 3. sheet_music_files 文件表
-- 4. sheet_music_distributions 分发表
-- 5. sheet_music_analysis_logs 分析日志表

-- 新增 score_manager 角色
ALTER TYPE "profileRole" ADD VALUE 'score_manager';

-- RLS策略：所有用户可读，admin和score_manager可写
```

## 目的

为PKUSO系统添加谱务管理功能，包括：
- 乐谱元数据管理
- PDF文件存储和分发
- OCR/LLM自动识别乐器声部
- 分析日志记录

## 影响

- 涉及表: sheet_music, sheet_music_parts, sheet_music_files, sheet_music_distributions, sheet_music_analysis_logs
- 涉及 RLS: 所有新表启用RLS，admin和score_manager可管理
- 涉及 Edge Functions: ocr-analyze, llm-analyze

## 后续

- [x] 需要在 migrations/ 中补充正式迁移文件
- [ ] 需要更新两端 database.types.ts

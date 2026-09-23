# MCP 操作记录

- **时间**: 2026-09-07 23:30
- **操作者**: agent
- **环境**: N/A（仓库初始化）
- **操作类型**: 仓库创建

## 操作内容

初始化 `pkuso-backend` 仓库，从以下来源迁移文件：

1. 从 `pkuso-web/supabase/migrations/` 复制 69 个 migration 文件
2. 从 `pkuso-miniprogram/supabase/functions/` 复制 6 个 Edge Function

## 目的

建立后端的唯一事实来源，解决小程序端和 Web 管理端共享后端导致的版本管理混乱问题。

## 影响

- 不涉及数据库变更
- 不涉及 Edge Function 部署
- 仅为文件迁移

## 后续

- [x] 创建仓库结构
- [x] 复制现有 migration 文件
- [x] 复制现有 Edge Function
- [ ] 补录 28 个缺失 migration（需连接 prod 数据库）
- [ ] 首次生成 types
- [ ] 推送到 GitHub
- [ ] 更新 miniprogram 和 web-v2 仓库

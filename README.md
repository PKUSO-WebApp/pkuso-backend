# pkuso-backend

PKUSO 后端仓库 — 数据库 schema、Edge Functions、类型定义的唯一事实来源。

## 关联项目

- 小程序端：`../pkuso-mp`
- Web 管理端：`../pkuso-web`

## 目录结构

```
├── supabase/
│   ├── config.toml         # Supabase 项目配置
│   └── migrations/         # 数据库迁移文件（唯一来源）
├── functions/              # Edge Functions（唯一来源）
├── types/
│   └── database.types.ts   # TypeScript 类型定义（CI 自动生成）
├── audit/                  # 历史：早期「直接在库上改」的记录（现在的规矩是全部走 migration）
├── scripts/                # 工具脚本
└── .github/workflows/      # CI/CD 配置
```

## 使用方式

### 作为开发者

1. 克隆本仓库
2. 阅读 `CLAUDE.md` 了解协作规则
3. 所有后端变更通过 PR 提交

### 作为前端项目

从本仓库拉取最新类型定义：

```bash
# 在 miniprogram 或 web-v2 目录下
pnpm pull-types
```

或等待 CI 自动创建 PR 同步类型。

## CI/CD

- **dev**: 推送到 `main` 自动部署
- **prod**: 手动触发 GitHub Actions workflow

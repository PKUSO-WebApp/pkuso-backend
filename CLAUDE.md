# pkuso-backend

PKUSO 后端仓库 — 数据库 schema、Edge Functions、类型定义的唯一事实来源。

## 关联项目

- 小程序端：`../pkuso-miniprogram`（`C:\Users\dddam\Desktop\pkusoweb\pkuso-miniprogram`）
- Web 管理端：`../pkuso-web-v2`（`C:\Users\dddam\Desktop\pkusoweb\pkuso-web-v2`）

## Supabase 双环境

| 环境 | 项目 ref | 用途 |
|------|----------|------|
| Prod | `xkrszbmmdaorivkatvwh` | 生产环境 |
| Dev | `qibssimzuhusvutubbey` | 开发/测试环境 |

## ⚠️ 核心规则

### 禁止直接操作数据库

**所有后端变更（DDL / RLS / 函数 / 触发器 / Edge Functions）必须通过本仓库的 CI 流水线部署。**

- ❌ 禁止通过 MCP `apply_migration` 直接修改数据库
- ❌ 禁止通过 MCP `execute_sql` 执行 DDL
- ❌ 禁止通过 MCP `deploy_edge_function` 直接部署
- ❌ 禁止通过 Supabase Dashboard 修改 schema

### MCP 操作审计

如果因紧急情况必须通过 MCP 直接操作，必须：

1. 执行操作
2. 在 `audit/` 目录创建审计文件：`audit/YYYY-MM-DD_<简述>.md`
3. 补录对应的 migration 文件到 `supabase/migrations/`
4. 提交到 git

审计文件格式见 `audit/README.md`。

### Migration 管理

- 所有 migration 文件放在 `supabase/migrations/` 目录
- 命名格式：`<YYYYMMDDHHMMSS>_<描述>.sql`
- 每个文件必须是原子操作（单个事务）
- 禁止修改已提交的 migration 文件

### Edge Functions

- 所有函数放在 `functions/` 目录
- 修改函数后必须同时更新 `supabase/config.toml` 中的配置
- dev 和 prod 部署同一版本

### 类型定义

- `types/database.types.ts` 由 CI 自动生成，禁止手动修改
- 前端通过 CI 自动 PR 或手动 `pnpm pull-types` 获取最新类型

## CI/CD 流程

### dev 环境（自动）

推送 `main` 分支后，CI 自动执行：

1. `supabase db push` → 应用 migration 到 dev
2. `supabase functions deploy` → 部署 Edge Functions 到 dev
3. `supabase gen types` → 更新 `types/database.types.ts`
4. 自动向前端仓库发 PR 同步类型

### prod 环境（手动审批）

在 GitHub Actions 中手动触发 `Deploy to Prod` workflow：

1. 需要手动审批（`environment: production`）
2. `supabase db push` → 应用 migration 到 prod
3. `supabase functions deploy` → 部署 Edge Functions 到 prod
4. `supabase gen types` → 更新 `types/database.types.ts`

## 新增后端变更流程

1. 在 `supabase/migrations/` 创建新的 migration 文件
2. 如果修改了 Edge Functions，更新 `functions/` 目录
3. 如果修改了函数配置，更新 `supabase/config.toml`
4. 提交 PR 到 `main` 分支
5. CI 自动部署到 dev
6. 测试通过后合并到 `main`，CI 自动部署 dev
7. 需要上线时，手动触发 prod 部署

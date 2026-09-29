# pkuso-backend

PKUSO 后端仓库 — 数据库 schema、Edge Functions、类型定义的唯一事实来源。

## 关联项目

- 小程序端：`../pkuso-mp`（`C:\Users\dddam\Desktop\pkusoweb\pkuso-mp`）
- Web 管理端：`../pkuso-web`（`C:\Users\dddam\Desktop\pkusoweb\pkuso-web`）

## Supabase 双环境

| 环境 | 项目 ref | 用途 |
|------|----------|------|
| Prod | `xkrszbmmdaorivkatvwh` | 生产环境 |
| Dev | `qibssimzuhusvutubbey` | 开发/测试环境 |

## ⚠️ 核心规则

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
- 前端通过 CI **直接 push**（不是开 PR）获取最新类型 —— 见下面「类型同步的目标分支」

### 类型同步的目标分支（2026-09-29 定）

**规矩：类型的来源环境必须与那条分支线指向的环境一致。**

| 目标 | 写入者 | 内容 |
| --- | --- | --- |
| `pkuso-web` 的 `main` | `sync-dev.yml`（**独家**） | **dev** 类型 |
| `pkuso-mp` 的 `dev`（开发线） | `sync-dev.yml` | **dev** 类型 |
| `pkuso-mp` 的 `main`（稳定线） | `deploy-prod.yml` | **prod** 类型 |

- web 没有 dev 分支（单线、合并即部署），而它的 `main` 上必须装 **dev** 类型：否则「先写前端代码、再用后端新列」会死锁（PR 的 tsc 失败，手动补类型又会被 `gen-types-check` 拒掉）。配套地，pkuso-web 的 `ci.yml` 里 `gen-types-check` 也比对 **dev schema**。
- **不要让两个 workflow 写同一个文件**。在这条规矩之前，`sync-dev.yml` 和 `deploy-prod.yml` 都往 web `main` 与 mp `dev` 写类型，commit message 还完全一样 —— 同一个文件两个写入者、内容来自两个环境，事后无法分辨来源；而且 web 的 `gen-types-check` 比对的是 prod，于是每次「migration 已进 dev、还没跑 prod 部署」的窗口里 CI 必然假红（实测 run 36312148142）。
- 跨仓类型提交都带 `[skip ci]`，GitHub 原生跳过下游 workflow（mp 的版本号回写也靠这条）。

## 本地闸门

```bash
bash scripts/gate.sh
```

**闸门的唯一定义在 `scripts/gate.sh`** —— CI 的 `Functions Test` 与人调的是同一个文件。在此之前，这条命令只写在 `functions-test.yml` 里，仓库里没有对应的本地入口，于是只能靠散文说「记得跑 `deno test`」——而那正是最容易不发生的事（`functions-test.yml` 的注释自己就这么写着）。

### git hook（本地便利，**不是**门）

```bash
git config core.hooksPath .githooks     # 每个克隆一次，没法提交
```

装好之后推 `main` 会先跑一次闸门（推 WIP 分支不挡）。

⚠️ **但它不是可靠的门**：没装就是没有（`core.hooksPath` 在 `.git/config` 里、不进版本控制），而且可以 `git push --no-verify` 绕过。

**真正的兜底是 CI 的必需检查**（规则集里的 `deno-test`）—— 那个绕不过去。hook 只是让你**在推之前**就知道。

⚠️ 它**覆盖不到**什么，改后端前必须知道：

- migration 的 SQL 一行都不检查（本仓库没有 migration 的 lint / 干跑）
- **12 个函数里有 8 个没有测试**，含整条登录/鉴权链路。2026-09-29 查出的两个无鉴权端点正是在那片空白里
- `supabase/config.toml` 与实际部署状态是否一致，也不检查（实测：`config.toml` 里 5 条 `verify_jwt = true` 全是死配置，因为 CI 用 `--no-verify-jwt` 部署）

## CI/CD 流程

### dev 环境（自动）

**推送 `main` 之后**（不是 PR 阶段）CI 才执行：

1. `supabase db push` → 应用 migration 到 dev
2. `supabase functions deploy` → 部署 Edge Functions 到 dev
3. `supabase gen types` → 更新 `types/database.types.ts` 并提交回本仓库 `main`
4. 把 dev 类型直推到 `pkuso-web` 的 `main` 与 `pkuso-mp` 的 `dev`

### prod 环境（手动触发）

在 GitHub Actions 中手动触发 `Deploy to Prod` workflow，输入 `deploy` 确认。实际步骤比这里列的多（含迁移对账与跨仓写入），以 `deploy-prod.yml` 为准：

1. 对账 dev / prod 的 migration 版本差异
2. `supabase db push --include-all` → 应用 migration 到 prod
3. `supabase functions deploy` → 部署 Edge Functions 到 prod
4. `supabase gen types` → 更新 `types/database.types.ts` 并提交回本仓库 `main`
5. 把 prod 类型直推到 `pkuso-mp` 的 `main`

⚠️ `db push` 那步带 `|| true`，**部署失败不会让 workflow 变红**。跑完请看日志确认，别只看绿勾。

## 新增后端变更流程

1. 在 `supabase/migrations/` 创建新的 migration 文件
2. 如果修改了 Edge Functions，更新 `supabase/functions/` 目录
3. 如果修改了函数配置，更新 `supabase/config.toml`
4. 开 PR 到 `main`（PR 阶段只跑 `Audit Check` 与 `Functions Test`，**不会**部署任何东西）
5. 合并到 `main` → CI 自动部署到 dev
6. 需要上线时，手动触发 `Deploy to Prod`

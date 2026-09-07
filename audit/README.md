# MCP 操作审计日志

本目录记录所有通过 MCP 工具直接执行的数据库操作。

## 为什么需要审计

本仓库是后端的唯一事实来源。正常流程下，所有变更应通过 CI 流水线部署。

但在紧急情况下，可能需要通过 MCP 直接操作数据库。这些操作**必须**在此目录记录，以保证：

1. 变更可追溯
2. 其他开发者知道数据库当前状态
3. 后续可以补录正式的 migration 文件

## 文件命名

`YYYY-MM-DD_<简述>.md`

示例：`2026-09-07_fix_profiles_select_grants.md`

## 文件格式

```markdown
# MCP 操作记录

- **时间**: YYYY-MM-DD HH:MM
- **操作者**: agent / 人工
- **环境**: dev / prod
- **操作类型**: apply_migration / execute_sql / deploy_edge_function / 其他

## 操作内容

（实际执行的 SQL 或操作描述）

## 目的

（为什么要做这个操作）

## 影响

- 涉及表:
- 涉及 RLS:
- 涉及 Edge Functions:

## 后续

- [ ] 需要在 migrations/ 中补充正式迁移文件
- [ ] 需要更新两端 database.types.ts
```

## CI 检查

`audit-check.yml` 会在 PR 时检查审计文件的完整性。如果检测到 MCP 操作但没有对应的审计文件，CI 会失败。

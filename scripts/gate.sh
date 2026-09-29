#!/usr/bin/env bash
#
# 交付闸门（**本仓库闸门的唯一定义**）。CI 的 `Functions Test` job 与人调的都是这一条。
#
#   bash scripts/gate.sh
#
# ⚠️ 这个仓库此前**没有本地闸门** —— 唯一的检查是 `.github/workflows/functions-test.yml`
#    里那一行 `deno test`，而它的注释自己写着「全靠『有人记得在本地跑 deno test』——
#    而那正是最容易不发生的事」。这个脚本就是给「记得跑」一个单一入口。
#
# ⚠️ 它**覆盖不到**什么，改后端前必须知道：
#   - migration 的 **SQL 一行都不检查**（只查结构：命名 / 重复版本 / stub / 不许改已提交的
#     文件 —— 见 `check-migrations.mjs`）。语义得自己验，`docker run postgres:17-alpine` 最省事
#   - `supabase/config.toml` 与实际部署状态是否一致，也不检查
#     （2026-09-29 实测：`config.toml` 里 5 条 `verify_jwt = true` 全是死配置，
#     因为 CI 用 `--no-verify-jwt` 部署）
#
# ✅ 2026-09-30 补上的两条：
#   · **类型检查覆盖全部 12 个函数入口**（`check-types.mjs`）。在此之前这里是
#     「没写测试的那几个函数（含整条登录/鉴权链路）不检查」—— 那不是「少一点覆盖」，
#     是**零信号**：`deno test` 只检查被 import 到的模块图，而那几个函数一条测试都没有。
#     实测代价：一次重构里删掉模块级常量后，字符串里三处引用悬空，`deno test` 全绿
#     而函数一部署就崩。类型检查能抓住它。
#   · **migration 结构检查**（`check-migrations.mjs`）：AGENTS.md 里三条本来只靠散文的
#     规矩（命名格式、禁止修改已提交的 migration、不许 stub 占位）现在会真的失败。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ migration 结构检查（命名 / 重复版本 / 新增 stub / 不许改已提交的文件）"
node scripts/check-migrations.mjs

echo
echo "▶ deno check（12 个函数入口的类型检查；存量错误见 type-error-quota.json）"
node scripts/check-types.mjs

echo
echo "▶ deno test（Edge Functions；不发起网络调用、不需要任何密钥）"
deno test --allow-env --allow-read supabase/functions/

echo
echo "✓ 闸门全过。"
# ⚠️ 下面这几行**不能出现反引号** —— 双引号里的反引号会被 bash 当命令替换执行
#    （实测：那行 `docker run …` 真的被跑了一次）。要标术语用「」。
echo "  ⚠️ migration 只查**结构**，SQL 语义一行都不查 —— 改 SQL 请自己把「怎么验证它是对的」"
echo "     写进 PR 描述。最省事的办法：用 docker 起一个一次性 postgres:17-alpine，"
echo "     建好目标表，再用 psql -f 把这个 migration 喂进去（#80 就是这么验的）。"

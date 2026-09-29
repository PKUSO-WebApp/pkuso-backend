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
#   - migration 的 SQL 一行都不检查（本仓库没有 migration 的 lint / 干跑）
#   - Edge Function 里没写测试的那 8 个函数（含整条登录/鉴权链路）不检查
#   - `supabase/config.toml` 与实际部署状态是否一致，也不检查
#     （2026-09-29 实测：`config.toml` 里 5 条 `verify_jwt = true` 全是死配置，
#     因为 CI 用 `--no-verify-jwt` 部署）
set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ deno test（Edge Functions；不发起网络调用、不需要任何密钥）"
deno test --allow-env --allow-read supabase/functions/

echo
echo "✓ 闸门全过。"
echo "  ⚠️ migration 没有任何本地检查 —— 改 SQL 请自己把「怎么验证它是对的」写进 PR 描述。"

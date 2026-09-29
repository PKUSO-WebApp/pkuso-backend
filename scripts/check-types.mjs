#!/usr/bin/env node
/**
 * 对**每个 Edge Function 的入口**跑 `deno check`。
 *
 * ## 为什么需要它（`deno test` 已经绿了还不够）
 *
 * `deno test` 只检查**被 import 到的模块图**。而本仓有若干函数**一条测试都没有**
 * （`wechat-auth` / `register-with-wechat` / `login-with-code` / …）——
 * 它们的入口从来没被 import 过，于是**类型错误一个信号都没有**。
 *
 * 这条不是假设，是实测：一次重构里删掉了模块级常量 `SUPABASE_URL`，字符串里
 * 三处引用（`${SUPABASE_URL}/auth/v1/token…`）**悬空**了，而 `deno test` 全绿 ——
 * 那几个函数一部署就崩。类型检查能抓住它，`deno test` 抓不住。
 *
 * ## 白名单：只许变少
 *
 * 存量有 2 个错误（见下），直接加检查会让闸门立刻红 ⇒ 又是一条「红了我把它关掉」的路。
 * 所以做成**配额**：每个 (文件, 错误码) 记一个允许条数，**新增即红**。
 * 修掉之后跑 `--update` 收紧（它**拒绝调高**）。
 *
 * ⚠️ 白名单里的每一条都指向一个**待办**，不是豁免：
 *   TS2353  wechat-auth:178 / register-with-wechat:112 的 `listUsers({ filter })`
 *           —— 见 issue #77。**若运行时也丢掉了 filter，那是会认错用户的线上问题**，
 *           不只是类型定义落后。
 *
 * ## 用法
 *
 * ```
 * node scripts/check-types.mjs            # 检查（闸门用的是这个）
 * node scripts/check-types.mjs --update   # 按当前值收紧配额，只许调低
 * ```
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const QUOTA_PATH = "scripts/type-error-quota.json";
const FUNCTIONS_DIR = "supabase/functions";

/** 剥掉 ANSI 转义 —— 不剥的话 `grep 'error:'` 一条都匹配不到，检查会「全绿」 */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const entries = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "_shared")
  .map((e) => `${FUNCTIONS_DIR}/${e.name}/index.ts`)
  .filter((p) => existsSync(p));

if (entries.length === 0) {
  console.error("✗ 一个入口都没找到 —— 不做任何事（否则会把「没检查」当成「通过」）");
  process.exit(2);
}

let raw = "";
try {
  raw = execFileSync("deno", ["check", ...entries], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  // deno check 有错时退出码非 0，诊断在 stdout/stderr 里
  raw = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
const text = stripAnsi(raw);

// 收集 (文件, 错误码) 的条数。错误行形如 `TS2353 [ERROR]: …`，紧随其后的
// 第一条 `at file:///…` 就是它的位置。
const counts = {};
const lines = text.split("\n");
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/\b(TS\d{4})\s*\[ERROR\]/);
  if (!m) continue;
  let file = "(未知)";
  for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
    const at = lines[j].match(/at file:\/\/\/(.+?):\d+:\d+/);
    if (at) {
      // ⚠️ 归一化必须**与机器无关**：本机是 `C:/Users/…/pkusoweb/pkuso-backend/…`，
      // CI 是 `/home/runner/work/pkuso-backend/pkuso-backend/…`。只剥本机前缀的话，
      // 配额里的相对键在 CI 上永远匹配不上 —— 每一条都会被判成「新增」。
      // 所以统一剥到 `supabase/functions/` 为止。
      file = at[1]
        .split("\\")
        .join("/")
        .replace(/^.*?\/supabase\/functions\//, "supabase/functions/");
      break;
    }
  }
  const key = `${file}::${m[1]}`;
  counts[key] = (counts[key] ?? 0) + 1;
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update")) {
  if (existsSync(QUOTA_PATH)) {
    const old = JSON.parse(readFileSync(QUOTA_PATH, "utf8"));
    const raised = Object.entries(counts).filter(([k, n]) => (old[k] ?? 0) < n);
    if (raised.length) {
      console.error("✗ 拒绝调高配额 —— 它只该随修复而减少。新增的：");
      for (const [k, n] of raised) console.error(`    ${k}：${old[k] ?? 0} → ${n}`);
      process.exit(1);
    }
  }
  writeFileSync(QUOTA_PATH, JSON.stringify(counts, null, 2) + "\n");
  console.log(`✓ 配额已更新（${Object.keys(counts).length} 项 / 共 ${total} 条）`);
  process.exit(0);
}

if (!existsSync(QUOTA_PATH)) {
  console.error(`✗ 找不到配额文件 ${QUOTA_PATH}，先跑一次 --update`);
  process.exit(2);
}
const quota = JSON.parse(readFileSync(QUOTA_PATH, "utf8"));

const exceeded = Object.entries(counts).filter(([k, n]) => n > (quota[k] ?? 0));
const improved = Object.entries(quota).filter(([k, n]) => (counts[k] ?? 0) < n);

if (!exceeded.length) {
  console.log(`✓ 没有新增类型错误（检查了 ${entries.length} 个入口；存量 ${total} 条）`);
  if (improved.length) {
    console.log(`💡 有 ${improved.length} 项已好转，跑 --update 收紧配额：`);
    for (const [k] of improved) console.log(`    ${k}`);
  }
  process.exit(0);
}

console.log("✗ 出现新的类型错误（`deno test` 抓不到它们 —— 那些函数可能压根没有测试）:");
for (const [k, n] of exceeded) console.log(`    ${k}：配额 ${quota[k] ?? 0} → 实际 ${n}`);
console.log("\n  原始诊断：");
console.log(
  lines
    .filter((l) => /TS\d{4}\s*\[ERROR\]/.test(l) || /^\s+at file:/.test(l))
    .slice(0, 30)
    .map((l) => "    " + l.trim())
    .join("\n"),
);
console.log("\n  修完跑 `node scripts/check-types.mjs --update` 收紧配额。");
process.exit(1);

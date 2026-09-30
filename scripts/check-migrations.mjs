#!/usr/bin/env node
/**
 * migration 文件的**结构检查**（不是 SQL 检查）。
 *
 * ## 为什么需要它
 *
 * 本仓的闸门一直写着「migration 的 SQL 一行都不检查」。而 `AGENTS.md` 里关于 migration
 * 的规矩其实有三条是**机器可判定**的，此前全靠散文：
 *
 *   1. 命名格式 `<YYYYMMDDHHMMSS>_<描述>.sql`
 *   2. **禁止修改已提交的 migration 文件**
 *   3. 一个 migration 必须是原子操作 / 不能是 stub 占位
 *
 * 第 2 条尤其值得机器来判：改一个**已经应用过**的 migration 不会报错、也不会有任何后果
 * 提示 —— 版本号已经记在 `supabase_migrations.schema_migrations` 里，CI 不会重跑它，
 * 于是**仓库与线上库从此不一致**，而且没人看得出来。本仓历史上真发生过两次
 * （`f9ed57e` 改 `20260922000000_create_sheet_music_tables.sql`、
 * `2f736fc` 改 `20260916120000_fix_leave_requests_rls_withdraw.sql`）。
 *
 * 同一类病还有 stub：仓库里 18 个文件的内容是「Applied directly to dev database」——
 * 那是「直接在库上改、事后补个占位」的化石。新的 stub 意味着同样的路又被走了一次。
 *
 * ## 它**不**检查什么（别把这条绿勾当成 SQL 正确）
 *
 * - SQL 的语义、能不能跑通、有没有把 dev 锁死 —— 一行都不看。真要在本地试，最省事的
 *   是一次性容器（`docker run -d -e POSTGRES_PASSWORD=… postgres:17-alpine`），
 *   手工建好目标表再 `psql -f` 这个文件（#80 就是这么验的）。
 * - migration 与线上 schema 的漂移（那正是「prod 有、dev 没有、仓库里没有」这类事故的地盘）。
 *
 * ## 用法
 *
 * ```
 * node scripts/check-migrations.mjs              # base 取 origin/main（闸门用的是这个）
 * node scripts/check-migrations.mjs origin/dev   # 指定 base
 * ```
 *
 * base 解析不到时（离线、浅克隆）会**跳过**依赖 git 的三条检查并打印提示 ——
 * 不静默通过，也不假装检查过。
 */

import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MIGRATIONS_DIR = "supabase/migrations";
const STUB_MARKER = "Applied directly to dev database";

/** 与 AGENTS.md 的命名格式一致：14 位时间戳 + 下划线 + 描述 + .sql */
const NAME_RE = /^\d{14}_[a-z0-9_]+\.sql$/;

/** 跑 git，失败返回 null（不抛 —— 调用方要区分「空结果」与「跑不了」） */
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => !f.startsWith("."))
  .sort();

// 与 check-types.mjs 同一条道理：**目录空了必须报错**，否则「什么都没检查」会被读成「全过」。
if (files.length === 0) {
  console.error(`✗ ${MIGRATIONS_DIR} 下没有任何文件 —— 不做任何事（否则会把「没检查」当成「通过」）`);
  process.exit(2);
}

const problems = [];

// ---- 1. 命名格式 ----------------------------------------------------------
for (const f of files) {
  if (!NAME_RE.test(f)) {
    problems.push(`${f}：文件名不符合 <YYYYMMDDHHMMSS>_<小写描述>.sql（AGENTS.md「Migration 管理」）`);
  }
}

// ---- 2. 版本号不重复 ------------------------------------------------------
// db push 以 14 位版本号为键记录「应用过没有」。两条同版本的文件会让其中一个静默不生效。
const byVersion = new Map();
for (const f of files) {
  const v = f.slice(0, 14);
  if (!byVersion.has(v)) byVersion.set(v, []);
  byVersion.get(v).push(f);
}
for (const [v, fs] of byVersion) {
  if (fs.length > 1) problems.push(`版本号 ${v} 被 ${fs.length} 个文件共用：${fs.join(", ")}`);
}

// ---- 3~5. 依赖 base 的检查 ------------------------------------------------
const base = process.argv[2] ?? "origin/main";
const baseOk = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) !== null;

if (!baseOk) {
  console.log(
    `⚠️  解析不到 base \`${base}\`（离线 / 浅克隆？）—— 跳过「新增文件版本号」「新增 stub」「已提交文件被改」三条检查。`,
  );
  console.log("   **这不是通过**：CI 上 checkout 带 `fetch-depth: 0`，那三条会被真正执行。");
} else {
  // 只取「相对 base 的改动」。三点 diff = 从合并基点算起，与 base 之后的提交无关。
  const added = (git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", MIGRATIONS_DIR]) ?? "")
    .split("\n")
    .filter(Boolean);
  const touched = (git(["diff", "--name-only", "--diff-filter=MD", `${base}...HEAD`, "--", MIGRATIONS_DIR]) ?? "")
    .split("\n")
    .filter(Boolean);

  // ---- 3. 新增文件的版本号必须晚于 base 上已有的最大版本 ----
  const baseMax = Math.max(
    0,
    ...(git(["ls-tree", "--name-only", base, `${MIGRATIONS_DIR}/`]) ?? "")
      .split("\n")
      .map((p) => p.trim().split("/").pop() ?? "")
      .filter((f) => NAME_RE.test(f))
      .map((f) => Number(f.slice(0, 14))),
  );
  for (const p of added) {
    const f = p.split("/").pop();
    if (!NAME_RE.test(f)) continue; // 格式问题已在上面的第 1 条报过，不重复报
    const v = Number(f.slice(0, 14));
    if (v <= baseMax) {
      problems.push(
        `${f}：版本号 ${f.slice(0, 14)} 不晚于 ${base} 上已有的最大版本 ${baseMax} —— ` +
          `db push 按版本号排序应用，旧版本号会被插到已有的迁移之间。请用当前时间重命名。`,
      );
    }
  }

  // ---- 4. 新增的文件不能是 stub ----
  for (const p of added) {
    let text = "";
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (text.includes(STUB_MARKER)) {
      problems.push(
        `${p.split("/").pop()}：内容里有 stub 占位标记「${STUB_MARKER}」—— ` +
          `这等于记了一笔「直接在库上改过、仓库里没有对应 SQL」的账。新 migration 必须带真 SQL。`,
      );
    }
  }

  // ---- 5. 已提交的 migration 不许改、不许删 ----
  for (const p of touched) {
    problems.push(
      `${p.split("/").pop()}：被修改或删除了。已提交的 migration **不能改** —— ` +
        `版本号已经记在 supabase_migrations.schema_migrations 里，CI 不会重跑它，` +
        `改完只会让仓库与线上库静默不一致（AGENTS.md「禁止修改已提交的 migration 文件」）。` +
        `要改就新加一个 migration。`,
    );
  }

  console.log(
    `✓ migration 结构检查通过（共 ${files.length} 个文件；本次新增 ${added.length} / 改动 ${touched.length}；base=${base}）`,
  );
}

if (problems.length) {
  console.error("\n✗ migration 结构检查失败：\n");
  for (const p of problems) console.error(`  · ${p}`);
  console.error("\n  这些都不是 SQL 本身的问题，改文件名 / 新加一个 migration 即可。");
  process.exit(1);
}

console.log("  ⚠️ 它不检查 SQL 语义 —— 改 SQL 请把「怎么验证它是对的」写进 PR 描述（docker 起个一次性 PG 最省事）。");

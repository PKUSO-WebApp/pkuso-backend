/**
 * 入口文件的静态守卫。
 *
 * ## 为什么需要一条「读源码字符串」的测试
 *
 * 每个函数的 `index.ts` 顶层都会 `serve(handler)` —— 而**正因为如此，它不可能被
 * 正常地 import 进测试**（会真的绑端口）。于是入口文件成了整个函数目录里唯一
 * 没有覆盖的地方，而它恰好是「本地全绿、部署即崩」那类错误的藏身处。
 *
 * 实测（2026-09-24）：`segment-parts/index.ts` 漏了 `serve` 的 import ——
 * 我以为它是运行时注入的全局（那是 `Deno.serve`）。`deno test` 全绿，
 * 部署到 dev 后**每个请求（连 OPTIONS 预检）都是 500 `WORKER_ERROR`**：
 * 顶层就抛 `ReferenceError`，请求根本到不了 handler。
 *
 * 这条守卫把那件事变成一条会变红的断言。
 *
 * ⚠️ **匹配前必须剥注释**：守卫的报错文案里就写着正确的 import 长什么样，
 * 而那段话在 index.ts 里是注释 —— 不剥掉的话，**删掉真正的 import 它照样绿**
 * （第一版就是这么写的，实测该变异存活）。
 */

const FUNCTIONS_DIR = new URL("./", import.meta.url);

/** 剥掉块注释与**整行**注释。不碰行尾的 `//` —— URL 里也有 `//`，会被误伤。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** 扫出所有含 index.ts 的函数目录（加新函数不用改这里）。 */
async function entryDirs(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(FUNCTIONS_DIR)) {
    if (!entry.isDirectory) continue;
    try {
      await Deno.stat(new URL(`${entry.name}/index.ts`, FUNCTIONS_DIR));
      out.push(entry.name);
    } catch {
      // 没有 index.ts 的目录跳过
    }
  }
  return out.sort();
}

Deno.test("index.ts 里用到的 serve 必须被显式 import（漏了 = 部署即崩）", async () => {
  const dirs = await entryDirs();
  // 自检：扫不到东西说明扫目录的逻辑坏了，那这条守卫就是空转的
  if (dirs.length < 5) throw new Error(`只扫到 ${dirs.length} 个函数目录，扫目录的逻辑坏了`);

  for (const name of dirs) {
    const code = stripComments(await Deno.readTextFile(new URL(`${name}/index.ts`, FUNCTIONS_DIR)));
    // 裸 `serve(` —— `Deno.serve(` 不算（前面那个 `.` 被排除）
    const callsBareServe = /(^|[^.\w])serve\s*\(/.test(code);
    if (!callsBareServe) continue;
    const importsServe = /import\s*\{[^}]*\bserve\b[^}]*\}\s*from\s*["']/.test(code);
    if (!importsServe) {
      throw new Error(
        `${name}/index.ts 调用了 serve(...) 却没有 import 它。\n` +
          `  serve 不是运行时注入的全局 —— 部署后顶层就抛 ReferenceError，\n` +
          `  表现为每个请求（含 OPTIONS 预检）都回 500 WORKER_ERROR，而本地测试全绿。\n` +
          `  照 llm-analyze/index.ts 加一行：\n` +
          `    import { serve } from "https://deno.land/std@0.168.0/http/server.ts";`,
      );
    }
  }
});

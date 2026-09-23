import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handler } from "./handler.ts";

// index.ts 只负责把它交给 serve()。逻辑与理由见 handler.ts 顶部。
//
// ⚠️ **`serve` 必须显式 import**，它不是运行时注入的全局（`Deno.serve` 才是）。
// 漏了这行，部署后一到请求就 `WORKER_ERROR`：顶层 `serve(handler)` 抛
// `ReferenceError: serve is not defined`，而在那之前任何请求都到不了 handler
//（连 OPTIONS 预检都是 500）。版本与 llm-analyze 保持一致。
//
// 这类错误**没有测试能拦**：测试按设计只 import handler.ts（顶层 serve() 会真的
// 绑端口），所以入口文件是唯一无覆盖的地方 —— 靠 `index.test.ts` 里的静态守卫
// 与部署后的冒烟各挡一道。
//
// 本目录同 llm-analyze：**不跑 deno fmt** —— 全仓的函数文件都不是 fmt-clean 的，
// 单独格式化这一个只会让 diff 变成一坨格式噪音（跑 `deno fmt --check supabase/functions/`
// 看当下有几个不是 clean）。
serve(handler);

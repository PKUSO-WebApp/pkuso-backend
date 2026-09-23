import { handler } from "./handler.ts";

// index.ts 只负责把它交给 serve()。逻辑与理由见 handler.ts 顶部。
//
// 本目录同 llm-analyze：**不跑 deno fmt** —— 全仓的函数文件都不是 fmt-clean 的，
// 单独格式化这一个只会让 diff 变成一坨格式噪音（跑 `deno fmt --check supabase/functions/`
// 看当下有几个不是 clean）。
serve(handler);

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handler } from "./handler.ts";

/**
 * 入口只做一件事：把 handler 交给 serve()。实现全在 handler.ts。
 *
 * 拆开的理由见 handler.ts 顶部：顶层 `serve()` 会真的绑端口，一被测试 import 就炸，
 * 而响应组装那几处（展开顺序 / 参数判据 / 回显）恰恰是最容易出错、最需要断言的部分。
 * 先例见 llm-analyze/index.ts。
 *
 * 本文件刻意**不跑 deno fmt**：本目录绝大多数文件都不是 fmt-clean，只格改到的文件会让
 * 每个 PR 都背一份格式噪声（第一轮评审在本次 diff 上量到约 61% 是格式变动）。
 * 要统一就另起一个纯格式提交，别混进语义改动里。
 *
 * ⚠️ 这里**刻意不写"几个文件没格式化"** —— 那类计数会随文件增删、deno 版本变化而腐烂，
 * 而没人会重测。要知道当下是多少，跑 `deno fmt --check supabase/functions/`。
 */
serve(handler);

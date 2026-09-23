import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handler } from "./handler.ts";

/**
 * 入口只做一件事：把 handler 交给 serve()。
 *
 * 实现全在 handler.ts —— 顶层 `serve()` 会真的绑定端口，一被测试 import 就炸，
 * 所以必须把可测的部分隔出去。识别契约见 pkuso-backend#12，
 * 各字段为什么长这样见 analyze.ts 与 handler.ts 里的注释。
 */
serve(handler);

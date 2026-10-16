import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handler } from "./handler.ts";

/**
 * 入口只做一件事：把 handler 交给 serve()。实现全在 handler.ts。
 *
 * 拆开的理由见 handler.ts 顶部：顶层 `serve()` 会真的绑端口，一被测试 import 就炸，
 * 而「按 openid 找回未完成的账号」那一段恰恰是 #77 里认错人的地方，最需要断言。
 * 先例见 llm-analyze/index.ts / delete-storage-file/index.ts。
 */
serve(handler);

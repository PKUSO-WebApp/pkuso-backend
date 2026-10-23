// 入口：只负责绑端口，逻辑全在 handler.ts（那侧能被测试 import，这侧不能）。
// 与 compose-annotated-pdf / ocr-analyze / llm-analyze / segment-parts 同构。

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handler } from "./handler.ts";

serve(handler);

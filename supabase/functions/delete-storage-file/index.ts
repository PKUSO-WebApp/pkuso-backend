// 入口：只负责绑端口，逻辑全在 handler.ts（那边能被测试 import，这边不能）。
// 拆分的理由与 `ocr-analyze` / `llm-analyze` / `segment-parts` 相同 —— 见
// `../entry-guard.test.ts` 开头那段：入口文件顶层就 `serve()`，
// 于是它是整个目录里唯一没法被正常 import 的文件，也正是「本地全绿、部署即崩」的藏身处。

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handler } from "./handler.ts";

serve(handler);

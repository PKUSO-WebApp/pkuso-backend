import { handler } from "./handler.ts";

/**
 * 入口只做一件事：把 handler 交给 serve。实现全在 handler.ts。
 *
 * 拆开的理由见 handler.ts 顶部：顶层绑端口会让入口一被 import 就炸，而「按 openid
 * 找回未完成的账号」那一段恰恰是 #77 里认错人的地方，最需要断言。
 * 先例见 llm-analyze/index.ts / delete-storage-file/index.ts。
 *
 * ⚠️ 这里用**原生 `Deno.serve`**，而不是其它函数那种
 * `import { serve } from ".../std/http/server.ts"` —— 两个理由：
 *
 * 1. `index.test.ts`（#103）要驱动**真实入口**才能验到那条日志，办法是把 `Deno.serve`
 *    换成只接住 handler 的桩再 import 本文件。std 的 `serve()` 内部走 `Deno.listen`，
 *    桩不到 ⇒ 测试一上手就报「没接住 handler」。**别为了「与别的函数写法一致」改回
 *    std 的 serve**，那会让那条守卫变成一条永远失败、或者更糟 —— 被顺手删掉的测试。
 * 2. 这也正是本函数拆分**之前**就有的形状（原先入口顶层就是 `Deno.serve(async (req) => …)`），
 *    所以对线上运行时来说这次拆分是行为保持的。
 */
Deno.serve(handler);

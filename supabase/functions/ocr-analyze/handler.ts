import { requireUser } from "../_shared/auth.ts";
import { CORS_HEADERS, json } from "../_shared/http.ts";
import { shapeOcrResponse } from "./shape.ts";

/*
 * handler 单独成模块，index.ts 只负责把它交给 serve()。
 *
 * 理由与 llm-analyze 相同：顶层 `serve()` 会真的绑端口，一被测试 import 就炸；
 * 而**响应组装**（展开顺序、engine/overlay 回显、参数判据）恰恰是最容易出错、
 * 又最没有别的东西能拦住的部分 —— 它必须能被 import 才测得到。
 * 拆分本身零行为变化：部署路径仍是 `ocr-analyze/index.ts`。
 */

/**
 * OCR.space 支持的引擎号。默认 2 —— 与上一版硬编码的值一致，调用方不传就什么都不变。
 * 暴露出来是因为引擎选择是**每次调用**的质量旋钮：1 对干净排版的文档有时比 2 准，
 * 而「哪张图用哪个引擎」只有调用方知道（拼图条带 vs 整页的取舍就不一样）。
 */
const ENGINES = new Set([1, 2, 3, 5]);

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 网关不验签（CI 用 --no-verify-jwt 部署，config.toml 的 verify_jwt 是死配置），
  // 所以必须在这里自己验 —— 否则拿到公开 publishable key 的任何人就能烧 OCR.space 的额度。
  const auth = await requireUser(req, CORS_HEADERS);
  if (!auth.ok) return auth.response;

  try {
    const { file_base64, mime_type, language, overlay, engine } = await req.json();

    if (!file_base64) {
      return json({ success: false, error: 'file_base64 is required' }, 400, CORS_HEADERS);
    }

    const apiKey = Deno.env.get('OCR_SPACE_API_KEY');
    if (!apiKey) {
      return json({ success: false, error: 'OCR_SPACE_API_KEY not configured' }, 500, CORS_HEADERS);
    }

    // Accept both PDF and image from frontend
    const mime = mime_type || 'image/png';
    const dataUri = `data:${mime};base64,${file_base64}`;

    // 只有显式 `overlay === true` 才要坐标：它会让响应大一圈（每个词一个框），
    // 而绝大多数调用方（只看整段文本的那些）不必为此付带宽。
    // 判据用严格 `=== true` 而不是真值判断 —— `"false"` 这种字符串在真值判断下是**真**，
    // 会让「不想要坐标」的调用方反而拿到一个大响应。
    const wantOverlay = overlay === true;
    // 非法引擎号**退回默认**而不是报错：这是质量旋钮，不是正确性输入，
    // 为一个拼错的参数让整次 OCR 失败不值得。
    // ⚠️ 判据**不要改成 `Number(engine)`**：那会把 `engine: true` 折成 1、`"1"` 折成 1，
    // 于是一个「不像引擎号」的输入反而静默选中了某个引擎。要与 overlay 一样从严。
    const engineNo = typeof engine === 'number' && ENGINES.has(engine) ? engine : 2;

    const formData = new FormData();
    formData.append('base64Image', dataUri);
    formData.append('filetype', mime.startsWith('image/') ? 'JPG' : 'PDF');
    formData.append('language', language || 'auto');
    formData.append('isOverlayRequired', wantOverlay ? 'true' : 'false');
    formData.append('OCREngine', String(engineNo));

    const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'apikey': apiKey },
      body: formData,
    });

    const ocrData = await ocrResponse.json();

    if (ocrData.IsErroredOnProcessing) {
      return json({
        success: false,
        error: ocrData.ErrorMessage?.[0] || 'OCR processing failed'
      }, 400, CORS_HEADERS);
    }

    // text / pageCount / pages 都来自这里；`text` 仍是第一页的文本，老调用方一字不变
    const shaped = shapeOcrResponse(ocrData, wantOverlay);

    // ⚠️ 上游**返回了 0 页**（`ParsedResults` 为空或缺失）= 它一个字都没给。
    // 这**不是**「这张图没有文字」——后者是 `ParsedResults` 有一条、`ParsedText` 为空。
    // 不能报 success：调用方拿到 `{success:true, text:"", pageCount:0}` 时，
    // 与「图确实是空白的」不可区分，于是整条链路静默降级 —— 本仓专门记过这个坑。
    //
    // 实测（2026-09-24，dev，窄带图 1788×288 与整页图都复现）：OCR.space 在
    // 配额/限流状态下会回一个**不带任何错误标志**的空结果集 ——
    // `IsErroredOnProcessing` 为假，所以上面那条错误分支不走；`FileParseExitCode`
    // 与 `ErrorMessage` 都没有，所以 `shapeOcrResponse` 也判不出失败。同一张图
    // 换个 engine 有时又能读出来（实测 e2 连续 3 次空、e3 连续 3 次读出同一张图）。
    // 结论：**「成功但 0 页」这个形状必须由我们把它变成失败**，不能指望上游报错。
    //
    // 502（而不是 400）：不是调用方的错，是上游没给结果 —— 顺带让前端既有的
    // `OCR_TRANSIENT`（含 `HTTP 5\d\d`）重试逻辑对它生效（瞬时限流重试一次可能就好了）。
    if (shaped.pageCount === 0) {
      return json({
        success: false,
        error: '上游未返回任何识别结果（配额用尽或限流，也可能是图片不可识别）',
        upstreamPages: 0,
      }, 502, CORS_HEADERS);
    }

    return json({
      // 展开放**前面**：`shaped` 将来若多出一个叫 success/language/overlay/engine 的字段，
      // 显式的这几个必须赢。反过来的话重复键会被静默覆盖 —— 而本仓三条链路都不做类型检查
      //（deno test 只检查被 import 的模块、部署走 esbuild 打包、CI 里没有 check 步骤），
      // 覆盖了也没人会发现。现在有 index.test.ts 盯着这一条了。
      ...shaped,
      success: true,
      language: language || 'auto',
      // 请求侧回显：它答的是「这一次到底有没有要坐标」。判据是严格 `=== true`，
      // 所以 `overlay: "true"`（字符串，最可能的误用形式）会被判成**不要** ——
      // 不回显就无从发现。上游到底给没给是**另一件事**，看 `pages[].upstreamHasOverlay`。
      overlay: wantOverlay,
      // 同理：非法引擎号会静默回落 2，不回显调用方就分不清拿到的是哪个引擎的结果。
      engine: engineNo,
    }, 200, CORS_HEADERS);
  } catch (error) {
    return json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, 400, CORS_HEADERS);
  }
}

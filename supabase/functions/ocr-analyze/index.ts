import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { shapeOcrResponse } from "./shape.ts";

/*
 * 入口只做三件事：读报文 → 打 OCR.space → 用 shape.ts 整形后返回。
 * 整形逻辑单独成模块，理由与 llm-analyze 同：顶层 `serve()` 会绑端口，一被测试 import 就炸。
 *
 * 本文件刻意**不跑 deno fmt**：本仓 18 个函数文件里 15 个没格式化过，只格改到的文件
 * 会让每个 PR 都背一份格式噪声（这次是 59/97 行）。要统一就另起一个纯格式提交。
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * OCR.space 支持的引擎号。默认 2 —— 与上一版硬编码的值一致，调用方不传就什么都不变。
 * 暴露出来是因为引擎选择是**每次调用**的质量旋钮：1 对干净排版的文档有时比 2 准，
 * 而「哪张图用哪个引擎」只有调用方知道（拼图条带 vs 整页的取舍就不一样）。
 */
const ENGINES = new Set([1, 2, 3, 5]);

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const { file_base64, mime_type, language, overlay, engine } = await req.json();

    if (!file_base64) {
      return new Response(
        JSON.stringify({ success: false, error: 'file_base64 is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = Deno.env.get('OCR_SPACE_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'OCR_SPACE_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
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
    // 为一个拼错的参数让整次 OCR 失败不值得。判据用 `typeof === 'number'`，
    // 否则 `engine: true` 会被 Number() 折成 1 而静默选中引擎 1（与 overlay 的严格判据不一致）。
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
      return new Response(
        JSON.stringify({
          success: false,
          error: ocrData.ErrorMessage?.[0] || 'OCR processing failed'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // text / pageCount / pages 都来自这里；`text` 仍是第一页的文本，老调用方一字不变
    const shaped = shapeOcrResponse(ocrData, wantOverlay);

    return new Response(
      JSON.stringify({
        success: true,
        language: language || 'auto',
        // 回显是否真的按 overlay 处理了：调用方拿到空的 pages 时，
        // 「没给我坐标」和「要了坐标但上游没给」是两件不同的事 ——
        // 不回显就只能靠猜，正是本仓最忌讳的那种静默差异。
        overlay: wantOverlay,
        ...shaped,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

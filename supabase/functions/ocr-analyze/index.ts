import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const { file_base64, mime_type, language } = await req.json();

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

    // 直接使用已提取的首页 base64（由前端预处理）
    const mime = mime_type || 'application/pdf';
    const dataUri = `data:${mime};base64,${file_base64}`;

    const formData = new FormData();
    formData.append('base64Image', dataUri);
    formData.append('filetype', 'PDF');
    formData.append('language', language || 'auto');
    formData.append('isOverlayRequired', 'false');
    formData.append('OCREngine', '2');

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

    const parsedText = ocrData.ParsedResults?.[0]?.ParsedText || '';

    return new Response(
      JSON.stringify({
        success: true,
        text: parsedText,
        language: language || 'auto',
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
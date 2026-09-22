import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function extractFirstPage(pdfBase64: string): Promise<string> {
  // 复制一份 buffer，避免多实例共享同一底层内存
  const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
  const pdfBytesCopy = new Uint8Array(pdfBytes); // 关键：独立副本

  let pdfDoc: PDFDocument | null = null;
  let newDoc: PDFDocument | null = null;

  try {
    pdfDoc = await PDFDocument.load(pdfBytesCopy);
    const pageCount = pdfDoc.getPageCount();

    if (pageCount === 0) {
      throw new Error('PDF has no pages');
    }

    newDoc = await PDFDocument.create();
    const [firstPage] = await newDoc.copyPages(pdfDoc, [0]);
    newDoc.addPage(firstPage);

    const newPdfBytes = await newDoc.save();
    return btoa(String.fromCharCode(...newPdfBytes));
  } finally {
    // 彻底清理所有内部引用，帮助 Deno 回收内存
    if (newDoc) {
      try {
        newDoc._pages = [];
        (newDoc as any)._refMap?.clear?.();
      } catch {}
    }
    if (pdfDoc) {
      try {
        pdfDoc._pages = [];
        (pdfDoc as any)._refMap?.clear?.();
      } catch {}
    }
    // 显式置空，切断引用链
    pdfDoc = null;
    newDoc = null;
  }
}

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

    let firstPageBase64: string;
    try {
      firstPageBase64 = await extractFirstPage(file_base64);
      console.log('[OCR] First page extracted, size:', firstPageBase64.length);
    } catch (e) {
      console.error('[OCR] Failed to extract first page:', e);
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to extract first page from PDF' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const mime = mime_type || 'application/pdf';
    const dataUri = `data:${mime};base64,${firstPageBase64}`;

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
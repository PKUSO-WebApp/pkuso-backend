import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 基础乐器枚举（不含分声部）
const VALID_INSTRUMENTS = [
  'Violin I', 'Violin II', 'Viola', 'Cello', 'Contrabass',
  'Flute', 'Piccolo', 'Oboe', 'Clarinet', 'Bassoon', 'Contrabassoon',
  'Horn', 'Trumpet', 'Trombone', 'Tuba',
  'Percussion', 'Timpani', 'Drums', 'Triangle', 'Cymbals',
  'Piano', 'Celesta', 'Harp', 'Guitar',
];

/**
 * 标准化乐器名称，仅校验基础乐器
 */
function normalizeInstrument(raw: string): string {
  const normalized = raw.trim();
  
  if (VALID_INSTRUMENTS.includes(normalized)) {
    return normalized;
  }
  
  const found = VALID_INSTRUMENTS.find(
    inst => inst.toLowerCase() === normalized.toLowerCase()
  );
  if (found) return found;
  
  const partial = VALID_INSTRUMENTS.find(
    inst => inst.toLowerCase().includes(normalized.toLowerCase()) ||
            normalized.toLowerCase().includes(inst.toLowerCase())
  );
  if (partial) return partial;
  
  return 'unknown';
}

/**
 * 解析 subPart，支持各种数字格式，返回 number 或 null
 */
function parseSubPart(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  
  const str = String(raw).trim();
  if (!str || str.toLowerCase() === 'null') return null;
  
  // 罗马数字
  const romanMap: Record<string, number> = {
    'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5,
    'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10,
    'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
    'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10,
  };
  if (romanMap[str]) return romanMap[str];
  
  // 中文数字
  const chineseMap: Record<string, number> = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  };
  if (chineseMap[str]) return chineseMap[str];
  
  // 阿拉伯数字
  const num = parseInt(str, 10);
  if (!isNaN(num) && num > 0) return num;
  
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const { text, ocr_text, filename } = await req.json();
    const inputText = text || ocr_text;

    if (!inputText && !filename) {
      return new Response(
        JSON.stringify({ success: false, error: 'text/ocr_text or filename is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'GEMINI_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const prompt = `You are a music score analyzer. Based on the filename and OCR text, identify the instrument and sub-part number for this sheet music.

Available BASE instruments (choose EXACTLY one):
Violin I, Violin II, Viola, Cello, Contrabass, Flute, Piccolo, Oboe, Clarinet, Bassoon, Contrabassoon, Horn, Trumpet, Trombone, Tuba, Percussion, Timpani, Drums, Triangle, Cymbals, Piano, Celesta, Harp, Guitar

Rules:
1. Return ONLY a JSON object: {"instrument": "BaseInstrumentName", "subPart": number_or_null}
2. "instrument" MUST be exactly one from the list above
3. "subPart" is the part number (1, 2, 3, etc.) or null if no sub-part exists
4. If you cannot identify, return {"instrument": "unknown", "subPart": null}
5. Do NOT return any explanation or extra text

IMPORTANT NOTES:
- The BEGINNING of the OCR text (first page, top of the score) is MOST RELEVANT — it typically contains the instrument name and part designation
- Sub-part numbers may appear as: Arabic (1, 2, 3), Roman (I, II, III), Chinese (一, 二, 三)
- Examples: "Horn I" → instrument: "Horn", subPart: 1; "Trumpet 2" → instrument: "Trumpet", subPart: 2; "Viola" → instrument: "Viola", subPart: null
- Some instruments have NO sub-part (e.g., Viola, Cello, Piano) — use subPart: null
- Sub-part numbers have NO upper limit (could be 7, 8, etc.) — do not assume a maximum
- Instrument names may appear in various languages (Chinese, Russian, French, Italian, German, Hungarian, etc.)

Filename: ${filename || 'unknown'}
OCR Text: ${inputText || 'none'}

Result:`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 100,
            thinkingConfig: {
              thinkingBudget: 0,
            }
          }
        })
      }
    );

    const geminiData = await geminiResponse.json();
    
    if (geminiData.error) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: geminiData.error.message || 'Gemini API error' 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{"instrument": "unknown", "subPart": null}';
    
    // 解析 JSON 响应
    let instrument = 'unknown';
    let subPart: number | null = null;
    
    try {
      const parsed = JSON.parse(responseText);
      instrument = normalizeInstrument(parsed.instrument || 'unknown');
      subPart = parseSubPart(parsed.subPart);
    } catch {
      // 如果解析失败，尝试旧格式兼容
      instrument = normalizeInstrument(responseText);
      subPart = null;
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        instrument,
        subPart,
        confidence: instrument !== 'unknown' ? 0.85 : 0,
        source: 'llm',
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
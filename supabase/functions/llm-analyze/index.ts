import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 乐器枚举
const VALID_INSTRUMENTS = [
  'Violin I', 'Violin II', 'Viola', 'Cello', 'Contrabass',
  'Flute', 'Piccolo', 'Oboe', 'Clarinet', 'Bassoon', 'Contrabassoon',
  'Horn', 'Trumpet', 'Trombone', 'Tuba',
  'Percussion', 'Timpani', 'Drums', 'Triangle', 'Cymbals',
  'Piano', 'Celesta', 'Harp', 'Guitar',
];

/**
 * 标准化乐器名称，确保返回合法值
 */
function normalizeInstrument(raw: string): string {
  const normalized = raw.trim();
  
  // 精确匹配
  if (VALID_INSTRUMENTS.includes(normalized)) {
    return normalized;
  }
  
  // 大小写不敏感匹配
  const found = VALID_INSTRUMENTS.find(
    inst => inst.toLowerCase() === normalized.toLowerCase()
  );
  if (found) return found;
  
  // 部分匹配
  const partial = VALID_INSTRUMENTS.find(
    inst => inst.toLowerCase().includes(normalized.toLowerCase()) ||
            normalized.toLowerCase().includes(inst.toLowerCase())
  );
  if (partial) return partial;
  
  return 'unknown';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const { text, filename } = await req.json();

    if (!text && !filename) {
      return new Response(
        JSON.stringify({ success: false, error: 'text or filename is required' }),
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

    // 调用 Gemini API
    const prompt = `You are a music score analyzer. Based on the filename and OCR text, identify the instrument for this sheet music.

Available instruments (choose EXACTLY one):
Violin I, Violin II, Viola, Cello, Contrabass, Flute, Piccolo, Oboe, Clarinet, Bassoon, Contrabassoon, Horn, Trumpet, Trombone, Tuba, Percussion, Timpani, Drums, Triangle, Cymbals, Piano, Celesta, Harp, Guitar

Rules:
1. Return EXACTLY ONE instrument name from the list above
2. If you cannot identify, return "unknown"
3. Do NOT return any explanation or extra text

Filename: ${filename || 'unknown'}
OCR Text: ${text || 'none'}

Instrument:`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
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

    let instrument = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'unknown';
    
    // 验证输出是否为合法乐器
    instrument = normalizeInstrument(instrument);
    
    return new Response(
      JSON.stringify({
        success: true,
        instrument,
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

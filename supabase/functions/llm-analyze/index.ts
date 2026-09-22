import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 基础乐器枚举（不含分声部）
const VALID_INSTRUMENTS = [
  'Violin', 'Viola', 'Cello', 'Contrabass',
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
    const { text, ocr_text } = await req.json();
    const inputText = text || ocr_text;

    if (!inputText) {
      return new Response(
        JSON.stringify({ success: false, error: 'text/ocr_text is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'DEEPSEEK_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const prompt = `你是乐谱分析器。根据 OCR 文本，识别该乐谱的基础乐器和分声部号。

可用基础乐器（必须从中精确选择一个）：
Violin, Viola, Cello, Contrabass, Flute, Piccolo, Oboe, Clarinet, Bassoon, Contrabassoon, Horn, Trumpet, Trombone, Tuba, Percussion, Timpani, Drums, Triangle, Cymbals, Piano, Celesta, Harp, Guitar

规则：
1. 仅返回一个 JSON 对象：{"instrument": "基础乐器名", "subPart": 数字或 null}
2. "instrument" 必须完全匹配上述列表中的一个
3. "subPart" 为分声部号（1, 2, 3...）或 null（无分声部）
4. 无法识别时返回 {"instrument": "unknown", "subPart": null}
5. 不要返回任何解释或额外文本

重要提示：
- OCR 文本的开头（首页顶部）最相关 —— 通常包含乐器名和声部标记
- 分声部号可能出现为：阿拉伯数字 (1, 2, 3)、罗马数字 (I, II, III)、中文数字 (一, 二, 三)
- 示例："Horn I" → instrument: "Horn", subPart: 1；"Trumpet 2" → instrument: "Trumpet", subPart: 2；"Violin I" → instrument: "Violin", subPart: 1；"Viola" → instrument: "Viola", subPart: null
- 部分乐器无分声部（如 Viola、Cello、Piano） —— 用 subPart: null
- 分声部号无上限（可能是 7、8 等） —— 不要假设最大值
- 乐器名可能以多种语言出现（中文、俄文、法文、意大利文、德文、匈牙利文等）

OCR 文本: ${inputText || 'none'}

结果:`;

    // 带重试的 DeepSeek 调用
    const maxRetries = 3;
    let lastError: string | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(
        `https://api.deepseek.com/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',  // V4.1 Flash
            messages: [
              {
                role: 'user',
                content: prompt,
              },
            ],
            temperature: 0,
            max_tokens: 100,
            response_format: { type: 'json_object' },
          }),
        }
      );

      const data = await response.json();
      
      if (response.ok && !data.error) {
        // 成功
        let responseText = data.choices?.[0]?.message?.content?.trim() || '{"instrument": "unknown", "subPart": null}';
        
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
      }
      
      // 记录错误
      lastError = data.error?.message || `HTTP ${response.status}`;
      
      // 判断是否可重试：429 (rate limit) 或 5xx (server error)
      const isRetryable = response.status === 429 || response.status >= 500;
      
      if (!isRetryable || attempt === maxRetries) {
        break;
      }
      
      // 指数退避：1s, 2s, 4s
      const delayMs = 1000 * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    // 所有重试均失败
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: `LLM API error after ${maxRetries + 1} attempts: ${lastError}` 
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
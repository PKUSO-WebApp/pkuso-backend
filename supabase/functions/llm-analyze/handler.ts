import { type Analysis, abstain, buildAnalysis, MAX_SUB_PARTS, SECTIONS } from "./analyze.ts";

/*
 * handler 单独成模块，index.ts 只负责把它交给 serve()。
 *
 * 理由：重试 / 退避 / 超时 / 报文是这份代码最容易出错的部分，必须能被测试 import；
 * 而 index.ts 顶层会真的 `serve()` 绑定端口，一被 import 就炸。
 * 拆开之后测试只 import 本模块，**部署路径一个字符没动**。
 */

/**
 * prompt 里的声部列表由 SECTIONS 生成，不手抄 —— 手抄就会有两份词表，
 * 一旦漂移，`normalizeSection` 会把**所有**结果打成「其他」，而且是静默的。
 */
const SECTION_LIST = SECTIONS.join("、");

/**
 * 单次上游请求的上限。前端 `LLM_TIMEOUT_MS` 是 30s，而这里最坏要跑
 * 4 次请求 + 7s 退避 —— 不设单次上限的话，一条挂住的连接就能把整个预算吃光
 * 而前端早已超时（用户看到超时、后端还在烧额度）。
 */
const UPSTREAM_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 退避基数（毫秒）。第 n 次重试前等 `baseDelayMs * 2^n` —— 默认 1s / 2s / 4s。
 *
 * 导出成**可变**对象只为测试：真等满 7 秒退避会让用例跑 40 秒以上，
 * 那样没人愿意跑它，等于没有回归保护。生产代码不要动这个值。
 */
export const retry = { baseDelayMs: 1000 };

/** fetch 抛出来的错误 —— 只取类型与消息，这类是网络层信息，给前端看没有风险。 */
function describeUpstreamError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * 识别契约见 pkuso-backend#12。
 *
 * 与旧版的区别：不再要求模型从英文乐器白名单里精确选一个。白名单是开放集合
 * （Xylophone / Bass Clarinet / English Horn / Wagner Tuba … 永远补不全），
 * 且 prompt 里「必须匹配列表」与「无法识别返回 unknown」互相矛盾 ——
 * temperature=0 下模型会硬选一个最接近的，`unknown` 几乎从不出现，
 * 于是错误的猜测被当成识别结果预填进界面，用户很容易直接接受。
 *
 * 现在改为：声部走闭集（LLM 选，后端校验），乐器名交给模型直接产中文。
 *
 * 响应字段**平铺在顶层**，且小提琴的 subParts 优先采信模型、只在模型给不出时
 * 才由声部推导（是**兜底**，不是覆盖）—— 理由见 analyze.ts 的 VIOLIN_SUB_PART
 * 与下面响应处的注释。
 */
function buildPrompt(inputText: string): string {
  return `你是乐团谱务助手。下面是一份分谱首页的识别文本（第一行是文件名，其余是 OCR 结果）。
请判断这份谱子属于哪个声部、是什么乐器。

声部（section）必须从这个闭集里**原样**选一个，不要改写、不要用同义词：
${SECTION_LIST}
注意：是「大管」，不是「巴松管」，也不是「低音管」。
这些都判断不出来时，用「其他」。

只返回一个 JSON 对象，不要任何解释文字：
{"section": "声部", "instrument": "中文乐器名", "subParts": [数字...], "evidence": "原文片段"}

规则：
1. instrument 用**中文里这件乐器的标准叫法**（乐手会这么说的名字），不要逐词直译。
   调性乐器要把调性写进名字：
   Clarinetto piccolo (Es) → 降E调单簧管；Clarinetto in Si♭ → 降B调单簧管；
   Clarinetto in La → A调单簧管；Tromba in Do → C调小号；Corno in Fa → F调圆号。
   调性对照：Do/C → C调；Si♭/B♭ → 降B调；La/A → A调；Es/E♭ → 降E调；Fa/F → F调；Re/D → D调。
   直译会丢掉调性 ——「clarinetto piccolo」直译成「小单簧管」就与 A 调单簧管分不开了，
   而同一乐器的**不同调版本是不同的分谱**。
   其余不要求归一：写成「木琴」或「马林巴」都可以，分组靠 section，不靠乐器名。
2. evidence 必须是从下面文本里**原样抄出**的片段：保持原语言、原拼写，不要翻译、
   不要改写、不要补全。找不到能支撑结论的原文片段时，就返回弃权形态。
3. 弃权形态（证据不足或读不出乐器）：
   {"section": "其他", "instrument": "", "subParts": [], "evidence": ""}
   **不要猜。**
4. 先判版次语言，再解释乐器词。版次语言由**出版社**决定，**不由作曲家国籍决定** ——
   同一位作曲家的不同版次可能分别是俄文版、英文版、德文版。
   判断依据是文本里的标题写法、速度记号、出版标识。
   例：ПЯТАЯ СИМФОНИЯ 是俄文版；Symphony No. 5 in F Major 是英文版。
5. 先定乐器，再由乐器推声部，两者必须自洽 —— 不能出现「section 是打击乐、instrument 是大管」。
6. 易混词（歧义候选都落在弦乐内部，判错也不会跳到管乐）：
   意大利文 Basso → 大提琴；德文 Bass / Kontrabass → 低音提琴；
   意大利文 Corno → 圆号（不是小号）；Tromba → 小号；Trombone → 长号；
   意大利文 Campanelli → 钟琴；Silofono → 木琴；Arpa → 竖琴；Timpani → 定音鼓。
7. 小提琴：section 用「第一小提琴」或「第二小提琴」，instrument 用「小提琴」。
   一份谱子同时含第一、第二小提琴时，section 用「第一小提琴」、subParts 写 [1,2]。
   其他多声部乐器（长笛、双簧管、单簧管、大管、圆号、小号、长号…）同样用 subParts。
8. subParts 是**数组**，元素是阿拉伯数字，一份谱子覆盖几个分声部就写几个：
   只含圆号 2 → [2]；圆号 1、2、3、4 订成一份 → [1,2,3,4]；没有分声部 → []。
   **原文写成区间的要展开**：文件名是「Horn_1-4」「Flute 1-2」这种，就写 [1,2,3,4] / [1,2]，
   **不要照抄成 "1-4"** —— 区间是必须由你展开的写法，后端只认阿拉伯数字的列表。
   **不要写罗马数字、中文数字。**
   个数最多 ${MAX_SUB_PARTS}；单个号本身无上限，不要假设最大值。
9. 文本里可能有大量与乐器无关的内容（弓法、力度、排练号、页码）。
   乐器名通常在首页顶部，但**不要假设它一定排在最前面**。

识别文本：
"""
${inputText}
"""

结果：`;
}

/**
 * 导出成具名 handler 而不是把函数体直接塞给 serve()：重试 / 退避 / 超时 / 报文
 * 这几处逻辑（本文件最容易出错的部分）只有能被 import 才测得到。
 * 仓库先例见 `wechat-content-check/index.ts`。
 */
export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // 请求体不是合法 JSON 时别把 JS 解析器的原文回给前端
    //（`Unexpected end of JSON input` 对排查没帮助，还泄漏内部结构）。
    // body 是字面 `null` 时也走这里，不再让解构抛错。
    let body: { text?: unknown; ocr_text?: unknown } | null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const inputText = body?.text || body?.ocr_text;

    // 请求体是用户可控的 JSON，值不一定是字符串。类型不对在这里就回 400 ——
    // 否则它会一路走到证据校验，被记成「模型在编」（abstainReason 说谎），
    // 或者更早地把分析逻辑抛成异常。
    if (typeof inputText !== 'string' || !inputText) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'text/ocr_text is required and must be a non-empty string',
        }),
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

    const prompt = buildPrompt(inputText);

    // 带重试的 DeepSeek 调用
    const maxRetries = 3;
    let lastError: string | null = null;
    // 实际发出去了几次。不能直接用 maxRetries + 1 —— 不可重试的错误
    // （如上游 400）会立刻 break，那样报出的次数是假的。
    let attemptsMade = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptsMade = attempt + 1;

      // fetch 本身会抛（连接重置 / DNS / TLS 失败 / 超时）。不套 try 的话异常
      // 直接冒到最外层 catch —— **一次都不重试**，而这类恰恰是最该重试的瞬时故障。
      let response: Response;
      try {
        response = await fetch(
          `https://api.deepseek.com/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: 'deepseek-chat',
              messages: [
                {
                  role: 'user',
                  content: prompt,
                },
              ],
              temperature: 0,
              // evidence 让输出变长（要抄一段原文），100 会被截断成非法 JSON
              max_tokens: 200,
              response_format: { type: 'json_object' },
            }),
            // 单次上限。不设的话一条挂住的连接会吃光整个预算，
            // 而前端 LLM_TIMEOUT_MS 只有 30s。
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          }
        );
      } catch (err) {
        lastError = `上游请求失败（${describeUpstreamError(err)}）`;
        if (attempt === maxRetries) break;
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      // 上游 5xx 有时返回 HTML 错误页而不是 JSON。直接 await response.json() 会抛，
      // 整个重试循环被跳过、外层 catch 回一个与真实原因无关的解析错。
      // 解析不出来就当上游错误处理，交给下面的重试判定。
      let data: {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
      } | null = null;
      // 与「body 是字面 null」区分开：两者都让 data 为 null，但原因不同，
      // 报文里不能都说成「无法解析」。
      let unparsable = false;
      try {
        data = await response.json();
      } catch {
        unparsable = true;
      }

      if (response.ok && data && !data.error) {
        const rawContent = data.choices?.[0]?.message?.content;
        // `?.` 只对 null/undefined 短路：上游若把 content 回成数字，`123?.trim()`
        // 会直接抛，而这行在 try 之外 —— 整个重试循环会被跳过、外层回一个
        // 把内部表达式泄给前端的 400。
        const responseText = typeof rawContent === 'string' ? rawContent.trim() : '';

        // 解析失败不再回退到「把整段文本当乐器名做子串匹配」——
        // 那条兜底正是 English Horn → Horn 这类家族级错误的来源。
        // 拿不到合法 JSON 就弃权，交给用户填。
        let analysis: Analysis;
        try {
          analysis = buildAnalysis(JSON.parse(responseText), inputText);
        } catch {
          analysis = abstain('bad-json');
        }

        // 字段必须**平铺**在顶层：前端读的是 data.instrument / data.subParts
        // （pkuso-web upload-modal.tsx）。嵌一层 analysis 会让它读到 undefined，
        // 而 String(undefined) 是个真值 —— 会建出一个名叫「undefined」的声部。
        // 加列式 migration 换来的顺序无关性，就靠这个平铺的响应兑现。
        return new Response(
          JSON.stringify({ success: true, source: 'llm', ...analysis }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // 记录错误
      if (unparsable) {
        lastError = `上游响应无法解析（HTTP ${response.status}）`;
      } else if (data === null) {
        lastError = `上游返回了空响应（HTTP ${response.status}）`;
      } else {
        lastError = data.error?.message || `HTTP ${response.status}`;
      }

      // 两头都要：
      // - 429 / 5xx —— 标准的瞬时故障
      // - 2xx 但 body 解析不出来 —— 网关在成功状态码上塞了错误页，也值得重试
      // 但**不能**把「body 不是 JSON」无条件算作可重试：那会连带把 401/404
      // 这类客户端错误也重试 4 次。所以用 response.ok 把它限制在成功状态码上。
      const isRetryable =
        response.status === 429 || response.status >= 500 || (response.ok && unparsable);

      if (!isRetryable || attempt === maxRetries) {
        break;
      }

      // 指数退避：base × 2^attempt —— 默认 1s, 2s, 4s
      await sleep(retry.baseDelayMs * Math.pow(2, attempt));
    }

    // 所有重试均失败
    return new Response(
      JSON.stringify({
        success: false,
        error: `LLM API error after ${attemptsMade} attempt(s): ${lastError}`
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    // 不回内部异常原文：这里catch 到的多是解构错误、JSON 解析错误这类
    // 与「识别失败」毫无关系、只会误导排查的文本。日志里留全量。
    console.error('llm-analyze 未预期错误:', error);
    return new Response(
      JSON.stringify({ success: false, error: '服务内部错误' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}


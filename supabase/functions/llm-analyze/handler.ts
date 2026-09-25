import {
  type Analysis,
  abstain,
  buildAnalysis,
  MAX_EXTRA_SECTIONS,
  MAX_SUB_PARTS,
  SECTIONS,
} from "./analyze.ts";

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

/**
 * 退避基数（毫秒）。第 n 次重试前等 `baseDelayMs * 2^n` —— 默认 1s / 2s / 4s。
 *
 * 导出成**可变**对象只为测试：真等满 7 秒退避会让用例跑 40 秒以上，
 * 那样没人愿意跑它，等于没有回归保护。生产代码不要动这个值。
 *
 * ⚠️ `sleep` 也放在这里（2026-09-25）：**退避的断言过去是量墙钟的** —— 桩里记
 * `Date.now()` 差值再断言递增，而 `Date.now()` 只有 1ms 分辨率、`setTimeout`
 * 本身也有抖动，负载下会量到 `[3,2,4]` 而红。那不只是「偶尔烦人」：它会让
 * **变异验证读错图**（一红就以为变异被抓住了）。做成可注入之后，断言变成
 * 「**请求的**毫秒数是不是 base×2^n」—— 纯值比较，不碰时钟；用例也从 7 秒变瞬时。
 */
export const retry = {
  baseDelayMs: 1000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

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
function buildPrompt(inputText: string, fileName = ""): string {
  return `你是乐团谱务助手。下面是一份分谱首页的识别文本。
请判断这份谱子属于哪个声部、是什么乐器。
${
  // 文件名单列一段、并说清它的地位（pkuso-web#300）：它描述的是**整本合订**，
  // 可能含多件乐器，所以**不能**拿它当「这一页是什么」的判据 —— 那是段级误判的根因
  // （一份 `…--_Piccolo,_Flute_1,_2.pdf` 拆成三段时，三段都按文件名填成同一样号）。
  // 但它对**整份**仍然是最可靠的线索之一（出版社常把乐器名印在文件名里，
  // 而页面是扫描件、OCR 读出来是乱的），所以照发，只是把话说清。
  fileName
    ? `\n文件名（描述**整本合订**，可能含多件乐器，**不代表某一页**）：${fileName}\n`
    : ""
}

声部（section）必须从这个闭集里**原样**选一个，不要改写、不要用同义词：
${SECTION_LIST}
注意：是「大管」，不是「巴松管」，也不是「低音管」。
这些都判断不出来时，用「其他」。

只返回一个 JSON 对象，不要任何解释文字：
{"section": "声部", "instrument": "中文乐器名", "subParts": [数字...], "extraSections": [声部...], "evidence": "原文片段", "isFullScore": false}

规则：
0. **先判它是不是「总谱」**（isFullScore）：总谱 = **一页上并列着多个乐器**（多行谱表、
   每行一个乐器名，如 Flauto / Oboe / Clarinetto / Corno 同时出现）。
   - 是总谱 → "isFullScore": true，此时 instrument 给「总谱」、section 给「其他」、
     subParts 给 []、extraSections 给 []。
   - 不是（只有**一件**乐器，哪怕它出现了很多次）→ "isFullScore": false，照下面的规则填。
   ⚠️ 判据是**这一页的版式**，不是找词：不要因为「出现了乐器名」就判总谱 ——
   分谱的每一页页眉都印着乐器名。看的是**同一页上有没有多个不同的乐器**。
   ⚠️ **这个判断由你来做，后端不再复核你的结论** —— 它只把 evidence 原样交给用户核对。
      所以 evidence 请抄**你据以判断的那段原文**，让用户一眼就能复核你：
      ① 判成总谱时：**这一页上并列的那串乐器名**最合适（原样抄，逗号或顿号分隔都行）；
         封面 / 标题页上的**版次标注或标题行**也可以（Partitur / Score / 总谱 /
         партитура 这类字样 —— 各语种的写法远不止这几个，**按语义判断**，
         上面几个只是例子）。一般**只有总谱会有封面**。
      ② 判成分谱时：抄**印着这件乐器的那一行**（通常是页眉）。
      一行可用原文都抄不出时，evidence 给空串（**不要编**）—— 用户看到空引文会自己核对。
   ⚠️ 但**一件乐器加它的号或调性不算两个乐器**：「Corno in Es」「Tromba in Do」
      「Clarinetto in Si♭」「1st Horn」「Corno I, II」都是**一件**乐器的写法
      （调性与号是它名字的一部分，见规则 1），一份单件乐器的分谱页眉就长这样 ——
      不要把它当成「并列多个乐器」。
   ⚠️ 语言的写法千差万别（俄/德/意/法/英混排），**按音乐常识判断**，
   不要依赖某个语言的拼写。

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
   不要改写、不要补全。抄不出可用原文时给空串（见规则 0），**不要编一段出来**。
3. 弃权形态（**读不出乐器**、或这一页根本不是乐谱）：
   {"section": "其他", "instrument": "", "subParts": [], "extraSections": [], "evidence": ""}
   **不要猜。**也说不出乐器名时就用这个形态 —— **不要**拿「无法判断」「未知」「N/A」
   这类词去填 instrument：那串字会原样变成乐器名与文件名。
4. 先判版次语言，再解释乐器词。版次语言由**出版社**决定，**不由作曲家国籍决定** ——
   同一位作曲家的不同版次可能分别是俄文版、英文版、德文版。
   判断依据是文本里的标题写法、速度记号、出版标识。
   例：ПЯТАЯ СИМФОНИЯ 是俄文版；Symphony No. 5 in F Major 是英文版。
5. 先定乐器，再由乐器推声部，两者必须自洽 —— 不能出现「section 是打击乐、instrument 是大管」。
6. 易混词（歧义候选都落在弦乐内部，判错也不会跳到管乐）：
   意大利文 Basso **单独出现**时 → 大提琴（意文版次里那是低音声部的写法）；
   但写成「Violoncello e Basso」「Celli e Bassi」这种**并列两件乐器**的形式时，
   见规则 9 —— 那是跨两个声部的共用谱，不要只挑一个。
   德文 Bass / Kontrabass → 低音提琴；
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
9. **一份谱同时属于两个声部**时（两件**不同声部**的乐器共用同一份谱），把**主声部**
   写在 section，其余的写进 extraSections（数组，元素同样从上面的闭集里原样选）。
   例：「Violoncello e Basso」= 大提琴与低音提琴共用 → section 给「大提琴」、
   extraSections 给 ["低音提琴"]；「Celli e Bassi」同理。
   ⚠️ 只在**确实是两个不同声部**时才这么写。同一件乐器的几个分声部
      （Horn 1,2,3,4 订成一份）**不是**两个声部 —— 那是 subParts 的事，
      extraSections 给 []。
   ⚠️ 不要写「总谱」，也不要重复 section 里已经写过的那个声部。没有就给 []。
   个数最多 ${MAX_EXTRA_SECTIONS}。
10. 文本里可能有大量与乐器无关的内容（弓法、力度、排练号、页码）。
   乐器名通常在首页顶部，但**不要假设它一定排在最前面**。

${
  // 没有 OCR 文本是**真实存在**的一路（前端「一页有内容的都没读到」时只用文件名判断）。
  // 那时留一个空的识别文本块，模型会不知道该怎么办 —— 明说一句既省得它乱猜，
  // 也告诉它证据该抄哪里（抄文件名，后端会据此报 `evidenceFromFileName`）。
  inputText
    ? `识别文本：\n"""\n${inputText}\n"""`
    : `⚠️ **这一页没有可用的识别文本**（OCR 读不出或整页空白）—— 请**只根据上面的文件名**判断，\n   并在 evidence 里抄你据以判断的那一段**文件名**。`
}

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
    let body: { ocr_text?: unknown; file_name?: unknown } | null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    // ⚠️ **只认 `ocr_text`**：这里原来还有 `|| body?.text` 这个别名，而它**从来没有真实
    // 调用方** —— pkuso-web 从发出第一个请求起，发的就一直是 `ocr_text`（翻它的历史可见）。
    // 所以那个别名只是凭空多出来的第二种写法：两个字段名并存时「前端到底发了哪个」在协议上
    // 就说不清了；更糟的是**测试里到处都在用它**，等于测试没在验真实契约。
    // 现在发旧名会**响亮地** 400（见下面那句 error），而不是被悄悄认下。
    const inputText = body?.ocr_text;

    /**
     * 文件名**单独一个字段**（pkuso-web#300）。
     *
     * 以前它是拼进 `ocr_text` 第一行的（`文件名: X\nOCR 文本: Y`），于是
     * `evidenceSupports` 判「引文在原文里找到」时把文件名也算进原文 ——
     * 抄文件名、甚至只抄文件名里的流水号（`IMSLP807980-PMLP2711-10`）都能让
     * `evidenceFound` 为真，而那个字段是「让用户复核」的唯一依据。
     * 实测 36 次调用里有 2 次是这种情形。
     *
     * 现在分开传：引文只出现在文件名里时报 `evidenceFromFileName`（另一种依据），
     * 而不是冒充「在页面上找到了」。
     *
     * ⚠️ **可选字段，但类型错了不宽容**（同本文件对 `ocr_text` 的做法）：
     * 悄悄忽略一个类型不对的 `file_name`，会让 `evidenceFromFileName` 恒为假 ——
     * 那是**静默降级**，正是这个仓库反复栽过的那类坑。
     */
    const rawName = body?.file_name;
    if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'file_name must be a string when provided',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const fileName = typeof rawName === "string" ? rawName.trim() : "";

    // 请求体是用户可控的 JSON，值不一定是字符串。类型不对在这里就回 400 ——
    // 否则它会一路走到语义判断，拿一个非字符串去规范化（abstainReason 会说谎，
    // 报成「模型在编」），或者更早地把分析逻辑抛成异常。
    //
    // ⚠️ **`ocr_text` 为空是允许的，前提是给了文件名**（2026-09-26，配合 #300）：
    // 前端有一条真实的降级路 —— 一页有内容的都没读到（全空白 / 渲染失败 / OCR 读不出 /
    // 读到的字太少）时，**只用文件名**让模型判断（那条路的注释里就写着「body 里只有文件名」）。
    // 拆字段之前，那种请求的 `ocr_text` 是 `"文件名: X"` 那一行，所以非空；
    // 拆完之后它会是空串 —— 若这里照旧 400，那条**既有**的降级路会被整条打断。
    // 判据因此改成「两样至少给一样」，而不是「`ocr_text` 必须非空」。
    if (typeof inputText !== 'string' || (!inputText && !fileName)) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            'ocr_text is required and must be a non-empty string (unless a non-empty file_name is provided)',
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

    const prompt = buildPrompt(inputText, fileName);

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
        // ⚠️ 走 `retry.baseDelayMs` 而**不是字面量 1000**（2026-09-25 改）：与下面那条
        // 「可重试状态码」的路保持一致，否则测试把基数调小时这一条不跟随 —— 实测它因此
        // 真等了 1s/2s/4s，那条用例跑了 7 秒，而用例注释还写着「base=1ms」。
        // 生产默认值就是 1000，两者取值一字不差。
        await retry.sleep(retry.baseDelayMs * Math.pow(2, attempt));
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
          // ⚠️ 第三个参数是**文件名**：`evidenceFound` 只拿页面文本判，
          // 引文只在文件名里找得到时走 `evidenceFromFileName`（见 `buildAnalysis`）。
          analysis = buildAnalysis(JSON.parse(responseText), inputText, fileName);
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
      await retry.sleep(retry.baseDelayMs * Math.pow(2, attempt));
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


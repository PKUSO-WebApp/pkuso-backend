import { MAX_CUTS, parseSegmentPlan, planToRanges, type PageText } from "./segment.ts";

/*
 * handler 单独成模块，index.ts 只负责把它交给 serve()。
 * 理由与 llm-analyze 相同：重试 / 退避 / 超时 / 报文是这份代码最容易出错的部分，
 * 必须能被测试 import；而 index.ts 顶层会真的 `serve()` 绑定端口，一被 import 就炸。
 */

/**
 * 单页窄带文本的**输入**上限。窄带只有一行文字（乐器名或页码），正常几十个字符；
 * 给到 200 是防御性的 —— 上游是 OCR，返回整页文本也不该把 prompt 撑爆。
 */
const MAX_PAGE_TEXT_CHARS = 200;

/** 单次上游请求的上限。同 llm-analyze：不设的话一条挂住的连接会吃光整个预算 */
const UPSTREAM_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 退避基数。导出成**可变**对象只为测试（真等满 7 秒会让用例跑 40 秒以上） */
export const retry = { baseDelayMs: 1000 };

function describeUpstreamError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/**
 * 请求体校验。**契约违规一律 400，不做「宽容修正」。**
 *
 * ⚠️ 尤其是「页号必须严格升序且不重复」这一条：页号是切点的坐标系，
 * 一旦允许乱序或重复，`parseSegmentPlan` 就会在一个**意义不明**的坐标系上工作 ——
 * 那正是「降级逻辑掩盖失败」的经典形态（本仓专门记过这个坑）。
 * 前端传错了就该当场报错，而不是让后端猜它想说什么。
 */
function validateBody(
  body: unknown,
): { pages: PageText[]; pageCount: number } | { error: string } {
  if (!body || typeof body !== "object") return { error: "请求体必须是 JSON 对象" };
  const { pages, pageCount } = body as { pages?: unknown; pageCount?: unknown };

  if (typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) || pageCount < 1) {
    return { error: "pageCount 必须是正整数" };
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return { error: "pages 必须是非空数组" };
  }

  const out: PageText[] = [];
  let prev = 0;
  for (let i = 0; i < pages.length; i++) {
    const item = pages[i];
    if (!item || typeof item !== "object") return { error: `pages[${i}] 必须是对象` };
    const { page, text } = item as { page?: unknown; text?: unknown };
    if (typeof page !== "number" || !Number.isSafeInteger(page)) {
      return { error: `pages[${i}].page 必须是整数` };
    }
    if (page < 1 || page > pageCount) {
      return { error: `pages[${i}].page 超出 1..${pageCount}` };
    }
    if (page <= prev) {
      return { error: "pages 的 page 必须严格升序且不重复" };
    }
    if (typeof text !== "string") return { error: `pages[${i}].text 必须是字符串` };
    prev = page;
    out.push({ page, text: text.slice(0, MAX_PAGE_TEXT_CHARS) });
  }
  return { pages: out, pageCount };
}

/**
 * 识别契约见 pkuso-web#290（Step 1）。
 *
 * 与 `llm-analyze` **刻意不复用**：那个函数的职责是「这份是什么」（语义判断），
 * 这个是「哪几页是一份」（结构判断）。塞进同一个 prompt 会让两件事互相带偏，
 * 而且没法分别验证。
 *
 * ⚠️ **不发文件名。** issue 里写的是「文件名不作判据，只作为喂给 LLM 的证据」，
 * 而最彻底的执行方式是**根本不发** —— 合订谱的文件名里就写着 `_1,2,3,4`，
 * 一旦发过去，模型会锚定在「应该有 4 段」上，而真实情况可能是短笛 1、2 挤在同一页
 * （那是 `subParts` 的事，不是边界）。分段只以各页文本为准。
 */
function buildPrompt(pages: PageText[], pageCount: number): string {
  const withText = new Set(pages.map((p) => p.page));
  const missing: number[] = [];
  for (let p = 1; p <= pageCount; p++) if (!withText.has(p)) missing.push(p);

  const body = pages.map((p) => `第 ${p.page} 页: ${p.text.trim() || "（空白）"}`).join("\n");

  return `你是乐团谱务助手。下面是一份**合订分谱**逐页的「顶部窄带」识别文本。
窄带只取了每页最上面一条。

这份谱子共 ${pageCount} 页。
${missing.length ? `⚠️ 第 ${missing.join("、")} 页没取到文本（OCR 失败或空白）—— 不要在那几页上给切点。\n` : ""}
请判断**哪几页是新的一份分谱的开头**。

只返回一个 JSON 对象，不要任何解释文字：
{"cuts": [页码...], "evidence": ["原文片段"...]}

⚠️ **判据是「这一页出现了只在该份首页才有的版式」**：

- **作品/曲名** —— 整部作品的标题，如「Musik zu Goethe's Trauerspiel „Egmont"」「SINFONIE」「Ouverture」
- **作曲家名** —— 如「L. van Beethoven」「Д. ШОСТАКОВИЧ」
- 与上述内容连在一起、占好几行的**标题块**（常含版次、出版社、作品号）

而**续页只有页眉**：乐器名（可能带调性）＋页码。实测每一份分谱的首页都带标题块、
续页都不带 —— **这是唯一可靠的判据**。

⚠️ **两条不能用作判据的东西**（实测都踩过）：

1. **「出现了乐器名」不行**：这类老版分谱（如 Breitkopf 全集）**每一页页眉都印着乐器名**
   （续页也有「Violino I.」「Fagotto II.」）。照它切会把 11 页的单声部谱子切成 9 段。
2. **「乐器名变了」也不行**：续页的乐器名**会被 OCR 读错**。实测同一个人声部内出现过
   「Corno IV in Es.」被读成「Corno I in Es.」、「Clarinetto II」被读成「Clarinetto I」
   —— 照着乐器名切会切出击不存在的边界。（调性变化如「in F」→「in Es」同理，那不是新的一份。）

**段落标题（「ZWISCHENAKT III.」「N° 7.」）与速度记号在续页上也会出现，都不是边界。**

⚠️ 还有一种要排除的页：**只有作曲家名、没有乐器名的装饰页**（肖像页、题献页、
分卷扉页）。实测有一份谱子里夹着这样一页（整页只有「LUDWIG VAN / BEETHOVEN」），
模型有一轮把它当成了新的一份的开头 —— 切出来的一段里**一个乐器名都没有**，
那不是分谱。**新的一份的首页一定带乐器名。**

另外注意：**作品标题本身也可能出现在续页的页眉里**（例如续页页眉印着
「Dvořák — Symphony No. 5 in F Major, Op. 76」，与乐器名同一行）。
真正的首页标题块是**独立的几行**、常含作曲家**全名**与作品名，与续页那种
「作曲家姓 — 作品名」的单行页眉形状不同。

其余规则：
1. cuts 是**新一份的起始页**，1-based，升序，最多 ${MAX_CUTS} 个。
   **不要包含第 1 页** —— 它必然是第 1 份的开头，不是边界。
2. evidence 与 cuts **按位置一一对应**：每个切点配一段**原样抄自那一页**的片段，
   保持原语言、原拼写，不要翻译、不要改写、不要补全。
   抄不出片段就**不要写那个切点** —— 没有证据的切点会被后端丢掉。
3. **看不出边界就返回 {"cuts": [], "evidence": []}**，不要猜。
4. **宁可少切，不可多切**：少切只是把整份当成一份处理（用户还能人工改），
   多切会把两份谱的页混进同一段、整份归错人。不确定的边界一律不写。
5. 一份里含多个分声部（圆号 1、2、3 订在一起）**不构成边界** —— 那是别的字段的事。

识别文本：
"""
${body}
"""

结果：`;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // 请求体不是合法 JSON 时别把解析器原文回给前端（同 llm-analyze）
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const checked = validateBody(body);
    if ("error" in checked) return json({ success: false, error: checked.error }, 400);
    const { pages, pageCount } = checked;

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!apiKey) return json({ success: false, error: 'DEEPSEEK_API_KEY not configured' }, 500);

    const prompt = buildPrompt(pages, pageCount);
    const maxRetries = 3;
    let lastError: string | null = null;
    let attemptsMade = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptsMade = attempt + 1;

      // fetch 本身会抛（连接重置 / DNS / TLS / 超时）。不套 try 的话异常直接冒到
      // 最外层 catch —— **一次都不重试**，而这类恰恰是最该重试的瞬时故障。
      let response: Response;
      try {
        response = await fetch(`https://api.deepseek.com/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            // evidence 让输出变长（每个切点都要抄一段），太小会被截断成非法 JSON
            max_tokens: 500,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = `上游请求失败（${describeUpstreamError(err)}）`;
        if (attempt === maxRetries) break;
        await sleep(retry.baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      // 上游 5xx 有时返回 HTML 错误页而不是 JSON。直接 json() 会抛，
      // 整个重试循环被跳过、外层回一个与真实原因无关的解析错。
      let data: {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
      } | null = null;
      let unparsable = false;
      try {
        data = await response.json();
      } catch {
        unparsable = true;
      }

      if (response.ok && data && !data.error) {
        const rawContent = data.choices?.[0]?.message?.content;
        // `?.` 只对 null/undefined 短路：上游若把 content 回成数字，`123?.trim()` 会直接抛
        const responseText = typeof rawContent === 'string' ? rawContent.trim() : '';

        // 解析失败**不弃权整份请求**，而是走「不切」—— 与 parseSegmentPlan 的默认一致：
        // 不切 = 退回今天的行为（整份当一个声部），用户还能人工改。
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(responseText);
        } catch {
          parsed = null;
        }
        const plan = parseSegmentPlan(parsed, pages);

        // 平铺在顶层（同 llm-analyze 的约定：前端读 data.cuts）
        return json(
          {
            success: true,
            source: 'llm',
            ...plan,
            // 段区间由**同一份** plan 算出来，省得调用方各写一遍（那是「同一件事两处实现」的起点）
            ranges: planToRanges(plan, pageCount),
            pageCount,
          },
          200,
        );
      }

      if (unparsable) {
        lastError = `上游响应无法解析（HTTP ${response.status}）`;
      } else if (data === null) {
        lastError = `上游返回了空响应（HTTP ${response.status}）`;
      } else {
        lastError = data.error?.message || `HTTP ${response.status}`;
      }

      // 429 / 5xx 是标准瞬时故障；2xx 但 body 解析不出来也值得重试（网关塞错误页）。
      // 但不能把「body 不是 JSON」无条件算作可重试 —— 那会连带重试 401/404。
      const isRetryable =
        response.status === 429 || response.status >= 500 || (response.ok && unparsable);

      if (!isRetryable || attempt === maxRetries) break;
      await sleep(retry.baseDelayMs * Math.pow(2, attempt));
    }

    return json(
      { success: false, error: `LLM API error after ${attemptsMade} attempt(s): ${lastError}` },
      400,
    );
  } catch (error) {
    // 不回内部异常原文：这里 catch 到的多是解构错误，与「识别失败」无关、只会误导排查
    console.error('segment-parts 未预期错误:', error);
    return json({ success: false, error: '服务内部错误' }, 500);
  }
}

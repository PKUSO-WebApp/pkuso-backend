import { requireUser } from "../_shared/auth.ts";
import { CORS_HEADERS, json } from "../_shared/http.ts";
import { defuseFence } from "../_shared/prompt.ts";
import { createRetry, fetchJsonWithRetry } from "../_shared/retry.ts";
import { MAX_CUTS, parseCandidatePlan, planToRanges, type PageText } from "./segment.ts";

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

/**
 * 退避对象（实现与理由见 `../_shared/retry.ts` —— 那里记着「为什么退避的断言不能量墙钟」）。
 *
 * ⚠️ 仍然**从这里导出**、且是**本模块自己的一份**（`createRetry()` 每次给一个新对象）：
 * 测试会把它整个换掉（`sleep` 换成记时长的桩），共享单例会让别的函数的用例跟着变。
 */
export const retry = createRetry();

/**
 * 响应里回传**模型原文**的上限（字符）。
 *
 * 排查链路：`rawCuts: []` 过去既可能是模型明确弃权（`{"cuts": []}`），也可能是
 * 输出压根没解析出来（非法 JSON / 结构不对）—— 这两种情况的修法相反，而 API 层同形。
 * 回传原文就是为了让调用方**直接看见模型说了什么**。
 *
 * 它是排查字段，不是契约数据：超长就截断，并在**值本身**末尾标出「已截断」与原文长度
 * （不另加 truncated 布尔 —— 读者看到标记即知，字段越少越好）。标记占用同一个预算，
 * 所以字段值**整体**不超过这个上限。
 */
const MAX_MODEL_OUTPUT_CHARS = 2000;

function clipModelOutput(text: string): string {
  if (text.length <= MAX_MODEL_OUTPUT_CHARS) return text;
  const suffix = `…（已截断，原文 ${text.length} 字符）`;
  return text.slice(0, MAX_MODEL_OUTPUT_CHARS - suffix.length) + suffix;
}

/**
 * 模型输出的解析结果。
 *
 * ⚠️ `parsed` 的语义是「**能当作一份分段计划来读**」，不是「JSON.parse 没抛」：
 * `{"foo": 1}` / `[...]` / `"字符串"` 这类 JSON 合法但结构不对的输出，其 `cuts`
 * 同样是空的，若算作 parsed，就会与「模型明确弃权」（`{"cuts": []}`）在 API 层
 * 再次同形 —— 而消灭这个二义正是这些字段存在的理由。
 */
interface ParsedModelOutput {
  parsed: boolean;
  value: unknown;
  /** 只在 `parsed === false` 时给出：一句话说清卡在哪一步 */
  parseError?: string;
}

function parseModelOutput(responseText: string): ParsedModelOutput {
  if (!responseText) {
    return { parsed: false, value: null, parseError: "模型没有返回文本内容（content 缺失或为空）" };
  }
  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { parsed: false, value: null, parseError: `模型输出不是合法 JSON：${detail}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { parsed: false, value, parseError: "模型输出是合法 JSON，但不是对象" };
  }
  // 新契约是 `candidates`；旧形状（只有 `cuts`）仍然认 —— 模型偶尔会忽略格式要求，
  // 而这两种形状都能被 `parseCandidatePlan` 处理。
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.candidates) && !Array.isArray(record.cuts)) {
    return { parsed: false, value, parseError: "模型输出的对象里既没有 candidates 也没有 cuts 数组" };
  }
  return { parsed: true, value };
}

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

请判断**哪几页是新的一份分谱的开头**。

只返回一个 JSON 对象，不要任何解释文字：
{"candidates": [{"page": 页码, "reason": "为什么像新一份的首页（一句话）", "confidence": 0 到 1 的小数, "evidence": "原样抄自该页的片段"}]}

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

   不过读乐器名时，要先纠正一处**字体导致的系统性误读**：大写 I 可能被读成小写 l ——
   **「Il」应读作「II」、「Ill」应读作「III」**。这是字体造成的有规律的误读，不是随机噪声。

   ⚠️ **如果这份谱子的每一页都带完整标题块（整份没有续页），绝不能因此把它们都当成同一份。**
   这种版式下标题块不再是判据，**改看乐器编号**：从第 2 页起，只要乐器名或编号与前一页不同
   （哪怕只差一个 I / II），就应当作为候选；同时，这一刀前面那一段里必须有乐器名（见下）。

   ⚠️ **一个例外：三条同时成立时，编号的变化可以作为边界证据** ——
   ① 候选页**和**第 1 页（或上一个切点所在页）**都带完整标题块**（整份每一页都是首页版式）；
   ② 乐器编号发生了**明确变化**（如「Tromba I」→「Tromba II」、「Corno III」→「Corno IV」）；
   ③ 这一刀**前面那一段里有乐器名**（不是一个只有作曲家名的封面页）。
   之所以是例外：同一个人声部内，续页**不会**再带完整标题块；标题块 + 编号变化 + 前段有乐器名
   三条一起出现时，OCR 读错编号的可能性远小于「这确实是两份」。少任何一条都不行。

**段落标题（「ZWISCHENAKT III.」「N° 7.」）与速度记号在续页上也会出现，都不是边界。**

⚠️ 还有一种要排除的页：**只有作曲家名、没有乐器名的装饰页**（肖像页、题献页、
分卷扉页）。实测有一份谱子里夹着这样一页（整页只有「LUDWIG VAN / BEETHOVEN」），
模型有一轮把它当成了新的一份的开头 —— 切出来的一段里**一个乐器名都没有**，
那不是分谱。**新的一份的首页一定带乐器名。**

⚠️ **切出来的每一段都必须至少有一个乐器名**。所以：如果某个候选的**前面那一段**
（从上一切点或第 1 页，到候选页的上一页）里**一个乐器名都没有**，说明这一刀只是把
封面/扉页单独切了出来 —— 那不是新的一份的开头，**不要给这个候选**。

另外注意：**作品标题本身也可能出现在续页的页眉里**（例如续页页眉印着
「Dvořák — Symphony No. 5 in F Major, Op. 76」，与乐器名同一行）。
真正的首页标题块是**独立的几行**、常含作曲家**全名**与作品名，与续页那种
「作曲家姓 — 作品名」的单行页眉形状不同。

其余规则：
1. candidates 是**疑似新一份起始页**的列表，每个候选一个对象：
   「page」是**新一份的起始页**，1-based，升序，最多 ${MAX_CUTS} 个。
   **第 1 页就是第 1 份的首页** —— 它的形状 = 首页该有的样子，也就是上面那条判据的**现成范例**。
   所以：**形状与第 1 页相同的后续页，都是新的一份的开头**。
   而第 1 页自己**不要写进 candidates** —— 它是第 1 段的定义，不是边界。
2. 「evidence」必须**原样抄自那一页**，但只抄**一小段单行文本**（十来个字即可），
   保持原语言、原拼写，不要翻译、不要改写、不要补全。
   **不要抄整块标题、不要带换行**；**尤其不要带任何引号**（英文引号 "、德文书名号 „ "、
   法文引号 « »、中文引号「」都不行）—— 如果那一行本身含引号，就只抄**引号之外**的词。
   引号与换行会让 JSON 变成非法，整个响应就废了。
   抄不出片段就**不要写那个候选** —— 没有证据的候选不会被采纳。
3. 「reason」必须写：一句话说清「这一页的什么版式让你认为是新一份的首页」。
   写不出理由的候选不会被采纳。
4. 「confidence」是**你有多确定**（0 到 1）：0.9 以上 = 明确；0.6–0.9 = 比较像；0.6 以下 = 只是怀疑。
   **低于 0.6 的候选不会被自动切成边界，但会展示给管理员** —— 所以拿不准的也要给出来，
   如实给低分；**不要为了让它被采纳而虚报分数**。
5. **看不出边界就返回 {"candidates": []}**，不要猜。
6. **宁可少切，不可多切**：少切只是把整份当成一份处理（用户还能人工改），
   多切会把两份谱的页混进同一段、整份归错人。不确定的边界一律给低置信度。
7. 一份里含多个分声部（圆号 1、2、3 订在一起）**不构成边界** —— 那是别的字段的事。

以下全部是**这一次**的输入（变量放在最后，前面的规则部分是固定的，能吃前缀缓存）：

这份谱子共 ${pageCount} 页。
${missing.length ? `⚠️ 第 ${missing.join("、")} 页没取到文本（OCR 失败或空白）—— 不要在那几页上给候选。\n` : ""}
识别文本：
"""
${defuseFence(body)}
"""

结果：`;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 网关不验签（CI 用 --no-verify-jwt 部署，config.toml 的 verify_jwt 是死配置），
  // 所以必须在这里自己验 —— 否则拿到公开 publishable key 的任何人就能烧 DeepSeek 的额度。
  const auth = await requireUser(req, CORS_HEADERS);
  if (!auth.ok) return auth.response;

  try {
    // 请求体不是合法 JSON 时别把解析器原文回给前端（同 llm-analyze）
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const checked = validateBody(body);
    if ("error" in checked) {
      return json({ success: false, error: checked.error }, 400, CORS_HEADERS);
    }
    const { pages, pageCount } = checked;

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!apiKey) {
      return json({ success: false, error: 'DEEPSEEK_API_KEY not configured' }, 500, CORS_HEADERS);
    }

    const prompt = buildPrompt(pages, pageCount);

    // 带重试的 DeepSeek 调用：重试 / 退避 / 单次超时 / 失败报文都在 `../_shared/retry.ts`
    //（原本这段循环在 llm-analyze 里还有一份逐字相同的，两边一起改才会一致）。
    const outcome = await fetchJsonWithRetry(
      'https://api.deepseek.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          // 每个候选都要带 reason + evidence，比旧的 `cuts` 形状长得多；
          // 太小会被截断成非法 JSON（截断后的输出在 API 层与「弃权」同形，很难查）。
          max_tokens: 900,
          response_format: { type: 'json_object' },
        }),
      },
      retry,
    );

    if (outcome.ok) {
      const rawContent = outcome.data.choices?.[0]?.message?.content;
      // `?.` 只对 null/undefined 短路：上游若把 content 回成数字，`123?.trim()` 会直接抛
      const modelOutput = typeof rawContent === 'string' ? rawContent : '';
      // 解析用 trim 后的文本；回传给调用方的是**原文**（上面的 modelOutput）
      const responseText = modelOutput.trim();

      // 解析失败**不弃权整份请求**，而是走「不切」—— 与 parseCandidatePlan 的默认一致：
      // 不切 = 退回今天的行为（整份当一个声部），用户还能人工改。
      //
      // 模型若仍按旧形状（只有 cuts/evidence）回包，`parseCandidatePlan` 内部会自动退回旧解析
      // —— 契约只加不改，老客户端与旧模型的产物都还能读。
      const parsedOutput = parseModelOutput(responseText);
      const plan = parseCandidatePlan(parsedOutput.value, pages);

      // 平铺在顶层（同 llm-analyze 的约定：前端读 data.cuts）
      //
      // `cuts` / `evidence` 的语义与形状**不许变**（web 端与小程序都在读，老客户端也不会跟着改）；
      // `rawCuts` / `rejected` 是**只加不改**的排查字段：模型弃权时两个都是空，
      // 「模型给了切点但被丢掉」时 `rawCuts` 非空、`rejected` 里逐条写着理由 ——
      // 这两种情况过去在 API 层长得一模一样（见 `segment.ts` 的 REJECTION_REASONS）。
      //
      // `modelOutput` / `parsed` / `parseError` 同样**只加不改**，补上剩下那一半二义：
      //  · `parsed === true` 且 `cuts` 为空、`rejected` 为空 ⇒ 模型明确弃权；
      //  · `parsed === false` ⇒ 输出没解析出来（原文在 `modelOutput`，原因在 `parseError`）；
      //  · `parsed === true` 且 `rejected` 非空 ⇒ 切点被校验丢掉（逐条理由在 `rejected`）。
      // 只看 `rawCuts: []` 时前两种同形 —— 这正是这些字段存在的理由。
      //
      // `candidates`（pkuso-backend#96 §6 契约改造）同样**只加不改**：模型给的全部候选，
      // 每个带 `reason` / `confidence` / `accepted` / `rejection`。`cuts` 仍然只放
      // 「通过证据校验且置信度 ≥ MIN_CUT_CONFIDENCE」的那些 —— 老客户端读到的东西一字不变。
      return json({
        success: true,
        source: 'llm',
        ...plan,
        // 段区间由**同一份** plan 算出来，省得调用方各写一遍（那是「同一件事两处实现」的起点）
        ranges: planToRanges(plan, pageCount),
        pageCount,
        // 模型原文（超过 MAX_MODEL_OUTPUT_CHARS 时在值里标明已截断）
        modelOutput: clipModelOutput(modelOutput),
        parsed: parsedOutput.parsed,
        ...(parsedOutput.parseError === undefined ? {} : { parseError: parsedOutput.parseError }),
      }, 200, CORS_HEADERS);
    }

    return json({
      success: false,
      error: `LLM API error after ${outcome.attempts} attempt(s): ${outcome.error}`,
    }, 400, CORS_HEADERS);
  } catch (error) {
    // 不回内部异常原文：这里 catch 到的多是解构错误，与「识别失败」无关、只会误导排查
    console.error('segment-parts 未预期错误:', error);
    return json({ success: false, error: '服务内部错误' }, 500, CORS_HEADERS);
  }
}

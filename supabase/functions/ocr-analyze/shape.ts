/**
 * 把 OCR.space 的响应整成我们自己要的形状。纯函数，单独成模块的理由与 llm-analyze 相同：
 * index.ts 顶层会真的 `serve()` 绑端口，一被测试 import 就炸。
 *
 * **本模块不抛异常。** 上游是第三方，「字段改名 / 少给一个字段」是常态；那种时候应该
 * 退化成「这一次没有坐标」，而不是让整条上传流程失败 —— 坐标只用来把拼图里的文字
 * **分回各页**，缺了它调用方还能拿整段文本兜底，而抛出去就是整行分析失败。
 */

/**
 * 一个词在**提交图**上的坐标，原点在左上角。
 * 四个坐标**必然都是有限数字** —— 拿不到完整坐标的词根本不会出现在结果里，见 `parseWords`。
 *
 * ⚠️ **单位由上游决定，本模块不做量纲判断。** 它无从知道调用方提交的图有多高，
 * 猜不了的事就不该猜 —— 那个检查在**知道图高的人**那里（调用方；以及本次配套的
 * 验证脚本，那是**仓库外**的开发工具，不在本仓内，见 PR 描述）。
 *
 * 为什么值得专门写一条：若上游给的是**归一化坐标**（0~1），`lines.length` 依然正常、
 * `success` 依然 true、`overlayProvided` 依然 true —— **每一个健康信号都是对的**，
 * 而按 y 归页会把所有行都算到第 1 页。这是「看起来完全合法」的错答案，
 * 本仓最忌讳的那类；它不能靠本模块挡，只能靠知道图高的那一侧挡。
 */
export interface OcrWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 一行。坐标取该行内所有**有效**词的外接框 —— 调用方要按 `top` 把行归属到
 * 「拼图里的哪一页」，用整行的框比用单个词稳。
 */
export interface OcrLine {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  words: OcrWord[];
}

export interface OcrPage {
  /** 1-based，与 `ParsedResults` 的下标一致 */
  page: number;
  text: string;
  /** 只在请求了 overlay 时非空 */
  lines: OcrLine[];
  /**
   * **上游实际有没有给 overlay 结构**（读 `TextOverlay.HasOverlay`）。
   *
   * 这是调用方真正要的信号。回显请求参数（「你要了 overlay」）是同义反复 ——
   * 调用方自己就知道它传了什么，答不了「上游到底给没给」。
   */
  overlayProvided: boolean;
}

export interface OcrOutcome {
  /**
   * **第一页**的文本。前端一直只读这一个字段，所以保持原样不动。
   *
   * ⚠️ 多页输入时它不再是全部 —— 上一版只取 `ParsedResults[0]`，第 2 页往后会被
   * **静默丢掉**。页数看 `pageCount`，逐页文本看 `pages`（**总是**返回，不再要求 overlay）。
   */
  text: string;
  pageCount: number;
  /** 逐页结果。无 overlay 时 `lines` 为空数组，但 `text` 照样给 —— 见上面那条注释 */
  pages: OcrPage[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 解析成对象；上游给了 null / 字符串 / 数组时一律当空对象，避免后面到处判空 */
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * 坐标只认**有限数字**，其余一律返回 null。
 *
 * ⚠️ **不能用 `Number()` 去折**：`Number(null)`、`Number("")` 都是 0，`Number(true)` 是 1 ——
 * 那样一个「没有坐标的词」会变成**位于原点的合法坐标**，比丢掉它危险得多：
 * 它会参与外接框的 min/max，把**整行**拉到原点，于是那一行的文字被归到**第 1 页**，
 * 而第 3 页拿到空。这是「看起来完全合法」的错答案，正是本仓最忌讳的静默差异。
 */
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function parseWords(raw: unknown): OcrWord[] {
  const out: OcrWord[] = [];
  for (const w of arr(raw)) {
    const o = obj(w);
    const left = finite(o.Left);
    const top = finite(o.Top);
    const width = finite(o.Width);
    const height = finite(o.Height);
    // 四个坐标缺一个就**不要这个词**：`words[]` 的用途是几何（按坐标归页），
    // 没有几何的词留在这里只会毒化外接框。它的文字并没有丢 —— 整页的 ParsedText 还在。
    if (left === null || top === null || width === null || height === null) continue;
    out.push({ text: str(o.WordText), left, top, width, height });
  }
  return out;
}

/** 外接框。只在 words 非空时调用 */
function bounds(words: OcrWord[]): { left: number; top: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  // 用循环而不是 `Math.min(...words.map(...))`：展开成实参有上限，
  // 词数到十万量级会抛 RangeError，而那违背本模块「不抛异常」的契约。
  for (const w of words) {
    if (w.left < left) left = w.left;
    if (w.top < top) top = w.top;
    if (w.left + w.width > right) right = w.left + w.width;
    if (w.top + w.height > bottom) bottom = w.top + w.height;
  }
  // 宽高加下界：上游给了负的宽高时，调用方做区间包含判断（`y <= top + height`）
  // **永远匹配不上且不报错** —— 又一个「看起来合法」的坏值。
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function parseLines(overlay: unknown): OcrLine[] {
  const out: OcrLine[] = [];
  for (const raw of arr(obj(overlay).Lines)) {
    const o = obj(raw);
    const words = parseWords(o.Words);
    // 没有**有效**词的行走不到这里是有意的：空壳行留着只会在「按 y 归属」时多出一个 (0,0) 的框。
    // 注意判据是有效词数，不是原始条目数 —— `Words: [null]` 那种「换个形式的空壳」也要挡住。
    if (words.length === 0) continue;
    out.push({
      // trim 后再判真值：纯空白的 LineText 是**真值**，会把词的文本整个吞掉
      text: str(o.LineText).trim() || words.map((w) => w.text).join(" "),
      ...bounds(words),
      words,
    });
  }
  return out;
}

/**
 * `ParsedResults` 是**每页一条**（多页 PDF / 多页 TIFF 时不止一条）。
 * 我们目前只送单张图，所以恒为 1 条 —— 但**不能假设**，上一版就是假设成 1 才漏掉后面的页。
 */
export function shapeOcrResponse(data: unknown, wantOverlay: boolean): OcrOutcome {
  const results = arr(obj(data).ParsedResults);
  const pages: OcrPage[] = results.map((r, i) => {
    const o = obj(r);
    const overlay = obj(o.TextOverlay);
    return {
      page: i + 1,
      text: str(o.ParsedText),
      lines: wantOverlay ? parseLines(overlay) : [],
      overlayProvided: overlay.HasOverlay === true,
    };
  });
  return {
    text: pages[0]?.text ?? "",
    pageCount: pages.length,
    // 总是返回 pages：它曾经只在 overlay 时返回，于是 `pageCount` 与 `pages` 互相矛盾 ——
    // 不传 overlay 的调用方按注释去读逐页文本只会拿到 `[]`，却拿到一个对不上的 pageCount，
    // 那是又一处「HTTP 200 + success:true + 空数据」的静默降级。
    pages,
  };
}

/**
 * 把 OCR.space 的响应整成我们自己要的形状。纯函数，单独成模块的理由与 llm-analyze 相同：
 * index.ts 顶层会真的 `serve()` 绑端口，一被测试 import 就炸。
 *
 * **本模块不抛异常。** 上游是第三方，「字段改名 / 少给一个字段」是常态；那种时候应该
 * 退化成「这一次没有坐标」，而不是让整条上传流程失败 —— 坐标只用来把拼图里的文字
 * **分回各页**，缺了它调用方还能拿整段文本兜底，而抛出去就是整行分析失败。
 */

/** 一个词在**提交图**上的像素坐标（OCR.space overlay 的单位，原点在左上角） */
export interface OcrWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 一行。坐标取该行内所有词的外接框 —— 调用方要按 `top` 把行归属到
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
  /** 只在请求了 overlay 时非空；上游没给 overlay 时是空数组 */
  lines: OcrLine[];
}

export interface OcrOutcome {
  /**
   * **第一页**的文本。前端一直只读这一个字段，所以保持原样不动。
   *
   * ⚠️ 多页输入时它不再是全部 —— 上一版只取 `ParsedResults[0]`，
   * 第 2 页往后会被**静默丢掉**。页数看 `pageCount`，逐页文本看 `pages`。
   */
  text: string;
  pageCount: number;
  /** 只在请求了 overlay 时返回（没请求时是空数组，不是 undefined，省得调用方判两遍） */
  pages: OcrPage[];
}

const num = (
  v: unknown,
): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 解析成对象；上游给了 null / 字符串 / 数组时一律当空对象，避免后面到处判空 */
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function parseWords(raw: unknown): OcrWord[] {
  return arr(raw).map((w) => {
    const o = obj(w);
    // 坐标一律走 num()：上游偶尔给字符串数字或干脆不给，
    // 直接透传会让 NaN 一路流进外接框计算（Math.min(NaN, x) 恒为 NaN）
    return {
      text: str(o.WordText),
      left: num(o.Left),
      top: num(o.Top),
      width: num(o.Width),
      height: num(o.Height),
    };
  });
}

function parseLines(overlay: unknown): OcrLine[] {
  const out: OcrLine[] = [];
  for (const raw of arr(obj(overlay).Lines)) {
    const o = obj(raw);
    const words = parseWords(o.Words);
    // 没有词的行直接丢：空壳行留着只会在「按 y 归属」时多出一个无意义的框
    if (words.length === 0) continue;
    const left = Math.min(...words.map((w) => w.left));
    const top = Math.min(...words.map((w) => w.top));
    out.push({
      // 上游没给 LineText 时用词拼一个 —— 有 words 却整行没字是自相矛盾的输入
      text: str(o.LineText) || words.map((w) => w.text).join(" "),
      left,
      top,
      width: Math.max(...words.map((w) => w.left + w.width)) - left,
      height: Math.max(...words.map((w) => w.top + w.height)) - top,
      words,
    });
  }
  return out;
}

/**
 * `ParsedResults` 是**每页一条**（多页 PDF / 多页 TIFF 时不止一条）。
 * 我们目前只送单张图，所以恒为 1 条 —— 但**不能假设**，上一版就是假设成 1 才漏掉后面的页。
 */
export function shapeOcrResponse(
  data: unknown,
  wantOverlay: boolean,
): OcrOutcome {
  const results = arr(obj(data).ParsedResults);
  const pages: OcrPage[] = results.map((r, i) => {
    const o = obj(r);
    return {
      page: i + 1,
      text: str(o.ParsedText),
      lines: wantOverlay ? parseLines(o.TextOverlay) : [],
    };
  });
  return {
    text: pages[0]?.text ?? "",
    pageCount: pages.length,
    pages: wantOverlay ? pages : [],
  };
}

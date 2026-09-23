/**
 * 把 OCR.space 的响应整成我们自己要的形状。纯函数，单独成模块的理由与 llm-analyze 相同：
 * index.ts 顶层会真的 `serve()` 绑端口，一被测试 import 就炸。
 *
 * **本模块不抛异常。** 上游是第三方，「字段改名 / 少给一个字段」是常态；那种时候应该
 * 退化成「这一次没有坐标」，而不是让整条上传流程失败 —— 坐标只用来把拼图里的文字
 * **分回各页**，缺了它调用方还能拿整段文本兜底，而抛出去就是整行分析失败。
 *
 * ⚠️ 但「退化成没有坐标」不等于「悄悄换成一个看起来合法的坐标」—— 后者是本仓最忌讳的
 * 静默差异，本文件的历史上就栽过：坏坐标折成 0 之后变成原点上的幽灵词，
 * 把整行的外接框拖到原点，于是那一行的文字被归到**第 1 页**，而真正的页拿到空。
 */

/**
 * 一个词在**提交图**上的坐标，原点在左上角。
 *
 * 四个坐标**必然都是有限数且非负** —— 位置不可用的词根本不会出现在结果里，
 * 宽/高缺省为 0，见 `parseWords`。
 *
 * ⚠️ **单位由上游决定，本模块不做量纲判断。** 它无从知道调用方提交的图有多高，
 * 猜不了的事就不该猜 —— 那个检查在**知道图高的人**那里（调用方；以及本次配套的
 * 验证脚本，那是**仓库外**的开发工具，不在本仓内，见 PR 描述）。
 *
 * 为什么值得专门写一条：若上游给的是**归一化坐标**（0~1），`lines.length` 依然正常、
 * `success` 依然 true、`upstreamHasOverlay` 依然 true —— **每一个健康信号都是对的**，
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
 * 一行。坐标取该行内所有**可定位**词的外接框 —— 调用方要按 `top` 把行归属到
 * 「拼图里的哪一页」，用整行的框比用单个词稳。
 */
export interface OcrLine {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * 本行的**可定位**词。位置不可用的词不在这里 —— 它们会把外接框拖到原点。
   * 它们的文字并没有因此丢掉：`text` 是整个行的文本（来自上游的 LineText），
   * 整页的 `ParsedText` 也还在 `OcrPage.text`。
   */
  words: OcrWord[];
}

export interface OcrPage {
  /** 1-based，与 `ParsedResults` 的下标一致 */
  page: number;
  text: string;
  /**
   * 可定位的行。**这是「这一页有没有可用坐标」的唯一权威** —— 只在请求了 overlay 时非空。
   *
   * ⚠️ 空数组有两个来源，靠 `upstreamHasOverlay` 分辨：上游没给，或给了但没有一行能定位。
   */
  lines: OcrLine[];
  /**
   * **上游**有没有附带 overlay 结构（读 `TextOverlay.HasOverlay`）。这是**诊断信号**，
   * 不是「这里有坐标可用」—— 后者看 `lines`。
   *
   * - `true` + `lines: []`：上游给了，但我们一行都没解析出来（字段名不符／这页没文字）
   * - `false` + `lines: []`：上游压根没给
   *
   * 名字刻意叫 upstreamHasOverlay 而不是 `overlayProvided`：后者读起来像「已提供坐标」，
   * 而它答的其实是「上游附带了一个 overlay 结构」—— 早先那个名字会让调用方
   * 在「上游少给 HasOverlay 字段」时误以为没有坐标可用，把手上真实可用的 `lines` 丢掉。
   */
  upstreamHasOverlay: boolean;
  /**
   * 上游标记这一页**解析失败**（`FileParseExitCode` 非 1）。
   *
   * 必须与「这一页没有文字」区分开：后者是正常结果（纯谱面），前者是这次调用出了问题。
   * 混在一起的话，`text` 为空就分不清是「没字」还是「失败了」—— 而 `pages` 已经是对外
   * 文档化的逐页接口了。
   */
  failed: boolean;
  /** 失败原因，仅 `failed` 为真时出现 */
  error?: string;
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
 * 坐标读法：**只认能得到有限数的东西** —— number 本身，或非空的数字字符串
 * （上游偶尔把数字序列化成字符串；这一条是从旧实现注释里"上游偶尔给字符串数字"继承来的）。
 *
 * 拒绝 `null` / `""` / 布尔：这几个正是 `Number()` 会折成 0 的毒，而 **0 是一个看起来
 * 完全合法的坐标**。折成 0 的后果不是「退化成没有坐标」，是「退化成坐标是错的、
 * 却看不出来」—— 幽灵词会把整行拖到原点。
 */
const coord = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function parseWords(raw: unknown): OcrWord[] {
  const out: OcrWord[] = [];
  for (const w of arr(raw)) {
    const o = obj(w);
    const left = coord(o.Left);
    const top = coord(o.Top);
    // **只有位置是必需的**（且必须非负 —— 负坐标是「第 0 页」那种越界值的来源）。
    // 缺位置或位置为负的词无法归页，留着只会毒化外接框，所以丢词；
    // 它的文字没丢，见 OcrLine.words 的注释。
    //
    // ⚠️ 宽/高**不在**这个判据里：上一版要求四个坐标齐全，于是「位置已知、只少个 Height」
    // 的词被整词丢掉、整行跟着消失，而 success / upstreamHasOverlay 一切正常 ——
    // 那正是本文件要消灭的那类静默。宽高只影响框的大小，按 0 处理是诚实的。
    if (left === null || top === null || left < 0 || top < 0) continue;
    out.push({
      text: str(o.WordText),
      left,
      top,
      // 下界夹在**词级**：负宽高会让调用方的区间包含判断（`y <= top + height`）
      // 永远匹配不上且不报错。只夹行级的话，同一个 OcrLine 里 line 与 words 会互相矛盾。
      width: Math.max(0, coord(o.Width) ?? 0),
      height: Math.max(0, coord(o.Height) ?? 0),
    });
  }
  return out;
}

/** 外接框。只在 words 非空（且都非负）时调用 */
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
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function parseLines(overlay: unknown): OcrLine[] {
  const out: OcrLine[] = [];
  for (const raw of arr(obj(overlay).Lines)) {
    const o = obj(raw);
    const words = parseWords(o.Words);
    // 没有**可定位**词的行走不到这里：它无法归属到任何一页，留着只会在「按 y 归属」时
    // 多出一个 (0,0) 的框。判据是有效词数，不是原始条目数 —— `Words: [null]` 那种
    // 「换个形式的空壳」也要挡住。
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
    // 上游的 FileParseExitCode：1 = 成功。字段缺失时**不判失败**（别把「上游没给这个字段」
    // 说成「这一页失败了」）—— 与 overlay 字段名同类的未知，按保守方向处理。
    const exitCode = o.FileParseExitCode;
    const failed = exitCode !== undefined && Number(exitCode) !== 1;
    const message = str(o.ErrorMessage).trim();
    return {
      page: i + 1,
      text: str(o.ParsedText),
      lines: wantOverlay ? parseLines(overlay) : [],
      upstreamHasOverlay: overlay.HasOverlay === true,
      failed,
      ...(failed && message ? { error: message } : {}),
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

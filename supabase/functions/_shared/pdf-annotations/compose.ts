/**
 * pdf-lib 适配层：把规范化后的笔迹画到原 PDF 的页上，返回**新的** PDF 字节。
 *
 * ## 为什么是「矢量叠加」而不是「栅格合成」
 *
 * 三条路都评估过（见 PR 描述）：本仓库能选的第三条只有 pdf-lib 这类纯 JS 的 PDF 库。
 *
 * 1. **矢量叠加（本文件）**：把笔迹作为**新的内容流**追加到原页面上。
 *    已嵌入的扫描图既不解码也不重编码（pdf-lib 原样搬运），所以
 *    **产物大小 ≈ 原件 + 追加的那点内容流**，内存是 O(文件大小) 而不是 O(像素)，
 *    笔迹在任意缩放下都是清晰的矢量。
 * 2. **栅格合成**：需要「页图 → 解码 → 画 → 再编码 → 装回 PDF」。Deno 里没有 canvas，
 *    JPEG 的解码/编码得用纯 JS 做；一页 A4 300dpi 的 RGBA 就是 ~34MB，几十页必然撞破
 *    isolate 的 256MB 上限，而且重编码会**再压一次**已经压过的扫描件（质量下降）。
 * 3. **客户端合成**（小程序有 canvas、批注层还已经画好了）：出局得最干脆 ——
 *    小程序分包有 2MB 上限（阅读器分包里的 pdf.js 运行时已经因此拿掉过一次），
 *    而产物要求是「一份可直接分享的 PDF」，小程序手里没有 PDF 写入器。
 *
 * ## 一笔 = 一条路径（不是「一段一条」）
 *
 * 同一个折线若按段分别描边，相邻两段在端点处**各自**画了一个圆头，半透明（荧光笔
 * `alpha = 0.5`）时重叠处会变深 —— 一条笔迹上出现一串深色斑。所以整笔拼成一条路径
 * 再 `S` 一次：重叠只发生在同一笔内部，而同一笔本来就是一次合成，不该加深。
 *
 * ## 与客户端逐项对齐
 *
 * | 客户端（`pkuso-mp/src/pages/score-reader/lib/anno-draw.ts`） | 这里 |
 * | --- | --- |
 * | `lineCap='round'` / `lineJoin='round'` | `LineCapStyle.Round` / `LineJoinStyle.Round` |
 * | `globalAlpha`（荧光笔 0.5） | `/ExtGState << /ca a /CA a >>` + `gs` |
 * | 单点笔迹只 `moveTo` ⇒ **不画** | 同样不画（见 `paint.ts` 的 `dots`） |
 * | `lineWidth = max(1, width × 画布宽px)` | `width × 页宽pt`（像素下限不搬，见 `strokeWidthPt`） |
 */

import {
  type PDFName,
  type PDFPage,
  PDFDocument,
  LineCapStyle,
  LineJoinStyle,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setDashPattern,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "npm:pdf-lib@1.17.1";

import {
  type ComposableStroke,
  mapPoint,
  type NormalizedAnnotations,
  normalizeAnnotations,
  normalizeRotation,
  type PageGeom,
  strokeWidthPt,
} from "./paint.ts";

/**
 * 一册批注的笔数上限。正常批注的量级是每册几十到几百笔，这个数高出两个数量级 ——
 * 它挡的不是「画得多的人」，是**数据异常**（例如某天误把 pixel 路径当笔迹写进来）：
 * 每笔要多写几十个操作符，几万笔足以把 CPU 和内容流撑爆。
 */
export const MAX_TOTAL_STROKES = 5000;

/** 笔数超上限。调用方据此回一个**明说原因**的 413，而不是等到超时。 */
export class TooManyStrokesError extends Error {
  constructor(readonly drawn: number, readonly limit: number) {
    super(`too many strokes: ${drawn} > ${limit}`);
    this.name = "TooManyStrokesError";
  }
}

export type ComposeResult = {
  /** 合成后的 PDF（原件的副本 + 追加的笔迹内容流） */
  bytes: Uint8Array;
  pageCount: number;
  /** 真正被画到笔迹的页数 */
  annotatedPages: number;
} & Pick<NormalizedAnnotations, "drawn" | "dots" | "skipped" | "outOfRange">;

/**
 * 一页的几何：**CropBox**（不是 MediaBox）+ 归一化后的 `/Rotate`。
 *
 * 页图是 pdf.js 按 CropBox 裁、并按 `/Rotate` 转好之后渲染的，所以这里必须用同一套
 * 口径；pdf-lib 的 `getSize()` 用的是 MediaBox，在有裁切的页面上会整体偏一个边距。
 */
export function pageGeom(page: PDFPage): PageGeom {
  const box = page.getCropBox();
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: normalizeRotation(page.getRotation().angle),
  };
}

/**
 * 原 PDF + 批注行 → 带批注的 PDF。
 *
 * `rows` 是 `sheet_music_annotations` 的行（`{ page, strokes }`），原样传进来即可：
 * 畸形数据在 `normalizeAnnotations` 里被跳过并计数，不会让整单失败。
 */
export async function composeAnnotatedPdf(
  src: Uint8Array,
  rows: unknown,
): Promise<ComposeResult> {
  const doc = await PDFDocument.load(src);
  const pageCount = doc.getPageCount();
  const anns = normalizeAnnotations(rows, pageCount);

  if (anns.drawn > MAX_TOTAL_STROKES) {
    throw new TooManyStrokesError(anns.drawn, MAX_TOTAL_STROKES);
  }

  // 同一页、同一个 alpha 只建一个 ExtGState（pdf-lib 的 uniqueKey 每次调用都会新开一个，
  // 一笔一个的话内容流里会堆出成百上千个同样的字典）
  const gsCache = new WeakMap<PDFPage, Map<number, PDFName>>();

  for (const { page, strokes } of anns.pages) {
    const target = doc.getPage(page - 1);
    const geom = pageGeom(target);
    for (const s of strokes) drawStroke(doc, target, s, geom, gsCache);
  }

  const bytes = await doc.save();
  return {
    bytes,
    pageCount,
    annotatedPages: anns.pages.length,
    drawn: anns.drawn,
    dots: anns.dots,
    skipped: anns.skipped,
    outOfRange: anns.outOfRange,
  };
}

/** 一条折线画成**一条路径**（理由见文件头）。 */
function drawStroke(
  doc: PDFDocument,
  page: PDFPage,
  s: ComposableStroke,
  geom: PageGeom,
  gsCache: WeakMap<PDFPage, Map<number, PDFName>>,
): void {
  const pts = s.points.map(([nx, ny]) => mapPoint(nx, ny, geom));
  const first = pts[0];

  page.pushOperators(
    pushGraphicsState(),
    ...(s.alpha < 1 ? [setGraphicsState(graphicsStateFor(doc, page, s.alpha, gsCache))] : []),
    setStrokingRgbColor(s.color.r, s.color.g, s.color.b),
    setLineWidth(strokeWidthPt(s.width, geom)),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    // 显式清掉虚线：我们继承的是页面既有的图形状态，而原内容流若以不平衡的 q/Q 收尾，
    // 虚线模式可能还留着（`drawLine` 自己也做这一步）
    setDashPattern([], 0),
    moveTo(first.x, first.y),
    ...pts.slice(1).map((p) => lineTo(p.x, p.y)),
    stroke(),
    popGraphicsState(),
  );
}

/**
 * 半透明用的 `/ExtGState`：`ca`（非描边）/ `CA`（描边）都写上 —— 我们只描边，
 * 两个都写是零成本的稳妥（不同阅读器历史上对「描边该读哪个」有过分歧）。
 */
function graphicsStateFor(
  doc: PDFDocument,
  page: PDFPage,
  alpha: number,
  gsCache: WeakMap<PDFPage, Map<number, PDFName>>,
): PDFName {
  let perPage = gsCache.get(page);
  if (!perPage) {
    perPage = new Map();
    gsCache.set(page, perPage);
  }
  const hit = perPage.get(alpha);
  if (hit) return hit;

  const dict = doc.context.obj({ Type: "ExtGState", ca: alpha, CA: alpha });
  const key = page.node.newExtGState("GS", dict);
  perPage.set(alpha, key);
  return key;
}

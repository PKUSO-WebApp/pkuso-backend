/**
 * 「把批注烧进 PDF」的纯逻辑：坐标换算、颜色解析、笔迹校验、页映射。
 *
 * 这里**不 import pdf-lib、不碰网络、不用 Deno API** —— 全是可以直接单测的纯函数。
 * 抽出来的理由不是「整洁」，而是这批东西恰好最难自查：一个 y 轴没翻、一个 `/Rotate`
 * 没算，产物**照样是一份合法 PDF**、笔迹只是画在错的地方，集成测试里根本看不出来。
 *
 * ## 三套坐标系，别混
 *
 * 1. **归一化坐标**（客户端存进 `strokes` 的那套）：`[0,1] × [0,1]`，原点在**页图左上角**。
 *    它相对的是「渲染出来的整页图像」，而那张图是 pdf.js `getViewport()` 的产物 ——
 *    **已经吃掉了页面的 `/Rotate`**（见 pkuso-web 的 page-previews.ts）。
 * 2. **页图坐标**（客户端画布）：归一化 × 画布像素尺寸。客户端画的就是这套。
 * 3. **PDF 用户空间**（下面要落到的）：原点在 **CropBox 左下角**、y 轴向上，单位 pt。
 *
 * 难点全在 1 → 3：既要翻 y，又要把 `/Rotate` 反着转回去（页图是转过的，PDF 用户空间没转）。
 * `mapPoint` 的四个分支就是这件事，别把它简化成「只有一个 y 翻转公式」。
 *
 * ## 为什么用 CropBox 而不是 MediaBox
 *
 * pdf.js 渲染页图时裁的是 **CropBox**（`page.view`），而 pdf-lib 的 `getSize()` 给的是
 * **MediaBox** —— 两者在有裁切的 PDF 上不一样。用错的表现同样是「笔迹整体偏移一个边距」。
 * 所以几何一律来自 `getCropBox()`（pdf-lib 在没有 CropBox 时会回退到 MediaBox，正合适）。
 */

/** 客户端不写 `alpha` 字段时的不透明度（`pkuso-mp` 的 `stroke.alpha ?? 1`）。 */
export const DEFAULT_ALPHA = 1;

/**
 * 归一化线宽（占页宽的比例）的合法上界。客户端最粗的荧光笔是 0.032，这里留了一个
 * 数量级的余量 —— 它防的是**脏数据**（例如某天误把像素值 12 存了进来），不是正常笔迹。
 */
export const MAX_WIDTH_RATIO = 0.2;

export type Rgb = { r: number; g: number; b: number };
export type Point = { x: number; y: number };
export type Rotation = 0 | 90 | 180 | 270;

/** 一页的几何：CropBox 在 PDF 用户空间里的位置与旋转。 */
export type PageGeom = {
  /** CropBox 左下角 */
  x: number;
  y: number;
  /** CropBox 宽高（**未旋转**，PDF 用户空间） */
  width: number;
  height: number;
  rotation: Rotation;
};

/**
 * 页面的 `/Rotate` 归一化到 {0,90,180,270}。
 * PDF 里它可以是负数或超过 360（`-90`、`450` 都合法），pdf-lib 的 `getRotation().angle`
 * 原样返回，所以这里必须归一化 —— 否则 `mapPoint` 会落进 `default` 分支、静默按 0° 处理。
 */
export function normalizeRotation(angle: number): Rotation {
  if (!Number.isFinite(angle)) return 0;
  const a = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return a as Rotation;
}

/**
 * 归一化点 → PDF 用户空间点。
 *
 * | `/Rotate` | x              | y              |
 * | --- | --- | --- |
 * | 0   | `ox + nx·w`    | `oy + (1−ny)·h` |
 * | 90  | `ox + ny·w`    | `oy + nx·h`     |
 * | 180 | `ox + (1−nx)·w`| `oy + ny·h`     |
 * | 270 | `ox + (1−ny)·w`| `oy + (1−nx)·h` |
 *
 * 四个式子是从 pdf.js `PageViewport` 的 transform 反解出来的（它以 CropBox **中心**为
 * 原点旋转，并把 y 翻过来）：
 *
 * ```
 * rotate 0  ：X = s·(x−ox)      Y = s·(oy+h−y)
 * rotate 90 ：X = s·(y−oy)      Y = s·(x−ox)
 * rotate 180：X = s·(ox+w−x)    Y = s·(y−oy)
 * rotate 270：X = s·(oy+h−y)    Y = s·(ox+w−x)
 * ```
 *
 * 其中 `nx = X / (s·页图宽)`、`ny = Y / (s·页图高)`，而页图宽高在 90/270 时是 w/h 对调
 * （`rotation % 180 === 0 ? viewBox[2] : viewBox[3]`）—— 把 nx/ny 的代换解开就是上表。
 *
 * ⚠️ 只有 0° 才走「就是翻个 y」这条直觉路径。另外三条是真实存在的（扫描的竖版声部
 * 常有 `/Rotate 90`），漏掉它们的表现是**整页笔迹错位且不报任何错**。
 */
export function mapPoint(nx: number, ny: number, g: PageGeom): Point {
  const { x: ox, y: oy, width: w, height: h, rotation } = g;
  switch (rotation) {
    case 90:
      return { x: ox + ny * w, y: oy + nx * h };
    case 180:
      return { x: ox + (1 - nx) * w, y: oy + ny * h };
    case 270:
      return { x: ox + (1 - ny) * w, y: oy + (1 - nx) * h };
    default:
      return { x: ox + nx * w, y: oy + (1 - ny) * h };
  }
}

/**
 * 线宽（占**页图宽**的比例）→ PDF 点宽。
 *
 * 客户端的式子是 `lineWidth = max(1, width × 画布宽px)`。那个 `max(1, …)` 是**像素下限**
 * （防极细的线在光栅上消失），不是设计约束，所以刻意**不搬到这里**：在矢量空间里按输出
 * 分辨率加下限，等于让同一份批注在不同缩放下线宽不同。去掉之后线宽只由 `width` 决定，
 * 与客户端在正常分辨率下的观感一致（1px 约为页宽的 0.05~0.1%，而最细的笔是 0.4%，
 * 差一个量级，所以那个下限在正常分辨率下本来也不生效）。
 *
 * ⚠️ 分母是**页图的宽**，不是 CropBox 的宽：90°/270° 时页图的宽对应的是 PDF 的**高**。
 */
export function strokeWidthPt(width: number, g: PageGeom): number {
  const span = g.rotation === 90 || g.rotation === 270 ? g.height : g.width;
  return width * span;
}

/**
 * `#rgb` / `#rrggbb`（大小写、`#` 可省）→ 0~1 的 RGB。其余一律 null，调用方据此跳过这一笔。
 *
 * 只认这两种：客户端写的就是 6 位十六进制（`PEN_COLORS` / 用户自选色），
 * 8 位带 alpha 的写法不存在（不透明度是独立字段），不必替它猜。
 */
export function parseHexColor(input: unknown): Rgb | null {
  if (typeof input !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

export type ComposableStroke = {
  color: Rgb;
  /** 占页宽的比例（与客户端同一个量纲） */
  width: number;
  alpha: number;
  /** 归一化点，已 clamp 到 [0,1] */
  points: Array<[number, number]>;
};

/** 库里那一行 `page` 是否是一个能用的页号（正整数）。 */
function pageNumberOf(row: unknown): number | null {
  if (typeof row !== "object" || row === null) return null;
  const page = (row as { page?: unknown }).page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  return page;
}

/**
 * 一条笔迹的宽松 JSON → 可画的笔迹；**任何一处畸形都返回 null**（调用方跳过并计数）。
 *
 * 判据是「能不能确定它画出来是什么」，不是「像不像客户端写的」：
 * - 颜色/线宽/点数任一说不清 → 丢掉整笔（半条笔迹比没有更糟，它会撒谎）；
 * - 坐标越界 → **clamp 到 [0,1]**。归一化坐标的定义域就是 0~1（客户端自己就 clamp），
 *   多一个点越界不该让整笔消失；
 * - `alpha` 缺省按 1（与客户端 `stroke.alpha ?? 1` 一致）。
 */
export function normalizeStroke(raw: unknown): ComposableStroke | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = raw as { color?: unknown; width?: unknown; alpha?: unknown; points?: unknown };

  const color = parseHexColor(s.color);
  if (!color) return null;

  const width = s.width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > MAX_WIDTH_RATIO) {
    return null;
  }

  let alpha = DEFAULT_ALPHA;
  if (s.alpha !== undefined && s.alpha !== null) {
    if (typeof s.alpha !== "number" || !Number.isFinite(s.alpha) || s.alpha < 0 || s.alpha > 1) {
      return null;
    }
    alpha = s.alpha;
  }

  if (!Array.isArray(s.points) || s.points.length === 0) return null;
  const points: Array<[number, number]> = [];
  for (const p of s.points) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const [nx, ny] = p as [unknown, unknown];
    if (typeof nx !== "number" || typeof ny !== "number") return null;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
    points.push([clamp01(nx), clamp01(ny)]);
  }

  return { color, width, alpha, points };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export type PageStrokes = { page: number; strokes: ComposableStroke[] };

export type NormalizedAnnotations = {
  /** 只含「真的会画出东西」的页，按页号升序 */
  pages: PageStrokes[];
  /** 会被画出来的笔数（点数 ≥ 2） */
  drawn: number;
  /**
   * 单点笔迹（用户点一下）。**两边都不画**：客户端 `drawPolylineOn` 对第一个点只
   * `moveTo`，而 canvas 对「只有 moveTo 的子路径」不描边 —— 所以 PDF 里也同等地不画，
   * 否则就成了「用户从没见过的一团墨」。单独计数是为了让它可见。
   */
  dots: number;
  /** 畸形数据（颜色/线宽/alpha/坐标不是数、0 个点、page 不是正整数）—— 跳过并报数 */
  skipped: number;
  /** 页号超出这份 PDF 的页数（多半是 PDF 被换成了更短的一份） */
  outOfRange: number;
};

/**
 * `sheet_music_annotations` 的行 → 可画的按页分组。
 *
 * 畸形一律**跳过而不是整单报错**：库里的数据是历史累积的，一条坏笔迹不该让用户
 * 连整份批注都导不出来。跳过的量在响应里如实报出来（`skippedStrokes` 等），
 * 让「少画了几笔」是可见的，而不是静默的。
 */
export function normalizeAnnotations(rows: unknown, pdfPageCount: number): NormalizedAnnotations {
  const byPage = new Map<number, ComposableStroke[]>();
  const out: NormalizedAnnotations = {
    pages: [],
    drawn: 0,
    dots: 0,
    skipped: 0,
    outOfRange: 0,
  };
  if (!Array.isArray(rows)) return out;

  for (const row of rows) {
    const rawList = (row as { strokes?: unknown } | null)?.strokes;
    const list: unknown[] = Array.isArray(rawList) ? rawList : [];

    const page = pageNumberOf(row);
    if (page === null) {
      // 连页号都读不出来：这一行的内容一律算跳过（没有 strokes 数组时至少计 1，
      // 免得「一行坏数据」在计数上完全隐形）。
      out.skipped += Math.max(list.length, 1);
      continue;
    }
    if (page > pdfPageCount) {
      out.outOfRange += list.length;
      continue;
    }
    if (!Array.isArray(rawList)) {
      // 页号好端端的、`strokes` 却不是数组（列上只有 NOT NULL + 默认 '[]'，挡不住
      // `'{"a":1}'::jsonb` 这类写坏的值）。同样要计数：坏数据不能隐形。
      out.skipped += 1;
      continue;
    }

    for (const raw of list) {
      const stroke = normalizeStroke(raw);
      if (!stroke) {
        out.skipped += 1;
        continue;
      }
      if (stroke.points.length < 2) {
        out.dots += 1;
        continue;
      }
      out.drawn += 1;
      const bucket = byPage.get(page);
      if (bucket) bucket.push(stroke);
      else byPage.set(page, [stroke]);
    }
  }

  out.pages = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, strokes]) => ({ page, strokes }));
  return out;
}

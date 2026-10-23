import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  MAX_WIDTH_RATIO,
  mapPoint,
  type NormalizedAnnotations,
  normalizeAnnotations,
  normalizeRotation,
  normalizeStroke,
  type PageGeom,
  parseHexColor,
  type Rgb,
  strokeWidthPt,
} from "./paint.ts";

/**
 * 跑法：`deno test --allow-env supabase/functions/compose-annotated-pdf/`
 *
 * ## 这个文件守的是什么
 *
 * 全是**在产物里看不出来**的东西：坐标翻错、`/Rotate` 漏算、线宽量纲不对、脏数据
 * 静默消失 —— 这几种错都会产出一份完全合法的 PDF，只是笔迹画在错的地方或干脆少了。
 * 所以期望值不是从实现里抄的，是按坐标系自己推的（每个数下面写了怎么来的）。
 *
 * ⚠️ `mapPoint` 那几条是**唯一**能盯住 `/Rotate` 的地方：库里没有一份带 `/Rotate` 的
 * 真实谱子，线上也验不了（见 PR 的「没能验证的部分」）。
 */

/** 一个**非零 CropBox 原点**的页面：原点偏移是最容易被漏掉的一项（`ox`/`oy` 忘了加）。 */
const GEOM: PageGeom = { x: 10, y: 20, width: 400, height: 600, rotation: 0 };

const geomWith = (rotation: PageGeom["rotation"]): PageGeom => ({ ...GEOM, rotation });

const round = (n: number) => Math.round(n * 1000) / 1000;
const at = (nx: number, ny: number, g: PageGeom = GEOM) => {
  const p = mapPoint(nx, ny, g);
  return [round(p.x), round(p.y)];
};

// ---------------------------------------------------------------- 坐标换算

Deno.test("mapPoint：0° —— 只有这一条是「翻个 y」，四个角都要落在 CropBox 上", () => {
  const g = geomWith(0);
  // 页图左上角 (0,0) → PDF 的**上**左角（y 轴向上，所以是 oy+h）
  assertEquals(at(0, 0, g), [10, 620]);
  assertEquals(at(1, 0, g), [410, 620]);
  assertEquals(at(0, 1, g), [10, 20]);
  assertEquals(at(1, 1, g), [410, 20]);
  // 内部点：x=10+0.5·400=210；y=20+(1−0.25)·600=470
  assertEquals(at(0.5, 0.25, g), [210, 470]);
});

Deno.test("mapPoint：90° —— 页图的 x 轴对应 PDF 的 y 轴（不是「翻 y 再转」）", () => {
  const g = geomWith(90);
  // nx=0,ny=0 → (ox, oy) = (10,20)；页图横向走到头（nx=1）是 PDF 的**上**边（oy+h=620）
  assertEquals(at(0, 0, g), [10, 20]);
  assertEquals(at(1, 0, g), [10, 620]);
  assertEquals(at(0, 1, g), [410, 20]);
  assertEquals(at(1, 1, g), [410, 620]);
  // x=10+0.25·400=110（吃的是 ny）；y=20+0.5·600=320（吃的是 nx）
  assertEquals(at(0.5, 0.25, g), [110, 320]);
});

Deno.test("mapPoint：180° —— 两轴同时反向（页图左上角 = PDF 右下角）", () => {
  const g = geomWith(180);
  assertEquals(at(0, 0, g), [410, 20]);
  assertEquals(at(1, 0, g), [10, 20]);
  assertEquals(at(0, 1, g), [410, 620]);
  assertEquals(at(1, 1, g), [10, 620]);
});

Deno.test("mapPoint：270° —— 两轴都反、且对调（页图左上角 = PDF 右上角）", () => {
  const g = geomWith(270);
  assertEquals(at(0, 0, g), [410, 620]);
  assertEquals(at(1, 0, g), [410, 20]);
  assertEquals(at(0, 1, g), [10, 620]);
  assertEquals(at(1, 1, g), [10, 20]);
});

Deno.test("mapPoint：画面宽高比与 PDF 宽高比不一致时也不串轴（4 个角全对即可）", () => {
  // 非正方形 CropBox + 非 0 原点：把 x/y 弄反或漏掉 ox/oy 的实现，上面那几条里有活口，
  // 这一条（400×600）能把它们堵死：90° 时 x 方向的可达范围是 400 而 y 方向是 600。
  for (const rotation of [0, 90, 180, 270] as const) {
    const g = geomWith(rotation);
    const xs = [at(0, 0, g)[0], at(1, 1, g)[0], at(1, 0, g)[0], at(0, 1, g)[0]].sort((a, b) => a - b);
    const ys = [at(0, 0, g)[1], at(1, 1, g)[1], at(1, 0, g)[1], at(0, 1, g)[1]].sort((a, b) => a - b);
    assertEquals(xs, [10, 10, 410, 410], `${rotation}° 的 x 范围`);
    assertEquals(ys, [20, 20, 620, 620], `${rotation}° 的 y 范围`);
  }
});

Deno.test("normalizeRotation：负数、超过 360、非 90 的倍数都要归到四档", () => {
  assertEquals(normalizeRotation(0), 0);
  assertEquals(normalizeRotation(90), 90);
  assertEquals(normalizeRotation(180), 180);
  assertEquals(normalizeRotation(270), 270);
  assertEquals(normalizeRotation(-90), 270); // PDF 里合法写法
  assertEquals(normalizeRotation(360), 0);
  assertEquals(normalizeRotation(450), 90);
  assertEquals(normalizeRotation(-450), 270);
  assertEquals(normalizeRotation(88), 90); // 舍入到最近的 90°
  assertEquals(normalizeRotation(NaN), 0); // 读不出来时按 0（pdf-lib 缺 Rotate 就是 0）
});

Deno.test("strokeWidthPt：分母是页图宽 —— 90°/270° 时它对应 PDF 的高", () => {
  // 0.004 × 400 = 1.6（0°/180°）
  assertEquals(strokeWidthPt(0.004, geomWith(0)), 1.6);
  assertEquals(strokeWidthPt(0.004, geomWith(180)), 1.6);
  // 0.004 × 600 = 2.4（90°/270°：页图的宽是 CropBox 的高）
  assertEquals(strokeWidthPt(0.004, geomWith(90)), 2.4);
  assertEquals(strokeWidthPt(0.004, geomWith(270)), 2.4);
  // 最粗的荧光笔 0.032
  assertEquals(round(strokeWidthPt(0.032, geomWith(0))), 12.8);
});

// ---------------------------------------------------------------- 颜色

function assertRgb(hex: string, expected: [number, number, number]) {
  const rgb = parseHexColor(hex);
  if (!rgb) throw new Error(`${hex} 应该能解析`);
  // 比 0~255 的整数：0~1 的浮点比较要么写 eps、要么在断言里看不出「偏了多少」
  assertEquals(
    [Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255)],
    expected,
    hex,
  );
}

Deno.test("parseHexColor：6 位 / 3 位 / 大小写 / 缺 #（客户端的四种笔色都要对）", () => {
  assertRgb("#e5484d", [229, 72, 77]);
  assertRgb("#2f6fed", [47, 111, 237]);
  assertRgb("#111827", [17, 24, 39]);
  assertRgb("#f5a524", [245, 165, 36]);
  assertRgb("#FFFFFF", [255, 255, 255]);
  assertRgb("#fff", [255, 255, 255]);
  assertRgb("abc", [170, 187, 204]); // 3 位展开是每个字符重复：a→aa
  assertRgb("  #ABC  ", [170, 187, 204]); // 前后空白容忍
});

Deno.test("parseHexColor：认不出来的一律 null（不许「猜个颜色」）", () => {
  for (const bad of [null, undefined, 123, "", "#", "#12", "#1234", "#12345", "#1234567", "#gggggg", "red", "rgb(1,2,3)"]) {
    assertEquals(parseHexColor(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- 笔迹校验

const base = { color: "#111827", width: 0.004, points: [[0, 0], [1, 1]] };

Deno.test("normalizeStroke：正常一笔 —— alpha 缺省补 1（与客户端 ?? 1 一致）", () => {
  const s = normalizeStroke(base)!;
  assertEquals(s.alpha, 1);
  assertEquals(s.points.length, 2);
  assertEquals(round(s.color.r), round(17 / 255));
});

Deno.test("normalizeStroke：荧光笔的 alpha 0.5 与画笔的不写字段", () => {
  assertEquals(normalizeStroke({ ...base, alpha: 0.5 })!.alpha, 0.5);
  assertEquals(normalizeStroke({ ...base, alpha: undefined })!.alpha, 1);
  assertEquals(normalizeStroke({ ...base, alpha: null })!.alpha, 1);
});

Deno.test("normalizeStroke：说不清的一律 null（半条笔迹比没有更糟）", () => {
  const bad: Array<[string, unknown]> = [
    ["不是对象", "abc"],
    ["null", null],
    ["数字", 42],
    ["数组", []],
    ["颜色认不出", { ...base, color: "red" }],
    ["没有颜色", { width: 0.004, points: [[0, 0], [1, 1]] }],
    ["宽度 0", { ...base, width: 0 }],
    ["宽度为负", { ...base, width: -0.004 }],
    ["宽度是字符串", { ...base, width: "0.004" }],
    ["宽度是 NaN", { ...base, width: NaN }],
    ["宽度像像素值", { ...base, width: 12 }],
    ["alpha 越界", { ...base, alpha: 1.2 }],
    ["alpha 是字符串", { ...base, alpha: "0.5" }],
    ["points 不是数组", { ...base, points: "0,0 1,1" }],
    ["points 为空", { ...base, points: [] }],
    ["没有 points", { color: "#000", width: 0.004 }],
    ["点不是数组", { ...base, points: [0, 0] }],
    ["点只有 1 个分量", { ...base, points: [[0], [1]] }],
    ["坐标是字符串", { ...base, points: [["0", 0], [1, 1]] }],
    ["坐标是 NaN", { ...base, points: [[0, 0], [NaN, 1]] }],
    ["坐标是 Infinity", { ...base, points: [[0, 0], [Infinity, 1]] }],
  ];
  for (const [name, raw] of bad) {
    assertEquals(normalizeStroke(raw), null, name);
  }
});

Deno.test("normalizeStroke：边界值 —— 宽度上界是闭区间、单点笔迹不算畸形", () => {
  assertEquals(normalizeStroke({ ...base, width: MAX_WIDTH_RATIO }) !== null, true);
  assertEquals(normalizeStroke({ ...base, width: MAX_WIDTH_RATIO * 1.000001 }), null);
  // 单点：合法（用户点一下），能不能画是另一回事 —— 交给 normalizeAnnotations 计数
  assertEquals(normalizeStroke({ ...base, points: [[0.5, 0.5]] })!.points.length, 1);
  // 多出来的分量忽略，别整笔丢掉
  assertEquals(normalizeStroke({ ...base, points: [[0, 0, 7], [1, 1, 8]] })!.points.length, 2);
});

Deno.test("normalizeStroke：越界坐标 clamp 到 [0,1]（多一个点越界不该让整笔消失）", () => {
  const s = normalizeStroke({ ...base, points: [[-0.5, 1.5], [2, -1]] })!;
  assertEquals(s.points, [[0, 1], [1, 0]]);
  // 刚好在边界上的不动
  assertEquals(normalizeStroke({ ...base, points: [[0, 0], [1, 1]] })!.points, [[0, 0], [1, 1]]);
});

// ---------------------------------------------------------------- 页映射

const row = (page: unknown, strokes: unknown) => ({ page, strokes });
const drawable = { color: "#111827", width: 0.004, points: [[0, 0], [1, 1]] };
const dot = { color: "#111827", width: 0.004, points: [[0.5, 0.5]] };

const counts = (a: NormalizedAnnotations) => ({
  pages: a.pages.map((p) => [p.page, p.strokes.length]),
  drawn: a.drawn,
  dots: a.dots,
  skipped: a.skipped,
  outOfRange: a.outOfRange,
});

Deno.test("normalizeAnnotations：按页分组、页号升序、四种计数各归各的", () => {
  const rows = [
    row(2, [drawable]),
    row(1, [drawable, drawable, dot, { color: "red", width: 0.004, points: [[0, 0], [1, 1]] }]),
  ];
  assertEquals(counts(normalizeAnnotations(rows, 2)), {
    pages: [[1, 2], [2, 1]], // 输入里 2 在前，输出必须升序（画的时候按页走）
    drawn: 3,
    dots: 1,
    skipped: 1,
    outOfRange: 0,
  });
});

Deno.test("normalizeAnnotations：页号超出 PDF 页数 → outOfRange（PDF 被换短了的情形）", () => {
  const rows = [row(1, [drawable]), row(3, [drawable, drawable]), row(9, [drawable])];
  const got = counts(normalizeAnnotations(rows, 2));
  assertEquals(got.outOfRange, 3);
  assertEquals(got.drawn, 1);
  assertEquals(got.pages, [[1, 1]]);
});

Deno.test("normalizeAnnotations：页号读不出来的行也要计数（不能隐形）", () => {
  for (const badPage of [0, -1, 1.5, "1", null, undefined, NaN]) {
    const got = counts(normalizeAnnotations([row(badPage, [drawable, drawable])], 5));
    assertEquals(got.skipped, 2, `page=${String(badPage)} 的笔数应全部计入 skipped`);
    assertEquals(got.drawn, 0);
  }
});

Deno.test("normalizeAnnotations：strokes 不是数组的行计数为 1（列上挡不住坏 jsonb）", () => {
  for (const badStrokes of [null, undefined, "[]", 42, { a: 1 }]) {
    const got = counts(normalizeAnnotations([row(1, badStrokes)], 5));
    assertEquals(got.skipped, 1, `strokes=${JSON.stringify(badStrokes)}`);
  }
  // 合法的空数组不算坏数据（用户把这一页擦光了就会写 []）
  assertEquals(counts(normalizeAnnotations([row(1, [])], 5)).skipped, 0);
});

Deno.test("normalizeAnnotations：整个入参不是数组时全零（PostgREST 出错也会走到这）", () => {
  for (const bad of [null, undefined, {}, "rows", 42]) {
    assertEquals(
      counts(normalizeAnnotations(bad, 5)),
      { pages: [], drawn: 0, dots: 0, skipped: 0, outOfRange: 0 },
      JSON.stringify(bad),
    );
  }
});

Deno.test("normalizeAnnotations：单点笔迹只算 dots、不进 pages（两边都不画）", () => {
  const got = counts(normalizeAnnotations([row(1, [dot, dot, drawable])], 1));
  assertEquals(got, { pages: [[1, 1]], drawn: 1, dots: 2, skipped: 0, outOfRange: 0 });
});

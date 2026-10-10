import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFPage,
  PDFName,
  rgb,
} from "npm:pdf-lib@1.17.1";
import { composeAnnotatedPdf, MAX_TOTAL_STROKES, pageGeom, TooManyStrokesError } from "./compose.ts";

/**
 * 跑法：`deno test --allow-env supabase/functions/compose-annotated-pdf/`
 *
 * ## 这个文件守的是什么
 *
 * `paint.ts` 的用例只验「算出来的坐标对不对」，**不验它有没有被写进 PDF**。中间那一段
 * （pdf-lib 的操作符、图形状态、内容流拼接）此前是完全没覆盖的：坐标算错了看不出来，
 * 写错了同样看不出来 —— 产物都是一份能打开的 PDF。
 *
 * 所以这里不看「跑起来没报错」，而是把**产物重新读回来**、把追加的内容流解压开，
 * 逐条断言操作符与数字（`150 300 m`、`1.2 w`、`1 0 0 RG`、`gs`）。坐标的期望值都是从
 * `paint.ts` 的公式手推的，不是从实现里抄的。
 *
 * fixture 里刻意放了三种页：普通页、原件就带内容的页（断言原内容没被吞）、`/Rotate 90`
 * 的页（断言旋转真的被算进去了）。
 */

const dec = new TextDecoder();

/** 内容流可能是 FlateDecode 压过的（pdf-lib 保存时就是），解压失败说明它没压 */
async function decodeStreamBytes(bytes: Uint8Array): Promise<string> {
  try {
    const ds = new DecompressionStream("deflate");
    // 复制一份再交给 Blob：`contents` 可能是别人 buffer 上的一个视图，直接传会带上多余字节
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return await new Response(new Blob([copy.buffer]).stream().pipeThrough(ds)).text();
  } catch {
    return dec.decode(bytes);
  }
}

/** 把一页的内容流（原件 + 我们追加的）全部解出来拼成一份文本 */
async function pageContentText(doc: PDFDocument, pageNo: number): Promise<string> {
  const contents = doc.getPage(pageNo - 1).node.Contents();
  if (!contents) return "";
  const objs = contents instanceof PDFArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref))
    : [contents];
  const parts: string[] = [];
  for (const obj of objs) {
    const bytes = (obj as { contents?: unknown } | null)?.contents;
    if (bytes instanceof Uint8Array) parts.push(await decodeStreamBytes(bytes));
  }
  return parts.join("\n");
}

/** 取一页 `/Resources` 里所有 ExtGState 的 ca/CA（解不出来就返回空数组） */
function extGStates(doc: PDFDocument, page: PDFPage): Array<{ name: string; ca?: number; CA?: number }> {
  const resources = page.node.Resources();
  if (!resources) return [];
  const dict = resources.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  if (!dict) return [];
  const out: Array<{ name: string; ca?: number; CA?: number }> = [];
  for (const [key, value] of dict.entries()) {
    const gs = doc.context.lookupMaybe(value, PDFDict);
    if (!gs) continue;
    out.push({
      name: key.asString(),
      ca: Number(gs.get(PDFName.of("ca"))?.toString()),
      CA: Number(gs.get(PDFName.of("CA"))?.toString()),
    });
  }
  return out;
}

/** 3 页：普通页 / 原件带内容 / `/Rotate 90` */
async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const p2 = doc.addPage([200, 500]);
  // 原件里先画一条绿线：产物里必须还能找到它（证明我们只追加、没覆盖）
  p2.drawLine({ start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, thickness: 1, color: rgb(0, 1, 0) });
  const p3 = doc.addPage([200, 500]);
  p3.setRotation(degrees(90));
  return await doc.save();
}

const stroke = (
  points: Array<[number, number]>,
  extra: { color?: string; width?: number; alpha?: number } = {},
) => ({
  color: extra.color ?? "#000000",
  width: extra.width ?? 0.004,
  ...(extra.alpha === undefined ? {} : { alpha: extra.alpha }),
  points,
});

Deno.test("合成：笔迹真的写进了 PDF（操作符 + 坐标 + 线宽 + 颜色逐条验）", async () => {
  const src = await makeSourcePdf();
  const rows = [
    {
      page: 1,
      strokes: [
        stroke([[0.5, 0.25], [0.5, 0.5]], { color: "#ff0000" }),
        stroke([[0, 0], [1, 1]], { color: "#000000", alpha: 0.5 }),
      ],
    },
    { page: 2, strokes: [stroke([[0, 0], [1, 1]], { width: 0.008 })] },
  ];

  const out = await composeAnnotatedPdf(src, rows);
  assertEquals(out.pageCount, 3);
  assertEquals(out.annotatedPages, 2);
  assertEquals(out.drawn, 3);
  assertEquals(out.dots, 0);
  assertEquals(out.skipped, 0);
  assertEquals(out.outOfRange, 0);

  const doc = await PDFDocument.load(out.bytes);
  // 页面尺寸不能被改动（叠加不该动原件）
  assertEquals(doc.getPage(0).getSize(), { width: 300, height: 400 });
  assertEquals(doc.getPage(1).getSize(), { width: 200, height: 500 });

  const p1 = await pageContentText(doc, 1);
  // (0.5,0.25) → x=150, y=400×(1−0.25)=300；(0.5,0.5) → y=200
  assert(p1.includes("150 300 m"), `页 1 应有起点 150 300：\n${p1}`);
  assert(p1.includes("150 200 l"), `页 1 应有折点 150 200：\n${p1}`);
  assert(p1.includes("1 0 0 RG"), `页 1 应有红色描边：\n${p1}`);
  assert(p1.includes("0 0 0 RG"), `页 1 应有黑色描边：\n${p1}`);
  assert(p1.includes("1.2 w"), `页 1 线宽应为 0.004×300=1.2：\n${p1}`);
  assert(!p1.includes("1.6 w"), `页 1 不该出现页 2 的线宽（0.008×200=1.6）：\n${p1}`);
  // 名字是 pdf-lib 的 `uniqueKey('GS')` 生成的：`/GS` + 随机后缀（可能是负数）
  assert(/\/GS-\d+ gs/.test(p1), `半透明那一笔应设过图形状态：\n${p1}`);
  // 圆头/圆角：客户端 lineCap/lineJoin 都是 round
  assert(p1.includes("1 J") && p1.includes("1 j"), `应为圆头圆角：\n${p1}`);

  const p2 = await pageContentText(doc, 2);
  assert(p2.includes("0 0 0 RG") && p2.includes("0 500 m") && p2.includes("200 0 l"), p2);
  assert(p2.includes("1.6 w"), `页 2 线宽应为 0.008×200=1.6：\n${p2}`);
  // 原件那条绿线必须还在（我们只追加）
  assert(p2.includes("0 1 0 RG"), `原件内容不能丢：\n${p2}`);
  assert(!p2.includes("1 0 0 RG"), `页 2 不该有页 1 的红色：\n${p2}`);

  // 不透明的那几笔不建 ExtGState（只有荧光笔需要）
  assertEquals(extGStates(doc, doc.getPage(1)).length, 0, "页 2 不该有 ExtGState");
  const gs1 = extGStates(doc, doc.getPage(0));
  assertEquals(gs1.length, 1, `页 1 应恰好一个 ExtGState：${JSON.stringify(gs1)}`);
  assertEquals(gs1[0].ca, 0.5);
  assertEquals(gs1[0].CA, 0.5);
});

Deno.test("合成：/Rotate 90 的页按 90° 换算（页图的 x 轴对应 PDF 的 y 轴）", async () => {
  const src = await makeSourcePdf();
  const out = await composeAnnotatedPdf(src, [
    { page: 3, strokes: [stroke([[0.25, 0.5], [0.5, 0.25]])] },
  ]);

  const doc = await PDFDocument.load(out.bytes);
  assertEquals(pageGeom(doc.getPage(2)), {
    x: 0,
    y: 0,
    width: 200,
    height: 500,
    rotation: 90,
  });

  const p3 = await pageContentText(doc, 3);
  // (nx=0.25, ny=0.5) → x=0.5×200=100, y=0.25×500=125
  assert(p3.includes("100 125 m"), `90° 页的起点应是 100 125：\n${p3}`);
  // (nx=0.5, ny=0.25) → x=0.25×200=50, y=0.5×500=250
  assert(p3.includes("50 250 l"), `90° 页的折点应是 50 250：\n${p3}`);
  // 线宽的分母是页图宽 = CropBox 的高：0.004×500=2
  assert(p3.includes("2 w"), `90° 页线宽应为 0.004×500=2：\n${p3}`);
  // 反证：0° 的公式会给出 100 125 之外的数（(0.25,0.5) → 50 250），别让实现退化回「只翻 y」
  assert(!p3.includes("50 250 m"), `90° 不该用 0° 的公式：\n${p3}`);
});

Deno.test("合成：单点笔迹对产物没有任何影响（客户端也只 moveTo）", async () => {
  const src = await makeSourcePdf();
  const blank = await composeAnnotatedPdf(src, []);
  const out = await composeAnnotatedPdf(src, [{ page: 2, strokes: [stroke([[0.5, 0.5]])] }]);

  assertEquals(out.dots, 1);
  assertEquals(out.drawn, 0);
  assertEquals(out.annotatedPages, 0);

  // 「没影响」要逐页比对内容流：只看某一页的话，「在第一页多画了个点」这种错会漏掉
  const texts = async (bytes: Uint8Array) => {
    const doc = await PDFDocument.load(bytes);
    return await Promise.all([1, 2, 3].map((n) => pageContentText(doc, n)));
  };
  assertEquals(await texts(out.bytes), await texts(blank.bytes));
  assertEquals(
    (await PDFDocument.load(out.bytes)).getPage(0).node.Contents(),
    undefined,
    "空白页不该被碰（连空内容流都不该新建）",
  );
});

Deno.test("合成：页号超出 PDF 页数 → 计 outOfRange、不画", async () => {
  const src = await makeSourcePdf();
  const out = await composeAnnotatedPdf(src, [
    { page: 9, strokes: [stroke([[0, 0], [1, 1]])] },
  ]);

  assertEquals(out.outOfRange, 1);
  assertEquals(out.drawn, 0);
  assertEquals(out.annotatedPages, 0);

  const doc = await PDFDocument.load(out.bytes);
  assertEquals(doc.getPage(0).node.Contents(), undefined, "不该因为一行越界数据就多出内容流");
});

Deno.test("合成：笔数超上限时**先报错**（不硬着头皮画到超时）", async () => {
  const src = await makeSourcePdf();
  const strokes = Array.from({ length: MAX_TOTAL_STROKES + 1 }, () => stroke([[0, 0], [1, 1]]));
  await assertRejects(
    () => composeAnnotatedPdf(src, [{ page: 1, strokes }]),
    TooManyStrokesError,
  );
});

Deno.test("合成：不改动入参、重复合并不叠墨（原件始终是原件）", async () => {
  const src = await makeSourcePdf();
  const rows = [{ page: 1, strokes: [stroke([[0.5, 0.25], [0.5, 0.5]])] }];

  const first = await composeAnnotatedPdf(src, rows);
  const second = await composeAnnotatedPdf(src, rows);

  const count = async (bytes: Uint8Array) =>
    (await pageContentText(await PDFDocument.load(bytes), 1)).split("150 300 m").length - 1;
  assertEquals(await count(first.bytes), 1);
  assertEquals(await count(second.bytes), 1, "用同一份原件再合一次不该叠成两笔");
});

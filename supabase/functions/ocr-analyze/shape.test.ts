import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { shapeOcrResponse } from "./shape.ts";

/**
 * 跑法：`deno test supabase/functions/ocr-analyze/`（本文件不需要任何权限）
 *
 * 每个用例对应一条**上游真实会给出的坏形状**或一个**已经踩过的坑**，
 * 不是凑覆盖率 —— 注释里写清它防的是什么。
 */

/** 一份结构正确的响应（单页 + 完整的 overlay），各用例在它上面做局部破坏 */
function goodResponse() {
  return {
    ParsedResults: [
      {
        ParsedText: "Corno I in F\nAllegro",
        TextOverlay: {
          HasOverlay: true,
          Lines: [
            {
              LineText: "Corno I in F",
              Words: [
                { WordText: "Corno", Left: 40, Top: 12, Width: 90, Height: 20 },
                { WordText: "I", Left: 140, Top: 14, Width: 10, Height: 18 },
                { WordText: "in", Left: 160, Top: 14, Width: 22, Height: 18 },
                { WordText: "F", Left: 190, Top: 14, Width: 14, Height: 18 },
              ],
            },
            {
              LineText: "Allegro",
              Words: [{ WordText: "Allegro", Left: 60, Top: 300, Width: 120, Height: 22 }],
            },
          ],
        },
      },
    ],
  };
}

/**
 * 调用方真正的用法：把每页顶部条带纵向拼成一张图，再按行的 `top` 归属到页。
 * 用例里用它把「坐标坏掉」翻译成**实际后果**（文字分错页），而不是只比中间值。
 */
const pageOf = (top: number, stripHeight: number) => Math.floor(top / stripHeight) + 1;

Deno.test("不请求 overlay：lines 为空，但 pages 照样返回 —— 不再有 pageCount 与 pages 互相矛盾的窗口", () => {
  const out = shapeOcrResponse(goodResponse(), false);
  assertEquals(out.text, "Corno I in F\nAllegro");
  assertEquals(out.pageCount, 1);
  // 曾经 pages 只在 overlay 时返回，于是不传 overlay 的调用方按注释去读逐页文本
  // 只会拿到 []，却拿到一个对不上的 pageCount —— 又一处 200+success+空数据的静默降级
  assertEquals(out.pages.length, 1);
  assertEquals(out.pages[0].lines, []);
  assertEquals(out.pages[0].text, "Corno I in F\nAllegro");
});

Deno.test("请求 overlay 时，行坐标取该行所有**有效**词的外接框", () => {
  const out = shapeOcrResponse(goodResponse(), true);
  const [line1, line2] = out.pages[0].lines;
  assertEquals(line1.text, "Corno I in F");
  assertEquals(line1.left, 40);
  assertEquals(line1.top, 12);
  assertEquals(line1.width, 164); // (190+14) - 40
  assertEquals(line1.height, 20); // (14+18) - 12
  assertEquals(line1.words.length, 4);
  assertEquals(line2.top, 300);
});

Deno.test("坐标缺失/非法的词**不参与外接框** —— 行框必须仍指向真实位置", () => {
  // ⚠️ 这是最重的一条回归。上一版把坏坐标折成 0，坏词变成原点上的幽灵词，
  // 把**整行**的外接框拉到 (0,0) —— 那一行的文字于是被归到第 1 页，而真正的页拿到空。
  // 上一版的用例还把 0/0 断言成了期望值（真实值应是 40/20），等于把 bug 锁死。
  const withJunk = goodResponse();
  withJunk.ParsedResults[0].TextOverlay.Lines[1].Words.push(
    // deno-lint-ignore no-explicit-any
    { WordText: "cresc." } as any, // 少给全部坐标
  );
  const out = shapeOcrResponse(withJunk, true);
  const line = out.pages[0].lines[1];
  assertEquals(line.top, 300, "坏词不能把行框拉到原点");
  assertEquals(line.left, 60);
  assertEquals(line.width, 120, "外接框只由有效词决定");
  // 该词本身被丢掉：words[] 的用途是几何，没有几何的词留在里面只会毒化外接框。
  // 它的文字没丢 —— 整页的 ParsedText 还在。
  assertEquals(line.words.map((w) => w.text), ["Allegro"]);
});

Deno.test("★ 加一个坏词不能改变某一行归属的页（把中间值翻译成实际后果）", () => {
  const STRIP = 200; // 每页条带 200px 高
  // 三页各一行，top 分别落在各自条带内
  const res = {
    ParsedResults: [
      {
        ParsedText: "",
        TextOverlay: {
          HasOverlay: true,
          Lines: [50, 250, 450].map((top) => ({
            LineText: `P${top / 200 + 1}`,
            Words: [{ WordText: `P${top / 200 + 1}`, Left: 10, Top: top, Width: 60, Height: 20 }],
          })),
        },
      },
    ],
  };
  const before = shapeOcrResponse(res, true).pages[0].lines.map((l) => pageOf(l.top, STRIP));
  assertEquals(before, [1, 2, 3]);

  // 往第 3 页那行塞一个没有坐标的词
  // deno-lint-ignore no-explicit-any
  res.ParsedResults[0].TextOverlay.Lines[2].Words.push({ WordText: "cresc." } as any);
  const after = shapeOcrResponse(res, true).pages[0].lines.map((l) => pageOf(l.top, STRIP));
  assertEquals(after, [1, 2, 3], "坏词把第 3 页的行拖到第 1 页，是静默的错答案");
});

Deno.test("TextOverlay 缺失 / 不是对象 → lines 为空数组，**不抛**", () => {
  const noOverlay = goodResponse();
  // deno-lint-ignore no-explicit-any
  delete (noOverlay.ParsedResults[0] as any).TextOverlay;
  const out = shapeOcrResponse(noOverlay, true);
  assertEquals(out.pages[0].lines, []);
  assertEquals(out.pages[0].overlayProvided, false);
  assertEquals(out.text, "Corno I in F\nAllegro", "文本不该受 overlay 缺失影响");
});

Deno.test("没有**有效**词的行被跳过 —— `Words: [null]` 这种换个形式的空壳也要挡住", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        {
          ParsedText: "x",
          TextOverlay: {
            HasOverlay: true,
            Lines: [
              { LineText: "没有 Words" },
              { LineText: "空数组", Words: [] },
              { LineText: "全是坏词", Words: [null, "不是对象", 42] },
              { LineText: "真行", Words: [{ WordText: "真行", Left: 5, Top: 5, Width: 10, Height: 10 }] },
            ],
          },
        },
      ],
    },
    true,
  );
  assertEquals(out.pages[0].lines.length, 1, "上一版按原始条目数计数，[null] 会漏成一个 (0,0) 幽灵行");
  assertEquals(out.pages[0].lines[0].text, "真行");
});

Deno.test("LineText 是纯空白 → 用词拼出来，别把词的文本吞掉", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        {
          ParsedText: "z",
          TextOverlay: {
            HasOverlay: true,
            Lines: [
              {
                LineText: "   ", // 纯空白是**真值**，不 trim 就会吞掉下面两个词
                Words: [
                  { WordText: "Corno", Left: 1, Top: 2, Width: 3, Height: 4 },
                  { WordText: "II", Left: 9, Top: 2, Width: 3, Height: 4 },
                ],
              },
            ],
          },
        },
      ],
    },
    true,
  );
  assertEquals(out.pages[0].lines[0].text, "Corno II");
});

Deno.test("负宽高被加下界 —— 负值做区间包含判断会永远匹配不上且不报错", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        {
          ParsedText: "n",
          TextOverlay: {
            HasOverlay: true,
            Lines: [
              { Words: [{ WordText: "n", Left: 100, Top: 100, Width: -50, Height: -20 }] },
            ],
          },
        },
      ],
    },
    true,
  );
  const line = out.pages[0].lines[0];
  assertEquals(line.width, 0);
  assertEquals(line.height, 0);
});

Deno.test("overlayProvided 读的是**上游**的 HasOverlay，不是我们的请求参数", () => {
  // 三种上游形态：明说给了 / 明说没给 / 整个字段缺失
  const mk = (has?: boolean) => ({
    ParsedResults: [
      {
        ParsedText: "",
        TextOverlay: { ...(has === undefined ? {} : { HasOverlay: has }), Lines: [] },
      },
    ],
  });
  assertEquals(shapeOcrResponse(mk(true), true).pages[0].overlayProvided, true);
  assertEquals(shapeOcrResponse(mk(false), true).pages[0].overlayProvided, false);
  assertEquals(shapeOcrResponse(mk(undefined), true).pages[0].overlayProvided, false);
  // 即使我们没要 overlay，上游说给了也如实反映 —— 这个字段描述的是**响应**，不是请求
  assertEquals(shapeOcrResponse(mk(true), false).pages[0].overlayProvided, true);
});

Deno.test("多页响应不丢页 —— 上一版只取 [0]，第 2 页起被静默丢掉", () => {
  const out = shapeOcrResponse(
    { ParsedResults: [{ ParsedText: "第一页" }, { ParsedText: "第二页" }, { ParsedText: "第三页" }] },
    false,
  );
  assertEquals(out.pageCount, 3, "页数必须如实反映");
  assertEquals(out.text, "第一页", "text 保持第一页（向后兼容）");
  assertEquals(out.pages.map((p) => p.text), ["第一页", "第二页", "第三页"]);
  assertEquals(out.pages.map((p) => p.page), [1, 2, 3]);
});

Deno.test("ParsedResults 缺失/不是数组 → 空结果，不抛", () => {
  for (const bad of [{}, { ParsedResults: null }, { ParsedResults: "oops" }, null, undefined]) {
    const out = shapeOcrResponse(bad, true);
    assertEquals(out.text, "");
    assertEquals(out.pageCount, 0);
    assertEquals(out.pages, []);
  }
});

Deno.test("极多词不炸栈 —— 外接框不能用 Math.min(...spread)", () => {
  // 展开成实参有上限（实测 12.5 万词可以、20 万词抛 RangeError），
  // 而本模块的契约是「不抛异常」：抛出去会让整次请求变成 400。
  const words = Array.from({ length: 200_000 }, (_, i) => ({
    WordText: "w",
    Left: i,
    Top: i,
    Width: 1,
    Height: 1,
  }));
  const out = shapeOcrResponse(
    { ParsedResults: [{ ParsedText: "", TextOverlay: { HasOverlay: true, Lines: [{ Words: words }] } }] },
    true,
  );
  assertEquals(out.pages[0].lines[0].left, 0);
  assertEquals(out.pages[0].lines[0].width, 200_000);
});

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { shapeOcrResponse } from "./shape.ts";

/**
 * 跑法：`deno test supabase/functions/ocr-analyze/`（本文件不需要任何权限）
 *
 * 每个用例对应一条**上游真实会给出的坏形状**，不是凑覆盖率 —— 注释里写清它防的是什么。
 */

/** 一份结构正确的响应（单页 + overlay），各用例在它上面做局部破坏 */
function goodResponse() {
  return {
    ParsedResults: [
      {
        ParsedText: "Corno I in F\nAllegro",
        TextOverlay: {
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
              Words: [{
                WordText: "Allegro",
                Left: 60,
                Top: 300,
                Width: 120,
                Height: 22,
              }],
            },
          ],
          HasOverlay: true,
        },
      },
    ],
  };
}

Deno.test("不请求 overlay 时 pages 为空，text 仍是第一页 —— 老调用方一字不变", () => {
  const out = shapeOcrResponse(goodResponse(), false);
  assertEquals(out.text, "Corno I in F\nAllegro");
  assertEquals(out.pageCount, 1);
  assertEquals(out.pages, []);
});

Deno.test("请求 overlay 时，行坐标取该行所有词的**外接框**", () => {
  const out = shapeOcrResponse(goodResponse(), true);
  assertEquals(out.pages.length, 1);
  const [line1, line2] = out.pages[0].lines;
  // 左边界取最左的词；上边界取最上的词（I/in/F 的 Top=14 比 Corno 的 12 更靠下）
  assertEquals(line1.text, "Corno I in F");
  assertEquals(line1.left, 40);
  assertEquals(line1.top, 12);
  // 宽度 = 最右词的右边界(190+14) - 最左(40)
  assertEquals(line1.width, 164);
  // 高度 = 最下词的底边(14+18) - 最上(12)
  assertEquals(line1.height, 20);
  assertEquals(line1.words.length, 4);
  assertEquals(line2.top, 300);
  assertEquals(out.pages[0].page, 1);
});

Deno.test("TextOverlay 缺失 / 不是对象 → lines 为空数组，**不抛**", () => {
  // 防的是：上游哪天不发 overlay 了，整个上传流程跟着炸
  const noOverlay = goodResponse();
  // deno-lint-ignore no-explicit-any
  delete (noOverlay.ParsedResults[0] as any).TextOverlay;
  const out = shapeOcrResponse(noOverlay, true);
  assertEquals(out.pages[0].lines, []);
  assertEquals(
    out.text,
    "Corno I in F\nAllegro",
    "文本不该受 overlay 缺失影响",
  );
});

Deno.test("Words 为空或缺失的行被跳过 —— 空壳行不能变成无意义的框", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        {
          ParsedText: "x",
          TextOverlay: {
            Lines: [
              { LineText: "空壳" }, // 没有 Words
              { LineText: "空数组", Words: [] },
              {
                LineText: "真行",
                Words: [{
                  WordText: "真行",
                  Left: 5,
                  Top: 5,
                  Width: 10,
                  Height: 10,
                }],
              },
            ],
          },
        },
      ],
    },
    true,
  );
  assertEquals(out.pages[0].lines.length, 1);
  assertEquals(out.pages[0].lines[0].text, "真行");
});

Deno.test("坐标不是数字时不产生 NaN —— NaN 会让外接框整行烂掉", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        {
          ParsedText: "y",
          TextOverlay: {
            Lines: [
              {
                Words: [
                  {
                    WordText: "a",
                    Left: "40" as unknown as number,
                    Top: null,
                    Width: 10,
                    Height: 10,
                  },
                  { WordText: "b", Left: 60, Top: 20, Width: 10, Height: 10 },
                ],
              },
            ],
          },
        },
      ],
    },
    true,
  );
  const line = out.pages[0].lines[0];
  // Math.min(NaN, 60) 是 NaN —— 只有把坏坐标折成 0 才能保住整行
  assertEquals(line.left, 0);
  assertEquals(line.top, 0);
  assertEquals(Number.isNaN(line.width), false);
});

Deno.test("LineText 缺失时用词拼出来 —— 有 words 却整行没字是自相矛盾的输入", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        {
          ParsedText: "z",
          TextOverlay: {
            Lines: [
              {
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

Deno.test("多页响应不丢页 —— 上一版只取 [0]，第 2 页起被静默丢掉", () => {
  const out = shapeOcrResponse(
    {
      ParsedResults: [
        { ParsedText: "第一页" },
        { ParsedText: "第二页" },
        { ParsedText: "第三页" },
      ],
    },
    false,
  );
  assertEquals(out.pageCount, 3, "页数必须如实反映");
  assertEquals(out.text, "第一页", "text 保持第一页（向后兼容）");
});

Deno.test("ParsedResults 缺失/不是数组 → 空结果，不抛", () => {
  for (
    const bad of [
      {},
      { ParsedResults: null },
      { ParsedResults: "oops" },
      null,
      undefined,
    ]
  ) {
    const out = shapeOcrResponse(bad, true);
    assertEquals(out.text, "");
    assertEquals(out.pageCount, 0);
    assertEquals(out.pages, []);
  }
});

Deno.test("请求 overlay 时 pages 与 text 的一致性：page 从 1 起递增，text 即第一页", () => {
  const out = shapeOcrResponse(
    { ParsedResults: [{ ParsedText: "a" }, { ParsedText: "b" }] },
    true,
  );
  assertEquals(out.pages.map((p) => p.page), [1, 2]);
  assertEquals(out.pages.map((p) => p.text), ["a", "b"]);
  assertEquals(out.text, "a");
});

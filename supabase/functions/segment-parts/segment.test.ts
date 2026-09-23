import {
  evidenceSupports,
  MAX_CUTS,
  normalizeForMatch,
  parseSegmentPlan,
  planToRanges,
  type PageText,
} from "./segment.ts";
// ⚠️ 只为**一致性**用例而 import：`segment.ts` 里那份归一化/证据函数是副本
// （理由见那边的注释：函数逐个部署，跨目录 import 没有先例）。这条用例就是
// 「两份实现不许漂」的那道锁 —— 它跑在仓库里，不受打包限制。
import {
  evidenceSupports as refEvidenceSupports,
  normalizeForMatch as refNormalize,
} from "../llm-analyze/analyze.ts";

const eq = (actual: unknown, expected: unknown, msg: string) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e || typeof actual !== typeof expected) {
    throw new Error(`${msg}\n  实际: ${a} (${typeof actual})\n  期望: ${e} (${typeof expected})`);
  }
};

/** 一页一页的窄带文本。第 1 页有乐器名，续页只有页码 —— 正是真实形态。 */
const pages: PageText[] = [
  { page: 1, text: "Corno I in F" },
  { page: 2, text: "2" },
  { page: 3, text: "3" },
  { page: 4, text: "Corno II in F" },
  { page: 5, text: "5" },
  { page: 6, text: "Corno III in F" },
];

Deno.test("一致性：本模块的归一化与证据函数与 llm-analyze 那份逐字一致", () => {
  // 语料要让两条实现**都可能分歧**的地方都过一遍：
  // 全角/带圈/上下标（NFKC 折）、韩文填充符与组合记号（类别是字母但渲染为空白）、
  // 大小写、标点、星光平面字符（码点 vs 码元）。
  const corpus = [
    "", " ", "  ", "\t", "\n", "a", "ab", "ABC", "a b c", "a.b,c",
    "Ｈｏｒｎ", "Ｈorn　２", "①", "²", "𝟏", "Ⅻ", "á", "á",
    String.fromCharCode(0x200b, 0x200b),
    String.fromCharCode(0x00ad),
    String.fromCharCode(0xfeff),
    String.fromCharCode(0x3164, 0x3164),
    String.fromCharCode(0x115f, 0x115f),
    String.fromCharCode(0xffa0, 0xffa0),
    String.fromCharCode(0x1160, 0x1160),
    "Corno I in F", "Corno  II  in F.", "CORNO I IN F",
    String.fromCodePoint(0x20000), "字", "汉字",
  ];
  for (const s of corpus) {
    eq(normalizeForMatch(s), refNormalize(s), `归一化不一致: ${JSON.stringify(s)}`);
  }
  // 证据门也要一致：两边一旦不同，就会出现「同一条引文在那边过、在这边不过」
  for (const needle of corpus) {
    for (const source of ["Corno I in F", "2", "Corno III in F", ""]) {
      eq(
        evidenceSupports(needle, source),
        refEvidenceSupports(needle, source),
        `证据判定不一致: needle=${JSON.stringify(needle)} source=${JSON.stringify(source)}`,
      );
    }
  }
});

Deno.test("正常路径：切点与证据一一对应，升序输出", () => {
  const r = parseSegmentPlan(
    { cuts: [4, 6], evidence: ["Corno II", "Corno III"] },
    pages,
  );
  eq(r.cuts, [4, 6], "切点");
  eq(r.evidence, ["Corno II", "Corno III"], "证据");
});

Deno.test("模型给的顺序乱了也要升序输出（下游按顺序切片）", () => {
  const r = parseSegmentPlan(
    { cuts: [6, 4], evidence: ["Corno III", "Corno II"] },
    pages,
  );
  eq(r.cuts, [4, 6], "切点要升序");
  // 关键：证据必须**跟着自己的切点走**，不能被一起排序后错位
  eq(r.evidence, ["Corno II", "Corno III"], "证据要跟着切点");
});

Deno.test("第 1 页不是切点：它是第 1 段的开头，不是边界", () => {
  const r = parseSegmentPlan({ cuts: [1, 4], evidence: ["Corno I", "Corno II"] }, pages);
  eq(r.cuts, [4], "第 1 页要被丢掉");
});

Deno.test("越界页号丢掉：0、负数、超过页数、非整数", () => {
  for (const bad of [0, -1, 7, 999, 4.5, Infinity, NaN]) {
    const r = parseSegmentPlan({ cuts: [bad], evidence: ["Corno I in F"] }, pages);
    eq(r.cuts, [], `页号 ${bad} 应被丢掉`);
  }
});

Deno.test("**没有证据（或证据不在那一页）的切点一律丢掉** —— 这是防幻觉的唯一机制", () => {
  // 模型凭空报一个边界，但拿不出那一页的原文
  eq(parseSegmentPlan({ cuts: [4], evidence: [] }, pages).cuts, [], "证据缺失");
  eq(parseSegmentPlan({ cuts: [4], evidence: ["编的"] }, pages).cuts, [], "证据凭空");
  eq(parseSegmentPlan({ cuts: [4], evidence: [""] }, pages).cuts, [], "空证据");
  eq(parseSegmentPlan({ cuts: [4], evidence: [123] }, pages).cuts, [], "证据不是字符串");
  // 关键区分：证据**存在但出自别页**。Corno II 在第 4 页上，若切点说第 2 页
  //（那页只有页码 "2"），就拿不出证据 → 丢掉。
  eq(
    parseSegmentPlan({ cuts: [2], evidence: ["Corno II in F"] }, pages).cuts,
    [],
    "证据出自别页",
  );
});

Deno.test("**局部失败只丢那一个切点**，不整份弃权", () => {
  // 第 4 页的切点有证据，第 6 页那条是编的 → 保住 4，丢掉 6
  const r = parseSegmentPlan(
    { cuts: [4, 6], evidence: ["Corno II in F", "编的"] },
    pages,
  );
  eq(r.cuts, [4], "好的那个要留下");
  eq(r.evidence, ["Corno II in F"], "证据同步");
});

Deno.test("重复页号只算一次", () => {
  const r = parseSegmentPlan(
    { cuts: [4, 4], evidence: ["Corno II in F", "Corno II in F"] },
    pages,
  );
  eq(r.cuts, [4], "去重");
});

Deno.test("弃权形态与各种垃圾输入都不抛，返回「不切」", () => {
  for (const bad of [
    null, undefined, 42, "字符串", [], {},
    { cuts: [] }, { cuts: [], evidence: [] },
    { cuts: "4", evidence: [] }, { cuts: [4], evidence: "Corno II" },
    { cuts: [null], evidence: [null] }, { cuts: [[4]], evidence: [["Corno II"]] },
  ]) {
    const r = parseSegmentPlan(bad, pages);
    eq(r.cuts, [], `「${JSON.stringify(bad)}」应不切`);
    eq(r.evidence, [], `「${JSON.stringify(bad)}」证据同步`);
  }
});

Deno.test("段数上界：超过就整个不要（荒唐输出宁可退回不切）", () => {
  const many: PageText[] = Array.from({ length: MAX_CUTS + 5 }, (_, i) => ({
    page: i + 1,
    text: `Part ${i + 1}`,
  }));
  const cuts = Array.from({ length: MAX_CUTS + 1 }, (_, i) => i + 2);
  const r = parseSegmentPlan(
    { cuts, evidence: cuts.map((c) => `Part ${c}`) },
    many,
  );
  eq(r.cuts, [], "超上界就整个不切");
  // 边界：正好 MAX_CUTS 个要放行
  const okCuts = cuts.slice(0, MAX_CUTS);
  eq(
    parseSegmentPlan({ cuts: okCuts, evidence: okCuts.map((c) => `Part ${c}`) }, many).cuts.length,
    MAX_CUTS,
    "正好到上界应放行",
  );
});

Deno.test("缺页不影响页号语义（切点在页号空间，不是数组下标）", () => {
  // 第 3 页的 OCR 失败了、前端没把它交上来 —— 这正是「按下标切」会整体错位的场景
  const withGap: PageText[] = [
    { page: 1, text: "Corno I in F" },
    { page: 2, text: "2" },
    // page 3 缺失
    { page: 4, text: "Corno II in F" },
  ];
  const r = parseSegmentPlan({ cuts: [4], evidence: ["Corno II in F"] }, withGap);
  eq(r.cuts, [4], "第 4 页仍然是第 4 页");
  eq(planToRanges(r, 4), [{ from: 1, to: 3 }, { from: 4, to: 4 }], "段区间");
});

Deno.test("planToRanges：不切时是整份；多段时闭区间首尾相接", () => {
  eq(planToRanges({ cuts: [], evidence: [] }, 19), [{ from: 1, to: 19 }], "不切");
  eq(
    planToRanges({ cuts: [6, 11, 16], evidence: [] }, 19),
    [{ from: 1, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 15 }, { from: 16, to: 19 }],
    "四段",
  );
  // 边界：最后一段必须收在 pageCount 上，不能是 undefined
  eq(planToRanges({ cuts: [2], evidence: [] }, 2), [{ from: 1, to: 1 }, { from: 2, to: 2 }], "两页两段");
});

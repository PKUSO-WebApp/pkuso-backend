/**
 * 分段计划的解析与校验（纯函数）。见 pkuso-web#290 Step 1。
 *
 * ## 这个函数在做什么
 *
 * 一份「合订谱」（如 `Horn_1,_2,_3,_4.pdf`，19 页，4 个圆号订在一起）里，
 * **哪几页是新的一份的开头**。前端逐页取顶部窄带做 OCR，把 N 段文本交过来，
 * 这里只回答**切点**：`cuts = [6, 11, 16]` 表示第 1-5 页一段、6-10 一段、……
 *
 * **不给名字**（哪段是什么乐器）：那是 `llm-analyze` 的职责。分开的理由是两类判断
 * 会互相带偏 ——「哪几页是一份」是结构判断，「这份是什么」是语义判断，
 * 塞进同一个 prompt 里两边都没法单独验。
 *
 * ## 两条硬默认
 *
 * 1. **宁可少切，不可多切。** 少切只是退化成今天的样子（整份当一个声部处理）；
 *    多切是**把两份谱的页混进同一段**，那一份会归错人。所以每一个可疑的切点
 *    都往「不切」的方向倒。
 * 2. **没有证据的切点不要。** 每个切点必须附一段**来自那一页**的原文，
 *    校验不过就丢那一个切点（不是整份弃权）—— 局部失败局部处理，
 *    且丢弃本身就等于「不切」，方向是安全的。
 */

/**
 * 段数上界。它不是模型正确性的保证，防的是荒唐输出（例如「每一页都是新的一段」）。
 * 真实合订谱最多几十份；给到 32 已经极宽松 —— 触顶说明模型在胡说，少切比乱切好。
 */
export const MAX_CUTS = 32;

/** 引文归一化后至少要剩这么多字符才算证据（与 `llm-analyze` 同值） */
const MIN_EVIDENCE_CHARS = 2;

/**
 * 会被当成「空白」的字母类字符。
 *
 * ⚠️ 韩文填充符（U+3164 / U+115F / U+FFA0）的 Unicode 类别是 **Lo（字母）**，
 * 能躲过 `[^\p{L}\p{N}]` 的过滤，但渲染出来是空白 —— 两个就能凑够长度门。
 * 组合记号（`\p{Mn}`）同理：`a` + U+0301 会被 NFKC **合成**成 `á`，
 * 于是「两个不可见字符」变成「一个真字母」。
 *
 * ⚠️ 一律用 `\u{...}` 转义，**不要在源码里写真的不可见字符**：它们会被 lint 判为
 * irregular whitespace，而且更容易在编辑/格式化中被悄悄吃掉 —— 那时这条正则
 * 静默退化成「只剥 Cf/Cc/Mn」，用例照样全绿而缺口无人发现（本仓有过先例）。
 * 与 `llm-analyze/analyze.ts` 的 `BLANK_LETTERS` 逐字一致（含 U+1160）。
 */
const BLANK_LETTERS = /[\p{Cf}\p{Cc}\p{Mn}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/**
 * 匹配用的归一化：NFKC → 小写 → 剥掉空白/标点/不可见字符。
 *
 * ⚠️ **这是 `llm-analyze/analyze.ts` 里同名函数的副本，不是 import。**
 * 理由：Supabase 的 edge function **逐个部署**（`supabase functions deploy <name>`），
 * 每个函数独立打包；跨目录相对 import（`../llm-analyze/analyze.ts`）在本仓**没有先例**，
 * 而上一次「函数内相对 import」本身就是要靠部署后冒烟才敢确认的形态。
 * 切分链路不该把自己的可部署性押在一个没验过的打包行为上。
 *
 * 代价是两份实现会漂 —— 靠 `segment.test.ts` 里那条**同时 import 两边**的
 * 一致性用例兜住（测试跑在仓库里，不受打包限制）。
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(BLANK_LETTERS, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * 引文 `evidence` 是否真的出自 `source`（归一化后子串匹配）。
 *
 * ⚠️ 空串是任意字符串的子串 —— 不挡住就等于给伪造证据开门。所以按**码点**数
 * （不是码元：星光平面字符占 2 个码元但只有 1 个字符）要求至少剩 2 个字符。
 */
export function evidenceSupports(evidence: string, source: string): boolean {
  const needle = normalizeForMatch(evidence);
  if ([...needle].length < MIN_EVIDENCE_CHARS) return false;
  return normalizeForMatch(source).includes(needle);
}

/** 页号 → 该页的窄带文本。页号 **1-based**，与 PDF 页序一致。 */
export interface PageText {
  page: number;
  text: string;
}

export interface SegmentPlan {
  /** 每段的起始页（1-based，升序，**恒不含第 1 页**）。空数组 = 不切。 */
  cuts: number[];
  /** 与 `cuts` 一一对应的原文片段 */
  evidence: string[];
}

/**
 * 一个切点被丢掉的**理由**。取值是**契约的一部分**（前端按它分类，见 pkuso-web 的
 * `requestSegmentation`）—— 只能加新值，不能改已有值的含义。
 *
 * 为什么要有它：「模型弃权」与「模型给了切点但被丢掉」在响应里曾经**长得一模一样**
 * （都是空 cuts），而这两种情况的修法完全相反（前者要改 prompt，后者要改校验/抄写规则）。
 * 实测那几份 0/9 的合订谱就卡在这里 —— 没人知道模型到底说了什么。
 */
export const REJECTION_REASONS = [
  /** 页号不是安全整数（不是数字 / NaN / Infinity / 小数） */
  "not-integer",
  /** 页号不在 1..pageCount 内 */
  "out-of-range",
  /** 第 1 页 —— 它是第 1 段的**定义**，不是边界 */
  "page-one",
  /** 同一个页号在前面已经出现过 */
  "duplicate",
  /** 这个位置没有字符串证据（缺失 / 类型不对） */
  "no-evidence",
  /** 那一页没有窄带文本（OCR 失败或前端没交上来）—— 无从校验，宁可丢 */
  "no-page-text",
  /** 引文没在**那一页**的原文里找到（幻觉证据，或抄错了页） */
  "evidence-unsupported",
  /** 通过校验的切点数超过 MAX_CUTS：整个计划退回「不切」 */
  "too-many-cuts",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** 被丢掉的一个切点。 */
export interface RejectedCut {
  /**
   * 模型给的那个页号，**原样带上**（`4.5` 这种也在：它正是「为什么被丢」的一部分）。
   * 它压根不是有限数字时是 `null` —— 原始值在 `rawCuts` 里。
   */
  page: number | null;
  reason: RejectionReason;
  /** 只在理由与引文有关（`evidence-unsupported`）时带上模型抄的那段 —— 缺了它就还是「不知道它说了什么」 */
  evidence?: string;
}

/**
 * `parseSegmentPlan` 的产物：可执行的计划 + **模型原样说了什么**。
 *
 * `rejected` / `rawCuts` 是给排查用的（API 层要能区分「模型弃权」与「模型给了切点但被丢掉」）。
 * 它们**不参与**下游切片：切分永远只看 `cuts`。
 */
export interface SegmentPlanParse extends SegmentPlan {
  /** 模型原样给出的 `cuts`（**未校验**）。空数组 = 模型弃权（或输出根本不是那个形状） */
  rawCuts: unknown[];
  /** 被丢掉的切点与理由，按被处理的顺序；`too-many-cuts` 那些排在最后 */
  rejected: RejectedCut[];
}

/**
 * 把模型的输出收敛成一份可执行的切分计划。
 *
 * 输入 `parsed` 是**不可信**的（模型的 JSON），`pages` 是这一份谱子实际取到窄带文本的页。
 * 任何一步不过就丢**那一个**切点，不整份弃权。
 *
 * `cuts` / `evidence` 的语义与形状**不许变**（前端与小程序都在读）；新增的
 * `rejected` / `rawCuts` 只加不改。
 */
export function parseSegmentPlan(parsed: unknown, pages: PageText[]): SegmentPlanParse {
  if (!parsed || typeof parsed !== "object") {
    return { cuts: [], evidence: [], rawCuts: [], rejected: [] };
  }
  const record = parsed as Record<string, unknown>;
  const rawCuts = Array.isArray(record.cuts) ? record.cuts : [];
  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];

  // 先把 cut 与 evidence **配对**再筛 —— 先筛 cuts 会让两个数组错位，
  // 于是「第 2 个切点的证据」被拿去校验第 3 个切点，配上一条看似合理的日志。
  const textOf = new Map(pages.map((p) => [p.page, p.text]));
  const pageCount = pages.reduce((m, p) => Math.max(m, p.page), 0);

  const kept: SegmentPlan = { cuts: [], evidence: [] };
  const rejected: RejectedCut[] = [];
  /** 丢一个切点。**每次 `continue` 都要留下理由** —— 这就是本次改动存在的理由本身。 */
  const drop = (page: number | null, reason: RejectionReason, evidence?: string) => {
    rejected.push(evidence === undefined ? { page, reason } : { page, reason, evidence });
  };
  /** 原始值 → 能带出去的页号。非有限数字（NaN/Infinity/字符串/对象）一律 null —— JSON 把 NaN 编成 null，
   *  在这里显式归一才不会有「本地是 NaN、线上是 null」的两种形状（本仓记过这个坑）。 */
  const pageOf = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const seen = new Set<number>();
  for (let i = 0; i < rawCuts.length; i++) {
    const cut = rawCuts[i];
    const ev = rawEvidence[i];

    // 页号必须是范围内的整数。**不含第 1 页**：第 1 页必然是第 1 段的开头，
    // 把它写成切点是模型在复述「第一页是开头」，不是边界。
    if (typeof cut !== "number" || !Number.isSafeInteger(cut)) {
      drop(pageOf(cut), "not-integer");
      continue;
    }
    if (cut < 1 || cut > pageCount) {
      drop(cut, "out-of-range");
      continue;
    }
    if (cut === 1) {
      drop(cut, "page-one");
      continue;
    }
    if (seen.has(cut)) {
      drop(cut, "duplicate");
      continue;
    }

    // 证据必须出自**那一页**（不是别页、也不是凭空写的）
    if (typeof ev !== "string") {
      drop(cut, "no-evidence");
      continue;
    }
    const source = textOf.get(cut);
    if (source === undefined) {
      drop(cut, "no-page-text");
      continue;
    }
    if (!evidenceSupports(ev, source)) {
      drop(cut, "evidence-unsupported", ev);
      continue;
    }

    seen.add(cut);
    kept.cuts.push(cut);
    kept.evidence.push(ev);
  }

  // 升序输出：模型不保证顺序，而下游按顺序切片
  const order = kept.cuts.map((c, i) => i).sort((a, b) => kept.cuts[a] - kept.cuts[b]);
  const cuts = order.map((i) => kept.cuts[i]);
  const evidence = order.map((i) => kept.evidence[i]);
  if (cuts.length > MAX_CUTS) {
    // 整份退回「不切」时也要说清是**上界**把已通过的切点丢了 —— 否则响应又变成
    // 「一条切点都没有」，与模型弃权同形（正是本次改动要消灭的那种不可区分）。
    for (const c of cuts) drop(c, "too-many-cuts");
    return { cuts: [], evidence: [], rawCuts, rejected };
  }
  return { cuts, evidence, rawCuts, rejected };
}

/**
 * 把模型给的切点变成**段**（含起止页，闭区间）。只给切点是为了契约最小；
 * 段是调用方与界面真正要的东西，在这里算一次，避免每个调用方各写一遍
 * （那正是「同一件事两处实现」的起点）。
 */
export function planToRanges(
  plan: SegmentPlan,
  pageCount: number,
): Array<{ from: number; to: number }> {
  const starts = [1, ...plan.cuts];
  return starts.map((from, i) => ({
    from,
    to: i + 1 < starts.length ? starts[i + 1] - 1 : pageCount,
  }));
}

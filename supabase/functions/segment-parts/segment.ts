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
  /** 候选没有给理由（`reason` 缺失或空串）—— 理由是与 `cuts` 同一版的契约要求 */
  "no-reason",
  /** 置信度不是 0..1 的有限数字 */
  "bad-confidence",
  /** 置信度低于自动采纳阈值：候选只展示给人，不自动切（方向仍是「宁可少切」） */
  "low-confidence",
  /** 候选页前面那一段里没有任何乐器名（只是把封面页单独切出来）—— 见 `prevInstrument` 的校验 */
  "no-instrument-before",
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
 * 候选被**自动采纳**的置信度下限。
 *
 * ⚠️ 这不是「模型有多准」的校准值，而是一条**方向性**的阈值：低于它的候选仍然回传给界面
 * （由人决定要不要），但**不进入 `cuts`** —— 分段的两条硬默认里「宁可少切」优先于「多切」。
 * 模型自报的置信度没有经过校准，所以它只能当提示，不能单独当判据（证据校验仍然必须通过）。
 */
export const MIN_CUT_CONFIDENCE = 0.6;

/** 一个候选首页（模型给的原样 + 后端裁决）。 */
export interface SegmentCandidate {
  /** 页号；不是有限数字时为 null（原始值在 `rawCuts` 里） */
  page: number | null;
  /** 模型写的理由；缺失/空串时为 null（这种候选不会被采纳） */
  reason: string | null;
  /** 模型自报的置信度；不是 0..1 的数字时为 null */
  confidence: number | null;
  /** 是否进入 `cuts`（= 通过全部校验且置信度 ≥ `MIN_CUT_CONFIDENCE`） */
  accepted: boolean;
  /** 没被采纳时的理由（slug，与 `REJECTION_REASONS` 同一套取值） */
  rejection?: RejectionReason;
}

export interface CandidatePlanParse extends SegmentPlanParse {
  /** 模型给的全部候选（含被采纳的），按页号升序、`page` 为 null 的排最后 */
  candidates: SegmentCandidate[];
}

/**
 * 把「候选首页 + 理由 + 置信度」收敛成可执行的切分计划（pkuso-backend#96 §6 契约改造）。
 *
 * 与 `parseSegmentPlan` 的关系：**`cuts` 的语义不变**，只是它现在由候选推导出来。
 * 模型若仍按旧形状（只有 `cuts`/`evidence`）回包，自动退回旧解析 —— 契约是**只加不改**的。
 */
export function parseCandidatePlan(parsed: unknown, pages: PageText[]): CandidatePlanParse {
  if (!parsed || typeof parsed !== "object") {
    return { cuts: [], evidence: [], rawCuts: [], rejected: [], candidates: [] };
  }
  const record = parsed as Record<string, unknown>;

  // 旧形状兜底：模型没按新契约回包时，行为与改动前逐字相同
  if (!Array.isArray(record.candidates)) {
    const old = parseSegmentPlan(parsed, pages);
    return {
      ...old,
      candidates: old.cuts.map((page) => ({
        page,
        reason: null,
        confidence: null,
        accepted: true,
      })),
    };
  }

  const textOf = new Map(pages.map((p) => [p.page, p.text]));
  const pageCount = pages.reduce((m, p) => Math.max(m, p.page), 0);

  const rawCuts: unknown[] = [];
  const candidates: SegmentCandidate[] = [];
  const rejected: RejectedCut[] = [];
  const kept: SegmentPlan = { cuts: [], evidence: [] };
  const seen = new Set<number>();
  /** 已通过单条校验的候选（还要过第二遍「前段有乐器名」） */
  const accepted: Array<{ page: number; evidence: string; prevInstrument: unknown }> = [];

  /** 丢一个候选：既不采纳、也进 `rejected`（与旧路径同一套排查字段）。 */
  const drop = (c: SegmentCandidate, reason: RejectionReason, evidence?: string) => {
    c.accepted = false;
    c.rejection = reason;
    rejected.push(evidence === undefined ? { page: c.page, reason } : { page: c.page, reason, evidence });
  };

  for (const item of record.candidates) {
    if (!item || typeof item !== "object") {
      const c: SegmentCandidate = { page: null, reason: null, confidence: null, accepted: false };
      candidates.push(c);
      drop(c, "not-integer");
      continue;
    }
    const raw = item as Record<string, unknown>;
    const c: SegmentCandidate = {
      page: typeof raw.page === "number" && Number.isFinite(raw.page) ? raw.page : null,
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : null,
      confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : null,
      accepted: false,
    };
    candidates.push(c);
    rawCuts.push(raw.page);

    // 页号：安全整数、范围、不是第 1 页、不重复（与旧路径逐条一致）
    if (typeof raw.page !== "number" || !Number.isSafeInteger(raw.page)) {
      drop(c, "not-integer");
      continue;
    }
    if (raw.page < 1 || raw.page > pageCount) {
      drop(c, "out-of-range");
      continue;
    }
    if (raw.page === 1) {
      drop(c, "page-one");
      continue;
    }
    if (seen.has(raw.page)) {
      drop(c, "duplicate");
      continue;
    }
    // 理由：契约要求每个候选都说清「为什么像首页」—— 没说清的不能自动切
    if (c.reason === null) {
      drop(c, "no-reason");
      continue;
    }
    // 置信度：模型自报的数值只当提示；不合形状的候选一律不采纳（而不是猜一个默认值）
    if (c.confidence === null || c.confidence < 0 || c.confidence > 1) {
      drop(c, "bad-confidence");
      continue;
    }
    // 证据：必须出自**那一页**（与旧路径同一套校验）
    const ev = raw.evidence;
    const source = textOf.get(raw.page);
    if (typeof ev !== "string") {
      drop(c, "no-evidence");
      continue;
    }
    if (source === undefined) {
      drop(c, "no-page-text");
      continue;
    }
    if (!evidenceSupports(ev, source)) {
      drop(c, "evidence-unsupported", ev);
      continue;
    }
    // 低置信：照回传、由人决定，但**不自动切**（「宁可少切」）
    if (c.confidence < MIN_CUT_CONFIDENCE) {
      drop(c, "low-confidence");
      continue;
    }

    seen.add(raw.page);
    c.accepted = true;
    accepted.push({ page: raw.page, evidence: ev, prevInstrument: raw.prevInstrument });
  }

  // ⚠️ **第二遍：校验「候选页前面那一段里有乐器名」**（pkuso-web 的封面页误切就是靠这条挡的）。
  // 模型自报 `prevInstrument`，后端再拿它去**前一段的原文**里做子串校验 —— 两个条件都过才算数：
  // 既不能是空/null，也不能是模型编的（必须在原文里找得到）。字段**缺席**时跳过（旧形状兜底）。
  accepted.sort((a, b) => a.page - b.page);
  let prevStart = 1;
  for (const a of accepted) {
    if (a.prevInstrument !== undefined) {
      const ctx = pages
        .filter((p) => p.page >= prevStart && p.page <= a.page - 1)
        .map((p) => p.text)
        .join("\n");
      const claimed = typeof a.prevInstrument === "string" ? a.prevInstrument.trim() : "";
      const ok = claimed !== "" && evidenceSupports(claimed, ctx);
      if (!ok) {
        drop(
          candidates.find((x) => x.page === a.page)!,
          "no-instrument-before",
          claimed === "" ? undefined : claimed,
        );
        continue;
      }
    }
    kept.cuts.push(a.page);
    kept.evidence.push(a.evidence);
    prevStart = a.page;
  }

  // 升序输出：模型不保证顺序，而下游按顺序切片
  const order = kept.cuts.map((_, i) => i).sort((a, b) => kept.cuts[a] - kept.cuts[b]);
  const cuts = order.map((i) => kept.cuts[i]);
  const evidence = order.map((i) => kept.evidence[i]);
  if (cuts.length > MAX_CUTS) {
    for (const c of cuts) drop(candidates.find((x) => x.page === c)!, "too-many-cuts");
    return { cuts: [], evidence: [], rawCuts, rejected, candidates: sorted(candidates) };
  }
  return { cuts, evidence, rawCuts, rejected, candidates: sorted(candidates) };
}

/** 候选按页号升序；`page` 为 null 的排最后（模型给的不是数字，展示时也不该插在中间）。 */
function sorted(list: SegmentCandidate[]): SegmentCandidate[] {
  return [...list].sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
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

/**
 * llm-analyze 的纯逻辑 —— 与 Deno / fetch / DeepSeek 无关，可独立测试。
 *
 * 设计要点见 pkuso-backend#12：把「识别乐器」换成「归到声部 + 给出中文乐器名」。
 * 声部是闭集（16 个，稳定不增长），乐器名是开集（交给 LLM 直接产中文，不设白名单）。
 */

/**
 * 声部闭集。
 *
 * ⚠️ 必须与 pkuso-web/src/constants/instruments.ts 的 INSTRUMENT_ORDER **逐字一致**。
 * 两仓之间没有自动同步机制 —— 前端拿到 section 后也会对照自己的那份校验，
 * 不一致时在界面上标出，这是防止词表漂移的可见告警。
 * `index.ts` 的 prompt 里那份列表也由本常量生成，不手抄。
 */
export const SECTIONS = [
  "第一小提琴",
  "第二小提琴",
  "中提琴",
  "大提琴",
  "低音提琴",
  "长笛",
  "双簧管",
  "单簧管",
  "大管",
  "圆号",
  "小号",
  "长号",
  "大号",
  "打击乐",
  "键盘",
  "竖琴",
] as const;

/** 弃权时使用的声部。仅本模块内部使用 —— `Analysis.section` 是 `string`，
 *  因为「其他」不在 `SECTIONS` 里，用 `Section` 类型反而要额外开洞。 */
const OTHER_SECTION = "其他";

/**
 * section 的合法取值 = 16 声部 + 「其他」。
 *
 * 「其他」必须算**合法**：prompt 明确让模型「判断不出来时用其他」，那是正常弃权路径，
 * 不是词表漂移。若把它判成闭集外的值，`sectionRaw` 会在每次正常弃权时出现 ——
 * 而这个字段的语义是「发现 prompt 词表漂移」，一旦每次都出现就等于失效。
 */
const VALID_SECTIONS: readonly string[] = [...SECTIONS, OTHER_SECTION];

/**
 * 小提琴的分声部**由声部名决定**，不取自模型输出。
 *
 * 这不只是消除冗余 —— 它是「后端先上、前端后上」这个上线顺序的**承重结构**。
 * 旧版前端（pkuso-web#283 之前）只读 instrument/subPart，且它的 generateFileName
 * 仅在 `instrument === "Violin"` 时才拼声部名。新契约不再返回 "Violin"，
 * 于是两支小提琴都被算成「小提琴.pdf」；而上传用的是 upsert:true ——
 * 后传的会**静默覆盖**先传的，两份分谱丢一份。由 section 反推 1/2 之后，
 * 旧前端算出的是「小提琴_1.pdf」「小提琴_2.pdf」两个不同路径，不再相撞。
 *
 * ⚠️ **上面这条理由现在已经过时了**（2026-09-23 核）：存储键早已改成
 * `{scoreId}/{行 id}.pdf`（uuid），文件名怎么算都撞不上，而那个「旧前端」
 * 也早就不在线上（#286 已部署）。也就是说**这段兜底今天不再是承重结构**。
 *
 * 留着它是因为序号让分谱文件名自解释（`小提琴_1.pdf` 好过 `小提琴.pdf`），
 * 且**删它会牵动 `ambiguous-violin` 那道弃权**（那条守的正是「小提琴分不出序号」，
 * 而它原本要防的静默覆盖已经不成立）。那是一次独立的取舍，不塞进本次改动里。
 */
const VIOLIN_SUB_PART: Record<string, number> = {
  第一小提琴: 1,
  第二小提琴: 2,
};

/**
 * 乐器名「看着就是小提琴」。用于 buildAnalysis 末尾那道兜底：
 * 声部名不守词表时，就再没有别的依据能定出分声部号了（模型的输出不作数，
 * 序号只由 `VIOLIN_SUB_PART` 按声部推导）—— 两处都没有，宁可弃权让用户手填。
 * 中提琴 / 大提琴 / 低音提琴都不含这些词，不会被误判。
 *
 * 匹配前先过 `normalizeForMatch`，所以全角（`Ｖｉｏｌｉｎ`）、大小写、空格标点
 * 都会被归到同一形式，不需要 `i` 标志。重音字母 NFKC 不折叠，所以 `violín`
 * 单独列出来。
 *
 * `violon(?!c)` 那个否定环视是必须的：法语的提琴是 `violon`、大提琴是
 * `violoncelle`，只差一个后缀 —— 不加环视会把**每一份大提琴**都误判成小提琴
 * 而弃权（`Violoncello` 同理）。这与「不敢用 `viol` 是因为会吃掉 `Viola`」是同一类坑。
 *
 * ⚠️ 这是一张**网**，不是分类器 —— 认不出某种外文写法，兜底就会漏。
 *
 * ⚠️ 再说一次（同 `VIOLIN_SUB_PART` 那段）：它守的「两支撞成同一条路径」**今天已不可能**
 * —— 存储键早就是 `{scoreId}/{行 id}.pdf`（uuid），与文件名无关。所以这道网现在是
 * 双保险而不是承重墙；它真正的作用退化成「分不出序号就别猜」。
 */
const VIOLIN_LIKE = /小提琴|viol[ií]n|violon(?!c)|скрипка/;

/**
 * 韩文填充符。它们的 Unicode 类别是 `Lo`（字母），会被下面的 `\p{L}` 留下来，
 * 但渲染出来是空白 —— 两个就能凑够长度门冒充引文，得单独剥掉。
 * NFKC 会把 U+FFA0 折成 U+1160，所以剥的动作必须在 NFKC **之后**。
 */
const BLANK_LETTERS = /[\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/**
 * 归一化后用于包含判断。
 *
 * NFKC 先把全角/兼容形式折叠成常规形式（`２`→`2`、`ｘ`→`x`、NFD 的音调符号合成回去），
 * 这一步收窄 OCR 常见的形式差异，避免真引文被误判成伪造引文。
 * 然后只保留字母与数字 —— 一次剥掉空白、标点、符号，以及 `\p{Cf}`（零宽空格、
 * 软连字符、BOM）、`\p{Cc}`（控制字符）、`\p{Mn}`（组合记号）这些看不见的字符。
 * 不剥的话，两个零宽空格就能凑够长度冒充引文，把证据门整个骗过去。
 *
 * 不做归一化就直接比较同样不行 —— OCR 与模型抄写常在空格、连字符、大小写上
 * 不一致（`Horn_2` / `Horn 2` / `HORN-2` 是同一件事）。数字必须保留：分声部号是有意义的证据。
 *
 * ⚠️ 必须定义在 NON_ANSWER_* 之前：那些常量在模块加载时就调用它，
 * 而 `const` 没有提升 —— 放到后面会撞 TDZ。
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(BLANK_LETTERS, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * 模型用来表示「答不出来」的说法。它们**不是**乐器名 —— 放过去会建出一个
 * 名叫 `无法判断` 的声部与 `无法判断.pdf` 写进库，正是 #12「背景 2」要消灭的
 * 那类结果（旧版的 "unknown" 哨兵就是在 temperature=0 的硬选行为下失效的）。
 *
 * ⚠️ 这是一张**网**，不是一道证明：自由文本无法被穷举，永远有下一个说法。
 * 真正的防线是「证据门 + 用户确认」，这里只兜住模型不守契约（prompt 规则 3
 * 要求这几种情况返回空串）时最可能吐出来的东西。
 *
 * 两个机制，各管一类：
 * - `EXACT` 精确匹配 —— 用于「无」「其他」这种太短、当子串会误伤真乐器名的词
 * - `STEMS` 子串匹配 —— 模型会把它们拼长（`未识别到` / `无法判断出来` /
 *   `不能确定`），精确匹配追不上
 *
 * 两者都先过 normalizeForMatch，因此大小写、空白、标点与全角变体
 * （`ＵＮＫＮＯＷＮ` / `Unknown.` / `u n k n o w n` / `N.A.`）命中同一项。
 */
// 表项按**归一化后**的形式比较，所以写 "n/a" 与写 "na" 是同一项。
// 纯标点（如 "?"）不必列 —— 归一化后成空串，isNonAnswer 开头就返回 true。
const NON_ANSWER_EXACT = [
  "unknown", "undefined", "null", "nan", "nil", "none", "n/a",
  "无", "其他", "略",
];

const NON_ANSWER_STEMS = [
  // 英文：词根形式让 `Unknown.` / `unknown instrument` 这类也能命中
  "unknown", "undefined", "nil", "none",
  // 中文：模型会把词根拼长（`未识别到` / `判断不出来`），精确匹配追不上
  "无法", "不能", "未识别", "未知", "不明", "不确定", "待定", "不详",
  "没有", "识别不", "判断不", "读不出", "看不出", "不清楚", "答不出",
  "无乐器", "未标注", "未注明",
];

const NON_ANSWER_EXACT_SET = new Set(NON_ANSWER_EXACT.map(normalizeForMatch));
const NON_ANSWER_STEM_LIST = NON_ANSWER_STEMS.map(normalizeForMatch);

/** 这个字符串是不是「答不出来」而不是一个乐器名。 */
function isNonAnswer(instrument: string): boolean {
  const n = normalizeForMatch(instrument);
  if (!n) return true;
  if (NON_ANSWER_EXACT_SET.has(n)) return true;
  return NON_ANSWER_STEM_LIST.some((stem) => n.includes(stem));
}

/**
 * 引文归一化后至少要剩这么多字符才算证据。
 *
 * 数的是 **NFKC 折叠之后**的字符数，所以个别兼容字符会被展开成多个
 * （`½`→`12`、`Ⅻ`→`xii`）。展开是语义忠实的，不构成伪造引文，
 * 但别把它读成「至少 2 个可见字符」。详见 evidenceSupports。
 */
const MIN_EVIDENCE_CHARS = 2;

/**
 * 乐器名的长度上界。
 *
 * 旧前端把 instrument 直接当**存储路径的目录名**用
 * （`{scoreId}/${instrument}/${fileName}.pdf`），一个几千字的「乐器名」
 * 会造出一条荒唐的路径。真实乐器名没有超过 20 字的，给到 64 已经极宽松 ——
 * 触顶说明模型在胡说，弃权让用户填比放它进 storage 好。
 *
 * 只设长度、不做字符替换：`木琴/钟琴` 这种合称是 #12 验收标准里允许的写法，
 * 而后端没有立场去改写一个用户会看到的乐器名。
 */
const MAX_INSTRUMENT_CHARS = 64;

/**
 * 乐器名里绝对不能出现的字符。
 *
 * 旧前端把 instrument 直接当**存储路径的目录名**用，而乐器名从白名单改成开集之后，
 * 模型给的任意串都会流到那里。`..` 构成路径穿越，控制字符会破坏路径与文件名。
 *
 * **拦下让用户手填，而不是替换字符**：`木琴/钟琴` 这种合称是 #12 允许的写法，
 * 后端没有立场去改写一个用户会看到的乐器名 —— 而 `/` 只是多一层目录，不致命。
 */
const ILLEGAL_IN_INSTRUMENT = /\.\.|\p{Cc}|\p{Cf}/u;

export interface Analysis {
  section: string;
  instrument: string;
  /**
   * 分声部号，**升序去重**。空数组 = 没有分声部，或没解析出来（两者对调用方等价）。
   *
   * 从 `subPart: number | null` 换成数组，是因为真实谱子里大量存在「一份文件覆盖
   * 多个分声部」：`Horn_1,_2,_3,_4.pdf` 是 4 个圆号订成一份，`Oboe_1,_2.pdf` 同理。
   * 单值表达不了它 —— 模型返 `1` 会存成「圆号 1」（错），返 `"1,2,3,4"` 会整串丢掉。
   */
  subParts: number[];
  evidence: string;
  /** LLM 给的 section 落在闭集之外时，带上原值供排查 */
  sectionRaw?: string;
  /** 弃权原因，仅在 instrument 为空串时出现 */
  abstainReason?: string;
}

/**
 * evidence 是否真的能在输入文本里找到。
 *
 * 这是把「证据不足必须弃权」从 prompt 口号变成**代码机制**的地方。
 * temperature=0 下模型会硬选一个最接近的而不弃权（见 #12 第 2 点），
 * 光在 prompt 里写规则拦不住 —— 实测 `unknown` 几乎从不出现。
 *
 * ⚠️ 它判的是「引文**存在于**输入」而非「引文**支撑**结论」。具体到最松的一例：
 * 调用方（pkuso-web upload-modal.tsx）会把文件名与 OCR 文本拼成
 * `文件名: X\nOCR 文本: Y` 再发过来，于是模型抄 `OCR 文本` 这四个字就能通过。
 * 契约只要求「能在输入里找到」，且后端没有立场去剥调用方拼的标签
 * （那是给调用方格式打指纹，比这个弱点更脆）。
 * 真正的收紧手段是 #283 让前端分开传两个字段，而不是拼成一段。
 *
 * 代价：OCR 把引文打花时会误弃权。这个方向的错误是可接受的 ——
 * 用户手填一次乐器名，好过把模型猜的东西预填进界面、被用户当成「已确认」接受。
 */
export function evidenceSupports(evidence: string, source: string): boolean {
  const needle = normalizeForMatch(evidence);
  // 归一化会剥掉一切非字母数字，于是「。」「👨‍👩‍👦」、两个零宽空格（U+200B）
  // 这类引文会变成空串或极短串 —— 而空串是任意字符串的子串。
  // 按**码点**数（不是码元）要求至少剩 2 个字符，把这条路堵死。
  // （这里刻意不写出真的零宽字符：它们会被 lint 判为 irregular whitespace，
  //   而且更容易在编辑/格式化中被悄悄吃掉。）
  if ([...needle].length < MIN_EVIDENCE_CHARS) return false;
  return normalizeForMatch(source).includes(needle);
}

/** 分声部号的上界（值本身）。上界用 isSafeInteger —— 400 位数字串 Number() 出来是
 *  Infinity，它作为 number 流进进程内调用方、却在 JSON 里被序列化成 null，同一次调用两个值。 */
const isValidSubPart = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/**
 * 分声部号的**个数**上界。它不防模型犯错，防的是文件名被撑爆：
 * 号会进 `file_name`（`圆号_1,2,3.pdf`），而下载时那个名字要落到用户的文件系统上。
 */
const MAX_SUB_PARTS = 32;

/**
 * 分声部号。**唯一合法格式是英文逗号分隔的阿拉伯数字**：`1` / `1,2` / `1,2,3`。
 *
 * 归一化只收敛「同一个符号的不同写法」：NFKC 折全角（`２`→`2`），全角逗号「，」
 * 与顿号「、」折半角，去空白。这是**编码收敛，不是猜测**。
 *
 * 其余一律**弃权（返回空数组）**：
 * - `1-3` 这类区间：是 1,2,3 还是「第 1 和第 3」？替模型决定语义就是猜。
 * - 罗马数字 / 中文数字：prompt 已明确要求阿拉伯数字，容忍它们等于同时维护两套解析。
 * - **只要有一个非空片段不是正整数，整个弃权** —— 部分解析比不解析更危险：
 *   `1,2,3支` 若丢掉 `3支` 得到 `[1,2]`，那是个**看起来对**的错答案，会一路写进文件名；
 *   而弃权只是让用户手填一次。与 `evidenceSupports` 是同一条哲学。
 *
 * 返回升序去重的数组。空数组 = 没有分声部，**或**没解析出来 —— 两者对调用方等价。
 */
export function parseSubParts(raw: unknown): number[] {
  // 标量写成数组、数组写成标量，JSON 里两种都会发生，都接
  const parts = Array.isArray(raw) ? raw : [raw];
  if (parts.length > MAX_SUB_PARTS) return [];

  const out = new Set<number>();
  for (const part of parts) {
    if (typeof part === "number") {
      if (!isValidSubPart(part)) return [];
      out.add(part);
      continue;
    }
    if (typeof part !== "string") return [];
    const tokens = part
      .normalize("NFKC")
      .replace(/[，、]/g, ",")
      .split(",")
      .map((t) => t.trim())
      // 空片段只来自多打/少打逗号（`1,2,`），是格式噪声不是内容 —— 它不该让整串弃权
      .filter((t) => t !== "");
    if (tokens.length === 0) return [];
    for (const t of tokens) {
      // 只认纯数字：`parseInt("2 支")` 会得到 2，那种「宽容」会把噪声当成分声部号
      if (!/^\d+$/.test(t)) return [];
      const num = Number(t);
      if (!isValidSubPart(num)) return [];
      out.add(num);
    }
  }
  // ⚠️ 个数上界要在**解析之后**再判一次：上面那次只挡数组形态，而
  // `"1,2,…,33"` 是**一个字符串**（`parts.length` 恒为 1），从那里过不去。
  // （这个洞是我自己的用例抓出来的 —— 先写了「33 个应弃权」才发现实现挡不住。）
  if (out.size > MAX_SUB_PARTS) return [];

  return [...out].sort((a, b) => a - b);
}

/**
 * 校验 section 是否落在闭集内（16 声部 + 其他）。
 *
 * **这是校验，不是映射。** 不认识的声部名不做任何猜测性归并 ——
 * 猜错会把一份谱子分到错误的声部，比落到「其他」让用户自己选有害得多。
 * 落「其他」时带上原值，便于发现 prompt 词表漂移。
 */
export function normalizeSection(raw: unknown): { section: string; sectionRaw?: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (VALID_SECTIONS.includes(s)) return { section: s };
  return s ? { section: OTHER_SECTION, sectionRaw: s } : { section: OTHER_SECTION };
}

/** 弃权形态：instrument 为空串即「未识别」，前端据此标「需人工确认」且不预填。 */
export function abstain(reason: string, sectionRaw?: string): Analysis {
  return {
    section: OTHER_SECTION,
    instrument: "",
    subParts: [],
    evidence: "",
    abstainReason: reason,
    ...(sectionRaw ? { sectionRaw } : {}),
  };
}

/**
 * 把 LLM 返回的 JSON 收敛成契约结果。任何一步不成立都走弃权，不做猜测性兜底。
 *
 * @param parsed 已 JSON.parse 的模型输出
 * @param source 送给模型的原始文本 —— evidence 必须能在其中找到。
 *   收 `unknown` 而非 `string`：请求体是用户可控的 JSON，值不一定是字符串，
 *   这里必须自己兜住而不是让调用方的类型假设变成运行时异常。
 */
export function buildAnalysis(parsed: unknown, source: unknown): Analysis {
  const record =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  const instrument = typeof record.instrument === "string" ? record.instrument.trim() : "";
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
  const { section, sectionRaw } = normalizeSection(record.section);

  // 模型自己弃权了
  if (!instrument) return abstain("empty-instrument", sectionRaw);
  // 模型用「答不出来」的说法冒充乐器名 —— 与空串同等对待
  if (isNonAnswer(instrument)) return abstain("non-answer", sectionRaw);
  if (instrument.length > MAX_INSTRUMENT_CHARS) return abstain("instrument-too-long", sectionRaw);
  if (ILLEGAL_IN_INSTRUMENT.test(instrument)) return abstain("instrument-illegal-chars", sectionRaw);

  // source 类型不对就没法验证据。正常路径下 index.ts 已经拦掉了，
  // 这里是兜底：区分「请求非法」与「模型在编」，不要让后者替前者背锅。
  if (typeof source !== "string") return abstain("bad-source", sectionRaw);

  // 引不出原文 = 在猜
  if (!evidence) return abstain("no-evidence", sectionRaw);
  if (!evidenceSupports(evidence, source)) return abstain("evidence-not-in-source", sectionRaw);

  const violinSubPart = VIOLIN_SUB_PART[section];
  const subParts = violinSubPart !== undefined ? [violinSubPart] : parseSubParts(record.subParts);

  // 兜底 —— 不依赖 prompt 是否被遵守。
  //
  // 小提琴是**唯一**「两支共享同一个 instrument 名」的声部：序号一旦缺失，
  // 旧前端会为两份分谱算出同一条存储路径（{scoreId}/小提琴/小提琴.pdf），
  // 而上传是 upsert:true —— 后传的静默覆盖先传的。
  //
  // 序号从两处取：声部名（VIOLIN_SUB_PART）或模型自己给的 subParts。两处都没有，
  // 就是真的分辨不出来 —— 宁可不识别（让用户手填），也不要覆盖掉一份分谱。
  //
  // ⚠️ 这里**不能**再加 `sectionRaw &&`：`sectionRaw` 只在 section 落闭集外时才出现，
  // 而「其他」是闭集内的合法值、又正是 prompt 规则 3 指定的退路 ——
  // 加了就把最常见的那条路漏掉了。（第一/第二小提琴的序号由
  // VIOLIN_SUB_PART 给出 1/2、永不为空，所以放开这个条件不会误伤它们。）
  //
  // 判据只认「乐器名看着就是小提琴」，中提琴/大提琴/低音提琴不含「小提琴」三字。
  if (subParts.length === 0 && VIOLIN_LIKE.test(normalizeForMatch(instrument))) {
    return abstain("ambiguous-violin", sectionRaw);
  }

  return {
    section,
    instrument,
    subParts,
    evidence,
    ...(sectionRaw ? { sectionRaw } : {}),
  };
}

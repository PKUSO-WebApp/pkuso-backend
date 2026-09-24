import {
  abstain,
  buildAnalysis,
  evidenceSupports,
  MAX_SUB_PARTS,
  normalizeForMatch,
  normalizeSection,
  parseSubParts,
  SECTIONS,
} from "./analyze.ts";

/**
 * 跑法：deno test --allow-env=DEEPSEEK_API_KEY supabase/functions/llm-analyze/
 * （--allow-env 是给同目录的 index.test.ts 用的；本文件本身不需要任何权限。）
 *
 * 每个用例对应一条**踩过的坑**，不是凑覆盖率 —— 注释里写清它防的是什么。
 */

const SOURCE = `文件名: PMLASIA01178-26-Glock-Xylo.pdf
OCR 文本: Д. ШОСТАКОВИЧ
ПЯТАЯ СИМФОНИЯ
Campanelli e Silofono
Allegretto`;

const eq = (actual: unknown, expected: unknown, msg: string) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  // 必须连 typeof 一起比：JSON.stringify(Infinity) 与 JSON.stringify(NaN)
  // 都是 "null"，只比字符串会让「防溢出」的用例即使代码退回旧实现也照样通过。
  if (a !== e || typeof actual !== typeof expected) {
    throw new Error(`${msg}\n  实际: ${a} (${typeof actual})\n  期望: ${e} (${typeof expected})`);
  }
};

Deno.test("16 声部与 pkuso-web 的 INSTRUMENT_ORDER 逐字一致", () => {
  // 这条守卫的是**本仓**的漂移：对不上时 normalizeSection 会把所有结果打成
  // 「其他」，而且是静默的。
  // ⚠️ 它发现不了 pkuso-web 侧的漂移 —— 跨仓无法 import，那边靠 #283 的
  // section 校验在前端界面上报警。
  eq(SECTIONS.length, 16, "声部数");
  eq([...SECTIONS], [
    "第一小提琴", "第二小提琴", "中提琴", "大提琴", "低音提琴",
    "长笛", "双簧管", "单簧管", "大管", "圆号", "小号", "长号", "大号",
    "打击乐", "键盘", "竖琴",
  ], "声部列表");
});

Deno.test("正常路径：打击乐 / 木琴", () => {
  const r = buildAnalysis(
    { section: "打击乐", instrument: "木琴", subParts: [], evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(r.section, "打击乐", "section");
  eq(r.instrument, "木琴", "instrument");
  eq(r.subParts, [], "没有分声部时是空数组");
  eq(r.abstainReason, undefined, "不应弃权");
});

Deno.test("弃权：乐器名为空串", () => {
  const r = buildAnalysis(
    { section: "其他", instrument: "", subParts: [], evidence: "" },
    SOURCE,
  );
  eq(r.instrument, "", "instrument");
  eq(r.section, "其他", "section");
  eq(r.abstainReason, "empty-instrument", "原因");
});

Deno.test("弃权：「答不出来」的各种说法都不是乐器名", () => {
  // 防的是 #12「背景 2」那个失败模式：放过去会建出名叫「无法判断」的声部
  // 与「无法判断.pdf」。这是**一类**输入而不是几个字面量 ——
  // 精确匹配（无/其他这种太短的词）+ 词根包含（模型会把词拼长）两个机制合起来兜。
  // 旧版的 "unknown" 哨兵就是被 temperature=0 的硬选行为吃掉的。
  const bad = [
    // 英文
    "unknown", "UNDEFINED", "null", "NaN", "nil", "None", "n/a", "N.A.",
    // 只有归一化之后才能命中的变体（全角 / 标点 / 空格 / 大小写）
    "ＵＮＫＮＯＷＮ", "Unknown.", "u n k n o w n", "N / A",
    // 中文：模型的高频弃权说法
    "无法判断", "无法识别", "不能识别", "未识别", "未识别到", "未知", "不明",
    "不确定", "待定", "不详", "没有", "无", "其他", "略",
    "判断不出来", "识别不出", "答不出来",
  ];
  for (const name of bad) {
    const r = buildAnalysis({ section: "圆号", instrument: name, evidence: "Corno" }, "Corno");
    eq(r.instrument, "", `「${name}」应弃权`);
    eq(r.abstainReason, "non-answer", `「${name}」原因`);
  }
});

Deno.test("非答案黑名单不误杀真实乐器名", () => {
  // 词根用的是「包含」匹配，这条确认它没把真名吃掉。
  const real = [
    "中提琴", "大提琴", "低音提琴", "长笛", "短笛", "双簧管", "英国管",
    "单簧管", "低音单簧管", "大管", "低音大管", "萨克斯", "圆号", "小号", "长号",
    "大号", "瓦格纳大号", "上低音号", "木琴", "钟琴", "马林巴", "颤音琴", "定音鼓",
    "大鼓", "小鼓", "三角铁", "钹", "铃鼓", "排钟", "钢琴", "钢片琴", "竖琴",
    "吉他", "曼陀林", "埙", "笙", "唢呐", "筚篥", "箜篌", "阮", "琵琶", "古筝",
    "二胡", "管钟", "木鱼", "中国大鼓", "节奏", "键盘", "竖笛", "口琴",
  ];
  for (const name of real) {
    const r = buildAnalysis(
      { section: "其他", instrument: name, evidence: "Campanelli e Silofono" },
      SOURCE,
    );
    eq(r.instrument, name, `「${name}」被误杀`);
  }
  // 「小提琴」单独测：它在「其他 + 空分声部」下**应当**被 ambiguous-violin 兜底
  // 拦下（那正是两支会分辨不出来的情形），所以要给一个正常的声部与序号。
  const v = buildAnalysis(
    { section: "中提琴", instrument: "小提琴", subParts: [1], evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(v.instrument, "小提琴", "有分声部号时不该被误杀");
  eq(v.subParts, [1], "分声部号");
});

Deno.test("弃权：没有 evidence", () => {
  const r = buildAnalysis({ section: "圆号", instrument: "圆号", subParts: [2] }, SOURCE);
  eq(r.instrument, "", "instrument");
  eq(r.abstainReason, "no-evidence", "原因");
});

Deno.test("弃权：evidence 不在原文里（模型在编）", () => {
  const r = buildAnalysis(
    { section: "大管", instrument: "大管", subParts: [1], evidence: "Fagotto I" },
    SOURCE,
  );
  eq(r.instrument, "", "instrument");
  eq(r.abstainReason, "evidence-not-in-source", "原因");
});

Deno.test("evidence：下划线/空格/连字符/全角/大小写差异仍算命中", () => {
  if (!evidenceSupports("Horn_2", "文件名: PMLASIA01165-13-Horn 2.pdf")) throw new Error("下划线");
  if (!evidenceSupports("CAMPANELLI E SILOFONO", SOURCE)) throw new Error("大小写");
  if (!evidenceSupports("Campanelli  e   Silofono.", SOURCE)) throw new Error("多空格+句点");
  // NFKC 折叠：全角字母数字要等于半角
  if (!evidenceSupports("Ｈｏｒｎ　２", "Horn 2")) throw new Error("全角");
  // 兼容字符
  if (!evidenceSupports("Ⅻ", "XII")) throw new Error("罗马数字兼容形式");
});

Deno.test("evidence：不可见字符不能冒充引文", () => {
  // 归一化只保留字母数字，\p{Cf}/\p{Cc}/\p{Mn} 全部剥掉 ——
  // 否则两个零宽空格就能凑够长度，把证据门整个骗过去。
  // 用 \u 转义而不是字面字符：字面零宽字符一旦被编辑器/格式化工具吃掉，
  // 用例会悄悄退化成「比较空串」而依旧全绿。
  const invisible = [
    String.fromCharCode(0x200b, 0x200b), // 零宽空格
    String.fromCharCode(0x00ad, 0x00ad), // 软连字符
    String.fromCharCode(0x200d, 0x200d), // 零宽连接符
    String.fromCharCode(0x0301, 0x0301), // 组合记号
    String.fromCharCode(0x0000, 0x0000), // NUL
    String.fromCharCode(0xfeff), // BOM
    // 韩文填充符：Unicode 类别是 Lo（字母），会躲过 [^\p{L}\p{N}] 的过滤，
    // 但渲染为空白 —— 必须单独剥掉，否则两个就能凑够长度门
    String.fromCharCode(0x3164, 0x3164), // U+3164
    String.fromCharCode(0x115f, 0x115f), // U+115F
    String.fromCharCode(0xffa0, 0xffa0), // U+FFA0（NFKC 会折成 U+1160）
    "。", "　", "  ", "\t",
  ];
  for (const x of invisible) {
    // ⚠️ 必须直接断言归一化结果。只断言 `evidenceSupports(x, SOURCE)` 为 false 是
    // **空转的** —— SOURCE 里根本没有这些字符，无论归一化怎么写都会死在 includes
    // 分支上，两种实现结论一样。变异测试里把 BLANK_LETTERS 换成 /(?!)/ 之后
    // 用例照样全绿，说明它测不到那条逻辑。
    eq(normalizeForMatch(x), "", `归一化(${JSON.stringify(x)}) 应为空`);

    // 再走一条**源里真的含该字符**的路径，确认它既不能冒充引文、也不会把真引文带坏。
    // 把 x 放在行首：组合记号若紧跟在字母后面会被 NFKC **合成**进那个字母
    //（`a` + U+0301 → `á`），那样测的就不是「剥掉」而是「合成」，会得出错误结论。
    const src = `${x}\nOCR 文本: ab`;
    if (evidenceSupports(x, src)) throw new Error(`不可见引文「${JSON.stringify(x)}」不该通过`);
    if (!evidenceSupports("ab", src)) {
      throw new Error(`剥掉不可见字符后 "ab" 应当命中: ${JSON.stringify(x)}`);
    }
  }
  eq(
    normalizeForMatch(String.fromCharCode(0x200b) + "。" + String.fromCharCode(0x00ad)),
    "",
    "归一化后应为空",
  );
});

Deno.test("evidence：长度不足与空串不算证据", () => {
  // 空串是任意字符串的子串 —— 不挡住就等于给伪造证据开门
  if (evidenceSupports("", SOURCE)) throw new Error("空串不该通过");
  if (evidenceSupports("e", SOURCE)) throw new Error("单字符不该通过");
  if (evidenceSupports("管", SOURCE)) throw new Error("单个汉字不该通过");
  // 按**码点**数而不是码元：星光平面字母占 2 个 UTF-16 码元但只有 1 个字符。
  // 用 .length 判的话这里会误判成「够长」。
  const astral = String.fromCodePoint(0x20000);
  eq(normalizeForMatch(astral).length, 2, "星光平面字符占 2 码元");
  if (evidenceSupports(astral, `x${astral}y`)) throw new Error("单个星光平面字符不该通过");
});

Deno.test("section：「其他」是合法值，不该报词表漂移", () => {
  // prompt 明确让模型判不出时用「其他」，那是正常弃权路径。
  // 若把它判成闭集外，sectionRaw 会在每次正常弃权时出现，这个告警字段就失效了。
  const r = normalizeSection("其他");
  eq(r.section, "其他", "section");
  eq(r.sectionRaw, undefined, "不该带 sectionRaw");
});

Deno.test("section 不在闭集：落「其他」并带原值", () => {
  const r = buildAnalysis(
    { section: "木管", instrument: "长笛", subParts: [1], evidence: "Flute 1" },
    "Flute 1",
  );
  eq(r.section, "其他", "section");
  eq(r.sectionRaw, "木管", "sectionRaw");
  eq(r.instrument, "长笛", "乐器本身仍可用，不连坐");
});

Deno.test("section 缺失也算不在闭集，但不带原值", () => {
  const r = normalizeSection(undefined);
  eq(r.section, "其他", "section");
  eq(r.sectionRaw, undefined, "sectionRaw");
});

Deno.test("section 前后空白被 trim 掉，不产生假漂移告警", () => {
  // 不 trim 的话「 圆号 」会落「其他」+ sectionRaw，把一个正常结果误报成词表漂移
  for (const raw of [" 圆号 ", "\t圆号", "圆号\n", "　圆号　"]) {
    const r = normalizeSection(raw);
    eq(r.section, "圆号", `「${JSON.stringify(raw)}」`);
    eq(r.sectionRaw, undefined, `「${JSON.stringify(raw)}」不该带 sectionRaw`);
  }
});

Deno.test("乐器名含路径穿越/控制字符时弃权（旧前端拿它当目录名）", () => {
  // 注：纯标点（如 ".."）会更早地被 isNonAnswer 判为「归一化后为空」而弃权，
  // 落到 non-answer 而非这里 —— 结论一样（都弃权），只是原因不同。
  for (const name of ["../../etc/passwd", "长笛\u0000", "a\u001Fb", "x/../../y"]) {
    const r = buildAnalysis(
      { section: "其他", instrument: name, evidence: "Campanelli e Silofono" },
      SOURCE,
    );
    eq(r.instrument, "", `「${JSON.stringify(name)}」应弃权`);
    eq(r.abstainReason, "instrument-illegal-chars", `「${JSON.stringify(name)}」原因`);
  }
  // 合称里的 `/` 是 #12 允许的写法，只多一层目录，不拦
  const ok = buildAnalysis(
    { section: "打击乐", instrument: "木琴/钟琴", evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(ok.instrument, "木琴/钟琴", "合称应放行");
});

Deno.test("小提琴：模型给不出号时，序号由声部推导兜底", () => {
  // 兜底路径：模型给 []，或给了非法写法（罗马/中文数字 → 解析成 []）。
  // ⚠️ 这条兜底今天是「文件名自解释」的优化，不再是承重结构：
  // 存储键早已是 {scoreId}/{行 id}.pdf（uuid），文件名怎么算都撞不上。
  for (const [section, want] of [["第一小提琴", [1]], ["第二小提琴", [2]]] as const) {
    for (const given of [[], "II", "二"]) {
      const r = buildAnalysis(
        { section, instrument: "小提琴", subParts: given, evidence: "Violino" },
        "Violino",
      );
      eq(r.subParts, want, `${section} + 模型给 ${JSON.stringify(given)}`);
    }
  }
});

Deno.test("小提琴：模型给了合法号就**采信模型**，不被声部推导压掉", () => {
  // 一份 `Violin_1,_2.pdf`（IMSLP 真实存在，与 `Horn_1,_2,_3,_4.pdf` 同类）模型给 [1,2]。
  // 数组化之前这里是「声部推导**覆盖**模型」，会把 [1,2] 压成 [1] —— 正是本 issue 要消灭的
  // 那类错（把「含 1、2」记成「只有 1」），而且比模型犯错更隐蔽：用户永远看不到模型给了什么。
  for (const [section, given, want] of [
    ["第一小提琴", [1, 2], [1, 2]],
    ["第二小提琴", [1, 2], [1, 2]],
    ["第一小提琴", [1], [1]],
    ["第一小提琴", "1,2", [1, 2]],
    ["第二小提琴", "2,1", [1, 2]],
    // 冲突情形：section 暗示 2、模型明确给 1 —— 采信明确给的那个。
    // 两个值出自同一次输出，这里没有依据判谁对；而改成 [2] 会把「模型读到了 1」抹掉。
    ["第二小提琴", [1], [1]],
  ] as const) {
    const r = buildAnalysis(
      { section, instrument: "小提琴", subParts: given, evidence: "Violino" },
      "Violino",
    );
    eq(r.subParts, want, `${section} + 模型给 ${JSON.stringify(given)}`);
  }
});

Deno.test("小提琴：声部落闭集外且没有分声部号时宁可弃权", () => {
  // 这是第二轮审查打出来的洞：`VIOLIN_SUB_PART` 按 section 取值，section 一旦
  // 不守词表（`Violin I` / `小提琴`）就没有依据了，只能靠模型给的分声部号。
  // 两支小提琴的 instrument 名相同，序号一缺就分辨不出来 —— 宁可不识别让用户手填。
  // 必须同时覆盖**闭集内**的声部：`sectionRaw` 只在闭集外才出现，而「其他」是
  // 闭集内的合法值、又正是 prompt 规则 3 指定的退路 —— 只测闭集外会把最常见的那条
  // 路漏掉（第三轮对抗就是这样打穿的）。
  for (const rawSection of [
    "Violin I", "小提琴", "弦乐", "Violini", // 闭集外
    "其他", "中提琴", "大提琴", "打击乐", "键盘", // 闭集内
  ]) {
    const r = buildAnalysis(
      { section: rawSection, instrument: "小提琴", subParts: [], evidence: "Violino" },
      "Violino",
    );
    eq(r.instrument, "", `声部「${rawSection}」应弃权`);
    eq(r.abstainReason, "ambiguous-violin", `声部「${rawSection}」原因`);
  }
  // 外文与全角写法也要被认出来 —— 匹配前过了 normalizeForMatch，
  // 所以全角/大小写/标点都归到同一形式；重音字母 NFKC 不折叠，单独列出。
  for (const name of ["Violin", "Ｖｉｏｌｉｎ", "violín", "VIOLON", "Скрипка", "violino"]) {
    const r = buildAnalysis(
      { section: "其他", instrument: name, subParts: [], evidence: "Violino" },
      "Violino",
    );
    eq(r.instrument, "", `instrument=${name} 也应弃权`);
    eq(r.abstainReason, "ambiguous-violin", `instrument=${name} 原因`);
  }
  // 反向：这些**不该**被认成小提琴（否则会误伤）
  for (const name of ["中提琴", "大提琴", "低音提琴", "Viola", "Violoncello", "大管"]) {
    const r = buildAnalysis(
      { section: "弦乐", instrument: name, subParts: [], evidence: "Allegretto" },
      SOURCE,
    );
    eq(r.instrument, name, `「${name}」不该被小提琴兜底误伤`);
  }
});

Deno.test("小提琴兜底：声部落闭集外但模型给了**合法**分声部号时不弃权", () => {
  // prompt 已要求小提琴照给分声部号；给了合法的就不必弃权。
  for (const [given, want] of [[[1], [1]], [[2], [2]], ["1", [1]]] as const) {
    const r = buildAnalysis(
      { section: "Violin I", instrument: "小提琴", subParts: given, evidence: "Violino" },
      "Violino",
    );
    eq(r.instrument, "小提琴", `subParts=${JSON.stringify(given)} 不该弃权`);
    eq(r.subParts, want, `subParts=${JSON.stringify(given)}`);
  }
  // ⚠️ 契约收紧后**罗马数字不再算数**：这一条以前是放行的（`"II"` → 2），
  // 现在唯一合法格式是阿拉伯数字，所以它落进「没有分声部号」那一支，应当弃权。
  const roman = buildAnalysis(
    { section: "Violin I", instrument: "小提琴", subParts: "II", evidence: "Violino" },
    "Violino",
  );
  eq(roman.instrument, "", "罗马数字不再被接受");
  eq(roman.abstainReason, "ambiguous-violin", "原因");
});

Deno.test("小提琴兜底不误伤中提琴/大提琴/低音提琴", () => {
  // 判据是「乐器名里含『小提琴』」—— 这三个都不含，即使声部落闭集外也不该弃权。
  for (const name of ["中提琴", "大提琴", "低音提琴"]) {
    const r = buildAnalysis(
      { section: "弦乐", instrument: name, subParts: [], evidence: "Allegretto" },
      SOURCE,
    );
    eq(r.instrument, name, `「${name}」被误伤`);
  }
});

Deno.test("乐器名过长时弃权（旧前端拿它当存储路径的目录名）", () => {
  const r = buildAnalysis(
    { section: "其他", instrument: "木".repeat(65), evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(r.instrument, "", "超长应弃权");
  eq(r.abstainReason, "instrument-too-long", "原因");
  // 边界：正好 64 字放行
  const ok = buildAnalysis(
    { section: "其他", instrument: "木".repeat(64), evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(ok.instrument.length, 64, "64 字应放行");
});

Deno.test("其他 14 个声部不被小提琴规则误伤", () => {
  const others = SECTIONS.filter((s) => s !== "第一小提琴" && s !== "第二小提琴");
  for (const section of others) {
    const r = buildAnalysis(
      { section, instrument: "某乐器", subParts: [1], evidence: "Allegretto" },
      SOURCE,
    );
    eq(r.section, section, `${section} 的 section 不该被改写`);
    eq(r.subParts, [1], `${section} 的分声部号应保留`);
  }
});

Deno.test("parseSubParts：唯一合法格式是英文逗号分隔的阿拉伯数字", () => {
  eq(parseSubParts(3), [3], "number");
  eq(parseSubParts("3"), [3], "单个");
  eq(parseSubParts("1,2"), [1, 2], "两个");
  eq(parseSubParts("1,2,3,4"), [1, 2, 3, 4], "一份覆盖四个分声部（Horn_1,2,3,4）");
  eq(parseSubParts("8"), [8], "无上限");
  eq(parseSubParts([2]), [2], "JSON 数组 —— 模型可能把标量写成数组，两种都接");
  eq(parseSubParts([2, 1]), [1, 2], "数组也升序");
});

Deno.test("parseSubParts：升序去重", () => {
  eq(parseSubParts("3,1,2"), [1, 2, 3], "乱序");
  eq(parseSubParts("1,1,2"), [1, 2], "重复");
  eq(parseSubParts("2,2"), [2], "全重复");
});

Deno.test("parseSubParts：只收敛**符号写法**，不猜语义", () => {
  // 下面这些是同一个符号的不同写法 —— 收敛它们是编码归一化，不是猜
  eq(parseSubParts("２"), [2], "全角数字（NFKC）");
  eq(parseSubParts("１，２"), [1, 2], "全角逗号");
  eq(parseSubParts("1、2"), [1, 2], "顿号（中文语境下的常见写法）");
  eq(parseSubParts(" 1 , 2 "), [1, 2], "空白");
  eq(parseSubParts("1,2,"), [1, 2], "尾随逗号是格式噪声，不该让整串弃权");
  // 下面这些**不是写法问题，是语义问题** —— 替模型决定就是猜，一律弃权
  eq(parseSubParts("1-3"), [], "区间：是 1,2,3 还是「第 1 和第 3」？");
  eq(parseSubParts("II"), [], "罗马数字");
  eq(parseSubParts("iii"), [], "罗马小写");
  eq(parseSubParts("三"), [], "中文数字");
});

Deno.test("parseSubParts：**任一非空片段非法就整个弃权**，不做部分解析", () => {
  // 部分解析比不解析更危险：`1,2,3支` 若丢掉 `3支` 会得到 [1,2] ——
  // 一个**看起来对**的错答案，会一路写进文件名；而弃权只是让用户手填一次。
  eq(parseSubParts("1,2,3支"), [], "带中文后缀");
  eq(parseSubParts("1,2,x"), [], "混入非数字");
  eq(parseSubParts("1.5"), [], "小数");
  eq(parseSubParts("0x2"), [], "十六进制写法");
  eq(parseSubParts("+2"), [], "带正号");
  eq(parseSubParts("2 支"), [], "带后缀");
});

Deno.test("parseSubParts：空与非法输入一律弃权", () => {
  eq(parseSubParts(null), [], "null");
  eq(parseSubParts(undefined), [], "undefined");
  eq(parseSubParts(""), [], "空串");
  eq(parseSubParts("null"), [], "字面量 null");
  eq(parseSubParts(0), [], "0 不是分声部号");
  eq(parseSubParts(-1), [], "负数");
  eq(parseSubParts(1.5), [], "非整数 number");
  eq(parseSubParts(Infinity), [], "Infinity");
  eq(parseSubParts(NaN), [], "NaN");
  // 溢出：Number("999…") 是 Infinity，它在进程内是 number、在 JSON 里变成 null
  eq(parseSubParts("9".repeat(400)), [], "超长数字串");
  eq(parseSubParts({}), [], "对象");
  eq(parseSubParts(true), [], "布尔");
  eq(parseSubParts([]), [], "空数组");
});

Deno.test("parseSubParts：个数上界看**去重后**的个数，且与形态无关", () => {
  // 号会进 file_name（`圆号_1,2,3.pdf`），而下载时那个名字要落到用户的文件系统上，
  // 所以上界看的是**最终落进文件名的个数**（= 去重后）。
  // 边界从常量推出来，不写死数字：本用例守的是「**边界正好在 MAX_SUB_PARTS 上**」
  // 这条规则，而不是「那个数字必须是 32」。写死的话改常量时这条用例要么假红、
  // 要么（更糟）常量改了它却照过，变成一条名字与行为不符的保护。
  const atLimit = Array.from({ length: MAX_SUB_PARTS }, (_, i) => i + 1);
  eq(parseSubParts(atLimit).length, MAX_SUB_PARTS, "正好到上界应放行");
  eq(parseSubParts(atLimit.join(",")).length, MAX_SUB_PARTS, "字符串形态同样放行");
  const over = Array.from({ length: MAX_SUB_PARTS + 1 }, (_, i) => i + 1);
  eq(parseSubParts(over), [], "超上界一个就弃权");
  eq(parseSubParts(over.join(",")), [], "字符串形态同样超上界");

  // ⚠️ 判据必须**形态无关**。早先有一句按 `parts.length` 的预检，它只挡数组形态，
  // 于是 `Array(33).fill(1)` 弃权、而 `"1,1,…(33 个)"` 放行 —— 同一语义两种结论。
  // 想验证下面这几条断言真的在守这件事：把 `parts.length > MAX_SUB_PARTS` 那句预检
  // 加回 `parseSubParts` 开头，看它们是否变红（红的才是有效的）。
  const dupArray = Array(MAX_SUB_PARTS + 1).fill(1);
  eq(parseSubParts(dupArray), [1], "超上界的元素数但只有 1 个不同的号 —— 落进文件名的是 1 个");
  eq(parseSubParts(dupArray.join(",")), [1], "同语义的字符串形态结论必须一致");
});

Deno.test("parseSubParts：空片段在两种形态下结论一致（补位写法不该整串弃权）", () => {
  // `[1,""]` / `["",1]` 是模型补位时很自然的写法，与 `"1,"` / `",1"` 是**同一件事**：
  // 空片段只是格式噪声。只在字符串分支豁免它，同一语义就会在两种形态下得到相反结论
  // —— 又一处「与形态相关」，与上面那条上界测试防的是同一类东西。
  eq(parseSubParts([1, ""]), [1], "数组里的空串是噪声，不该让整串弃权");
  eq(parseSubParts(["", 1]), [1], "位置无关");
  eq(parseSubParts([1, "  "]), [1], "只有空白的元素同理");
  eq(parseSubParts("1,"), [1], "字符串形态（对照）");
  eq(parseSubParts(",1"), [1], "字符串形态（对照）");

  // 全是噪声 = 什么都没给 —— 两种形态同样要一致
  eq(parseSubParts([""]), [], "只有一个空串");
  eq(parseSubParts(["", ""]), [], "两个空串");
  eq(parseSubParts(","), [], "只有一个逗号");
});

Deno.test("parseSubParts：NFKC 收敛的范围比「全角」宽 —— 契约文字要与实现一致", () => {
  // 带圈数字有 <circle> 0031 兼容分解，上标/数学字母同理，NFKC 都会折成阿拉伯数字。
  // 这是 NFKC 的既定行为（旧版单值实现同理），不是这里加的特例 —— 但注释得说实话。
  eq(parseSubParts("①,②"), [1, 2], "带圈数字");
  eq(parseSubParts("²"), [2], "上标");
  eq(parseSubParts("𝟏,𝟐"), [1, 2], "数学字母");
  // 折不出合法 token 的一律弃权
  eq(parseSubParts("⑵"), [], "带括号数字（折成 `(2)`）");
  eq(parseSubParts("½"), [], "分数");
  eq(parseSubParts("Ⅰ,Ⅱ"), [], "罗马数字 U+2160（折成 I/II —— 是折了，只是折出来不是数字）");
});

Deno.test("parseSubParts：原型链上的键不是分声部号", () => {
  // 「对象字面量 + 不可信字符串索引」的经典坑：ROMAN["constructor"] 取到的是
  // Object 构造函数，而真值判断会让它一路流出去。现在改用正则而不是查表，
  // 这条路已经堵死 —— 但输入仍不可信，留着当回归网。
  for (const key of [
    "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__",
    "isPrototypeOf", "propertyIsEnumerable",
  ]) {
    eq(parseSubParts(key), [], `「${key}」`);
  }
});

Deno.test("source 类型不对：走弃权而不是抛异常", () => {
  // 请求体 {"text": 42} 会让 source 不是字符串。
  // 必须与「模型在编」区分开，否则 abstainReason 说谎。
  for (const bad of [42, null, undefined, {}, [], true]) {
    const r = buildAnalysis({ section: "圆号", instrument: "圆号", evidence: "Corno" }, bad);
    eq(r.abstainReason, "bad-source", `source=${JSON.stringify(bad)}`);
    eq(r.instrument, "", "instrument");
  }
});

Deno.test("非法输入不抛异常，一律走弃权", () => {
  for (const input of [null, undefined, 42, "字符串", [], {}, { instrument: 123 }]) {
    const r = buildAnalysis(input, SOURCE);
    eq(r.instrument, "", `parsed=${JSON.stringify(input)}`);
    eq(r.section, "其他", "section");
  }
});

Deno.test("subPartsRaw：给了号却没解析出来时必须**看得见**；说「没有」时不出现", () => {
  const run = (subParts: unknown) =>
    buildAnalysis({ section: "圆号", instrument: "F调圆号", subParts, evidence: "Horn_1-4" }, "Horn_1-4");

  // 给了但没读懂 —— 用户**需要手填**，所以必须带信号
  for (const given of ["1-4", "[1,2]", "1,2,3支", Array.from({ length: 33 }, (_, i) => i + 1)]) {
    const r = run(given);
    eq(typeof r.subPartsRaw, "string", `${JSON.stringify(given)} 应带上原文`);
    eq(r.instrument, "F调圆号", "乐器名识别对了，不该连坐走弃权");
  }
  eq(run("1-4").subPartsRaw, "1-4", "原文要原样带出来，界面才能提示用户填什么");

  // 模型说「没有」的各种写法 —— 不该挂告警：否则每条正常返回都带一条，那条信号立刻失去意义
  for (const given of [[], "", "null", null, undefined]) {
    eq(run(given).subPartsRaw, undefined, `${JSON.stringify(given)} 不该带 subPartsRaw`);
    eq(run(given).subParts, [], `${JSON.stringify(given)} 的号就是空数组`);
  }
  // 解析成功时当然也不带
  eq(run("1,2").subPartsRaw, undefined, "读懂了的字符串不该再挂原文告警");
  eq(run("1,2").subParts, [1, 2], "逗号串要拆成数组");
});

Deno.test("subPartsRaw：「没有」的判据是黑名单 —— 用词说没有的不报警，怪形态一律报警", () => {
  const run = (subParts: unknown) =>
    buildAnalysis({ section: "圆号", instrument: "F调圆号", subParts, evidence: "Horn_1-4" }, "Horn_1-4");

  // 模型用词表达「没有」的常见写法 —— 挂告警就等于每条正常返回都带一条，信号立刻失去意义。
  // 这些词直接复用 isNonAnswer 的词表（同为「模型在说答不出来」）。
  for (const given of ["无", "none", "unknown", "N/A", "null", "NULL", "未识别", "[]"]) {
    eq(run(given).subPartsRaw, undefined, `${given} 是在说「没有」，不该报警`);
  }

  // 反过来：非「没有」的怪形态**必须报警**。白名单式判据在这里会把它们当成
  // 「模型说没有」而静默丢弃 —— 号丢了且没有任何信号，正是本字段要消灭的失败模式。
  // `true` / `{}` 在 response_format: json_object 下完全可达。
  for (const given of [true, {}, { "1": 1 }, ["x"]]) {
    const r = run(given);
    eq(typeof r.subPartsRaw, "string", `${JSON.stringify(given)} 是怪形态，必须报警而不是静默`);
  }
});

Deno.test("subPartsRaw 的原文：非有限数与截断都有确定行为", () => {
  const raw = (subParts: unknown) =>
    buildAnalysis({ section: "圆号", instrument: "F调圆号", subParts, evidence: "Horn_1-4" }, "Horn_1-4")
      .subPartsRaw;

  // Infinity 不能变成字面量 "null" —— 那正是本模块规定的「模型说没有」写法，
  // 会造出一句「给了 null 却读不懂，请手填」的自相矛盾提示。
  eq(raw(Infinity), "Infinity", "非有限数要如实显示，不能借用 null 的字面量");
  eq(raw(NaN), "NaN", "NaN 同理");

  // 原文要 trim：界面是拿它提示用户「你填的是这个」，带空白只会让人困惑
  eq(raw("  1-4  "), "1-4", "首尾空白要去掉");

  // 截断按**码点**：`slice(0,60)` 数的是 UTF-16 码元，会在 emoji 中间劈开代理对，
  // 留下一个孤立的高位代理（显示成 �）。
  const withEmoji = "a".repeat(59) + "😀" + "b".repeat(5);
  const cut = raw(withEmoji) as string;
  eq([...cut].length, 61, "60 个码点 + 省略号");
  eq(cut.includes("😀"), true, "emoji 不能被劈成半个");
  // 孤立代理的自检：任何高位代理后面必须紧跟低位代理
  eq(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false, "不能留下孤立的高位代理");

  // 边界：正好 60 个码点不截断
  eq(raw("a".repeat(60))?.endsWith("…"), false, "60 个码点不截断");
  eq(raw("a".repeat(61))?.endsWith("…"), true, "61 个码点要截断");
});

Deno.test("不变量：section 恒在闭集内、subParts 恒为**升序去重的正整数**数组、instrument 恒为字符串", () => {
  const sections = [...SECTIONS, "其他", "木管", "", 42 as unknown as string];
  for (const section of sections) {
    for (const instrument of ["木琴", "", "unknown", 42]) {
      for (const raw of [null, 1, "II", 0, [2], Infinity, "1,2", "3,1", "1,1", "1,2,3支"]) {
        const r = buildAnalysis({ section, instrument, subParts: raw, evidence: "Allegretto" }, SOURCE);
        if (![...SECTIONS, "其他"].includes(r.section)) {
          throw new Error(`section 越界: ${JSON.stringify(r.section)}`);
        }
        if (!Array.isArray(r.subParts)) {
          throw new Error(`subParts 不是数组: ${JSON.stringify(r.subParts)}`);
        }
        // 只判 typeof 不够：Infinity / NaN 也是 number，而它们经 JSON 会变成 null，
        // 同一次调用在进程内与线上是两个值。
        for (const n of r.subParts) {
          if (!Number.isSafeInteger(n) || n <= 0) {
            throw new Error(`subParts 含非正安全整数: ${String(n)}`);
          }
        }
        // 升序 + 去重是**契约的一部分**：详情页的排序直接按 subParts[0] 比较，
        // 不保证的话同一批数据每次显示的顺序都可能不同。
        if (JSON.stringify(r.subParts) !== JSON.stringify([...r.subParts].sort((a, b) => a - b))) {
          throw new Error(`subParts 未升序: ${JSON.stringify(r.subParts)}`);
        }
        if (new Set(r.subParts).size !== r.subParts.length) {
          throw new Error(`subParts 有重复: ${JSON.stringify(r.subParts)}`);
        }
        if (typeof r.instrument !== "string") {
          throw new Error(`instrument 类型错: ${JSON.stringify(r.instrument)}`);
        }
      }
    }
  }
});

Deno.test("原型污染：__proto__ 不会变成 instrument", () => {
  const r = buildAnalysis(
    JSON.parse('{"__proto__":{"instrument":"木琴","evidence":"Campanelli"},"section":"打击乐"}'),
    SOURCE,
  );
  eq(r.instrument, "", "不该从 __proto__ 取值");
  eq(({} as Record<string, unknown>).instrument, undefined, "Object.prototype 被污染");
});

Deno.test("abstain 形态符合契约", () => {
  eq(abstain("x"), {
    section: "其他",
    instrument: "",
    subParts: [],
    evidence: "",
    // 总谱标记是**契约的一部分**（前端按它写 `sectionEdit = 总谱`），所以弃权形态里
    // 也必须显式为 false —— 这个「逐字比整个形状」的用例正是为了逼出这类静默新增
    isFullScore: false,
    abstainReason: "x",
  }, "弃权形态");
});

// —— 总谱（pkuso-web#297）——
// 这一组里最要紧的是**顺序**：`isFullScore` 必须在「空乐器 → 弃权」之前判，
// 否则模型的正确回答会被当成「答不出来」丢掉，总谱永远判不出来。

Deno.test("总谱：isFullScore=true + 没有单一乐器 → 判总谱，而不是弃权", () => {
  const a = buildAnalysis(
    {
      isFullScore: true,
      instrument: "总谱",
      section: "其他",
      evidence: "Flauto, Oboe, Clarinetto, Corno",
    },
    "Flauto, Oboe, Clarinetto, Corno",
  );
  eq(a.isFullScore, true, "判成总谱");
  eq(a.section, "总谱", "声部写成总谱");
  eq(a.instrument, "总谱", "乐器名给总谱");
  eq(a.subParts, [], "总谱没有分声部号");
  eq(a.abstainReason, undefined, "不是弃权");
});

Deno.test("总谱也要有证据：引不出原文就弃权（不许靠猜）", () => {
  const a = buildAnalysis(
    { isFullScore: true, instrument: "总谱", evidence: "这一页有好多乐器" },
    "Flauto, Oboe",
  );
  eq(a.isFullScore, false, "弃权形态");
  eq(a.instrument, "", "没有乐器");
  eq(a.abstainReason, "evidence-not-in-source", "证据不在原文里");
});

Deno.test("只有恰好 true 才算总谱：字符串/数字/缺字段一律按分谱走", () => {
  for (const bad of ["true", 1, undefined, null]) {
    const a = buildAnalysis(
      { instrument: "圆号", section: "圆号", evidence: "Corno", isFullScore: bad },
      "Corno",
    );
    eq(a.isFullScore, false, `坏值 ${JSON.stringify(bad)} 不该判成总谱`);
    eq(a.instrument, "圆号", "乐器名不受影响");
    eq(a.section, "圆号", "声部不受影响");
  }
});

Deno.test("分谱一字不变：isFullScore=false 时结果与没有这个字段一模一样", () => {
  const withField = buildAnalysis(
    { instrument: "圆号", section: "圆号", evidence: "Corno", isFullScore: false },
    "Corno",
  );
  const without = buildAnalysis({ instrument: "圆号", section: "圆号", evidence: "Corno" }, "Corno");
  eq(withField, without, "分谱路径一字不变");
});

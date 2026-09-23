import {
  abstain,
  buildAnalysis,
  evidenceSupports,
  normalizeForMatch,
  normalizeSection,
  parseSubPart,
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
    { section: "打击乐", instrument: "木琴", subPart: null, evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(r.section, "打击乐", "section");
  eq(r.instrument, "木琴", "instrument");
  eq(r.subPart, null, "subPart");
  eq(r.abstainReason, undefined, "不应弃权");
});

Deno.test("弃权：乐器名为空串", () => {
  const r = buildAnalysis(
    { section: "其他", instrument: "", subPart: null, evidence: "" },
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
  // 「小提琴」单独测：它在「其他 + 无 subPart」下**应当**被 ambiguous-violin 兜底
  // 拦下（那正是两支会撞成同一路径的情形），所以要给一个正常的声部与序号。
  const v = buildAnalysis(
    { section: "中提琴", instrument: "小提琴", subPart: 1, evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(v.instrument, "小提琴", "有声部序号时不该被误杀");
  eq(v.subPart, 1, "subPart");
});

Deno.test("弃权：没有 evidence", () => {
  const r = buildAnalysis({ section: "圆号", instrument: "圆号", subPart: 2 }, SOURCE);
  eq(r.instrument, "", "instrument");
  eq(r.abstainReason, "no-evidence", "原因");
});

Deno.test("弃权：evidence 不在原文里（模型在编）", () => {
  const r = buildAnalysis(
    { section: "大管", instrument: "大管", subPart: 1, evidence: "Fagotto I" },
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
    { section: "木管", instrument: "长笛", subPart: 1, evidence: "Flute 1" },
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

Deno.test("小提琴：subPart 由声部推导成 1/2，且不依赖模型输出", () => {
  // 承重结构：旧前端（#283 之前）只在 instrument === "Violin" 时才拼声部名，
  // 新契约不再返回 "Violin"，两支小提琴会算成同一个路径，
  // 而上传是 upsert —— 后传的会静默覆盖先传的。推导出 1/2 才能错开。
  for (const [section, want] of [["第一小提琴", 1], ["第二小提琴", 2]] as const) {
    for (const given of [null, 1, 2, 3, "II", "二"]) {
      const r = buildAnalysis(
        { section, instrument: "小提琴", subPart: given, evidence: "Violino" },
        "Violino",
      );
      eq(r.subPart, want, `${section} + 模型给 ${JSON.stringify(given)}`);
    }
  }
});

Deno.test("小提琴：声部落闭集外且没有 subPart 时宁可弃权，也不能让两支撞成同一路径", () => {
  // 这是第二轮审查打出来的洞：`VIOLIN_SUB_PART` 按 section 取值，section 一旦
  // 不守词表（`Violin I` / `小提琴`）就没有依据了，只能靠模型给的 subPart。
  // 两支小提琴的 instrument 名相同 —— 序号一缺，旧前端算出的是同一条
  // {scoreId}/小提琴/小提琴.pdf，upsert 会静默覆盖掉一份分谱。
  // 必须同时覆盖**闭集内**的声部：`sectionRaw` 只在闭集外才出现，而「其他」是
  // 闭集内的合法值、又正是 prompt 规则 3 指定的退路 —— 只测闭集外会把最常见的那条
  // 路漏掉（第三轮对抗就是这样打穿的）。
  for (const rawSection of [
    "Violin I", "小提琴", "弦乐", "Violini",     // 闭集外
    "其他", "中提琴", "大提琴", "打击乐", "键盘", // 闭集内
  ]) {
    const r = buildAnalysis(
      { section: rawSection, instrument: "小提琴", subPart: null, evidence: "Violino" },
      "Violino",
    );
    eq(r.instrument, "", `声部「${rawSection}」应弃权`);
    eq(r.abstainReason, "ambiguous-violin", `声部「${rawSection}」原因`);
  }
  // 外文与全角写法也要被认出来 —— 匹配前过了 normalizeForMatch，
  // 所以全角/大小写/标点都归到同一形式；重音字母 NFKC 不折叠，单独列出。
  for (const name of ["Violin", "Ｖｉｏｌｉｎ", "violín", "VIOLON", "Скрипка", "violino"]) {
    const r = buildAnalysis(
      { section: "其他", instrument: name, subPart: null, evidence: "Violino" },
      "Violino",
    );
    eq(r.instrument, "", `instrument=${name} 也应弃权`);
    eq(r.abstainReason, "ambiguous-violin", `instrument=${name} 原因`);
  }
  // 反向：这些**不该**被认成小提琴（否则会误伤）
  for (const name of ["中提琴", "大提琴", "低音提琴", "Viola", "Violoncello", "大管"]) {
    const r = buildAnalysis(
      { section: "弦乐", instrument: name, subPart: null, evidence: "Allegretto" },
      SOURCE,
    );
    eq(r.instrument, name, `「${name}」不该被小提琴兜底误伤`);
  }
});

Deno.test("小提琴兜底：声部落闭集外但模型给了 subPart 时不弃权（路径能错开）", () => {
  // prompt 已要求小提琴照给 subPart；给了就不必弃权。
  for (const [given, want] of [[1, 1], [2, 2], ["II", 2]] as const) {
    const r = buildAnalysis(
      { section: "Violin I", instrument: "小提琴", subPart: given, evidence: "Violino" },
      "Violino",
    );
    eq(r.instrument, "小提琴", `subPart=${given} 不该弃权`);
    eq(r.subPart, want, `subPart=${given}`);
  }
});

Deno.test("小提琴兜底不误伤中提琴/大提琴/低音提琴", () => {
  // 判据是「乐器名里含『小提琴』」—— 这三个都不含，即使声部落闭集外也不该弃权。
  for (const name of ["中提琴", "大提琴", "低音提琴"]) {
    const r = buildAnalysis(
      { section: "弦乐", instrument: name, subPart: null, evidence: "Allegretto" },
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
      { section, instrument: "某乐器", subPart: 1, evidence: "Allegretto" },
      SOURCE,
    );
    eq(r.section, section, `${section} 的 section 不该被改写`);
    eq(r.subPart, 1, `${section} 的 subPart 应保留`);
  }
});

Deno.test("parseSubPart：阿拉伯/罗马/中文/无", () => {
  eq(parseSubPart(3), 3, "number");
  eq(parseSubPart("3"), 3, "阿拉伯");
  eq(parseSubPart("III"), 3, "罗马大写");
  eq(parseSubPart("iii"), 3, "罗马小写");
  eq(parseSubPart("三"), 3, "中文");
  eq(parseSubPart("8"), 8, "无上限");
  eq(parseSubPart("null"), null, "字面量 null");
  eq(parseSubPart(""), null, "空串");
  eq(parseSubPart(null), null, "null");
  eq(parseSubPart(0), null, "0");
  eq(parseSubPart(-1), null, "负数");
});

Deno.test("parseSubPart：原型链上的键不是分声部号", () => {
  // 「对象字面量 + 不可信字符串索引」的经典坑：ROMAN["constructor"] 取到的是
  // Object 构造函数，而 `if (roman)` 是真值判断 —— subPart 会变成一个函数，
  // 违反「恒为 number|null」。改用 Map 之后不存在的键一律 undefined。
  for (const key of [
    "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__",
    "isPrototypeOf", "propertyIsEnumerable",
  ]) {
    eq(parseSubPart(key), null, `「${key}」`);
  }
});

Deno.test("parseSubPart：不做 String() 强转（数组不是数字）", () => {
  // String([2]) === "2"、String(["ii"]) === "ii" —— 强转会把数组当分声部号
  eq(parseSubPart([2]), null, "数组 [2]");
  eq(parseSubPart(["2"]), null, "数组 ['2']");
  eq(parseSubPart(["ii"]), null, "数组 ['ii']");
  eq(parseSubPart([]), null, "空数组");
  eq(parseSubPart({}), null, "对象");
  eq(parseSubPart(true), null, "布尔");
});

Deno.test("parseSubPart：噪声与溢出不产生假阳性", () => {
  eq(parseSubPart("2 支"), null, "带后缀");
  eq(parseSubPart("2支"), null, "带中文后缀");
  eq(parseSubPart("1.5"), null, "小数");
  eq(parseSubPart("0x2"), null, "十六进制写法");
  eq(parseSubPart("+2"), null, "带正号");
  // 兼容形式（NFKC 折叠）：OCR 常出全角数字，模型也可能回 Ⅱ(U+2161)/⑧。
  // 不折叠的话 `长笛_2` 会退化成 `长笛`，与另一支长笛撞成同一条路径。
  eq(parseSubPart("２"), 2, "全角数字");
  eq(parseSubPart("Ⅱ"), 2, "罗马数字兼容形式 U+2161");
  eq(parseSubPart("⑧"), 8, "带圈数字");
  // 溢出：parseInt 会给出 Infinity，它在进程内是 number、在 JSON 里变成 null
  eq(parseSubPart("9".repeat(400)), null, "超长数字串");
  eq(parseSubPart(Infinity), null, "Infinity");
  eq(parseSubPart(NaN), null, "NaN");
  eq(parseSubPart(1.5), null, "非整数 number");
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

Deno.test("不变量：section 恒在闭集内、subPart 恒为 number|null、instrument 恒为字符串", () => {
  const sections = [...SECTIONS, "其他", "木管", "", 42 as unknown as string];
  for (const section of sections) {
    for (const instrument of ["木琴", "", "unknown", 42]) {
      for (const subPart of [null, 1, "II", 0, [2], Infinity]) {
        const r = buildAnalysis({ section, instrument, subPart, evidence: "Allegretto" }, SOURCE);
        if (![...SECTIONS, "其他"].includes(r.section)) {
          throw new Error(`section 越界: ${JSON.stringify(r.section)}`);
        }
        if (r.subPart !== null && typeof r.subPart !== "number") {
          throw new Error(`subPart 类型错: ${JSON.stringify(r.subPart)}`);
        }
        // 只判 typeof 不够：Infinity / NaN 也是 number，而它们经 JSON 会变成 null，
        // 同一次调用在进程内与线上是两个值。
        if (r.subPart !== null && !Number.isSafeInteger(r.subPart)) {
          throw new Error(`subPart 不是安全整数: ${String(r.subPart)}`);
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
    subPart: null,
    evidence: "",
    abstainReason: "x",
  }, "弃权形态");
});

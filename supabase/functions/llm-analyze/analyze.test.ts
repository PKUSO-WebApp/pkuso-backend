import {
  abstain,
  buildAnalysis,
  evidenceSupports,
  MAX_EXTRA_SECTIONS,
  MAX_SUB_PARTS,
  normalizeForMatch,
  normalizeSection,
  parseExtraSections,
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

Deno.test("真实乐器名一律原样采用（现在没有任何词表会拦它）", () => {
  // 这条原先钉的是「非答案黑名单别误杀真名」。黑名单已随词表一起删掉（2026-09-25，
  // 用户定：词表不能作为分析的直接手段），但**这组输入仍然值得留着** ——
  // 它现在钉的是「模型说什么就是什么」：只要不是空串，乐器名原样落库。
  // ⚠️ 别因为它「没有对应实现了」就删掉：它是「不再有任何东西判断乐器名」的正面证据。
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
  // 「小提琴」单独测：给它一个**正常的声部与序号** —— 这样它走的是「答案原样采用」
  // 那条路。（旧版这里是为了避开一道 `ambiguous-violin` 弃权，那道弃权已删。）
  const v = buildAnalysis(
    { section: "中提琴", instrument: "小提琴", subParts: [1], evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(v.instrument, "小提琴", "有分声部号时不该被误杀");
  eq(v.subParts, [1], "分声部号");
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

Deno.test("中提琴/大提琴/低音提琴没有分声部号也照用", () => {
  // ⚠️ 这条用例原先叫「小提琴兜底不误伤…」，钉的是一条正则（`VIOLIN_LIKE`，已删）。
  // 现在代码**根本不看乐器名**，这三个名字通过是必然的 —— 它守的是另一件事：
  // 「没有号」不是弃权理由（旧版会因 `ambiguous-violin` 弃权，现在不会）。
  for (const name of ["中提琴", "大提琴", "低音提琴"]) {
    const r = buildAnalysis(
      { section: "弦乐", instrument: name, subParts: [], evidence: "Allegretto" },
      SOURCE,
    );
    eq(r.instrument, name, `「${name}」被误伤`);
  }
});

Deno.test("乐器名过长时弃权（它会写进 file_name 与 sheet_music_files.instrument）", () => {
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
  // `buildAnalysis` 是纯函数，`source` 的类型由调用方保证 —— 这里钉的是**万一不是字符串**
  // 时的分工：走弃权而不是抛。必须与「模型在编」区分开，否则 abstainReason 说谎。
  // （原文写的是「请求体 {"text": 42} 会让 source 不是字符串」，两处都不成立：那个请求在
  // handler 里就被 400 掉了，根本到不了这里；而 `text` 这个字段名也已经删掉。）
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
  for (const given of ["1-4", "[1,2]", "1,2,3支", Array.from({ length: MAX_SUB_PARTS + 1 }, (_, i) => i + 1)]) {
    const r = run(given);
    eq(typeof r.subPartsRaw, "string", `${JSON.stringify(given)} 应带上原文`);
    eq(r.instrument, "F调圆号", "乐器名识别对了，不该连坐走弃权");
  }
  eq(run("1-4").subPartsRaw, "1-4", "原文要原样带出来，界面才能提示用户填什么");

  // 「没有」的判据是**结构性**的（字段缺失 / null / 空数组 / 空串），不再认自然语言的
  // 「没有」说法。⚠️ 代价：模型用 `"null"` / `"无"` / `"none"` 作答时会挂一次告警 ——
  // 这是**有意**的（prompt 规则 8 要求的本来就是数组，那是它没照契约答），
  // 比加一张永远列不全的用词表更稳。`"null"` 因此挪到上面那组。
  for (const given of [[], "", null, undefined]) {
    eq(run(given).subPartsRaw, undefined, `${JSON.stringify(given)} 不该带 subPartsRaw`);
    eq(run(given).subParts, [], `${JSON.stringify(given)} 的号就是空数组`);
  }
  // 自然语言的「没有」会挂告警 —— 有意的取舍，别当成 bug「修」回词表
  eq(run("null").subPartsRaw, "null", "字面量 null 不是结构性空值，按「给了但没读懂」处理");
  eq(run("无").subPartsRaw, "无", "自然语言的「没有」同理");

  // 解析成功时当然也不带
  eq(run("1,2").subPartsRaw, undefined, "读懂了的字符串不该再挂原文告警");
  eq(run("1,2").subParts, [1, 2], "逗号串要拆成数组");
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

// —— 引文的来源（pkuso-web#300）——
// 「引文在页面上」「引文只在文件名里」「哪儿都没找到」是**三件不同的事**，
// 而分开之前它们都被算成「找到了」：抄文件名里的流水号也能让 `evidenceFound` 为真，
// 而那个字段是「让用户复核」的唯一依据（实测 36 次里 2 次是这种情形）。
Deno.test("引文来源三分：页面 / 只在文件名 / 都没找到", () => {
  const ocr = "CAMPANELLI E SILOFONO. Allegretto";
  const name = "PMLASIA01165-13-Horn_2.pdf";
  const mk = (evidence: string, fileName?: string) =>
    buildAnalysis({ section: "圆号", instrument: "圆号", subParts: [], evidence }, ocr, fileName);

  // ① 抄页面 —— 最强的依据
  eq(
    [mk("CAMPANELLI E SILOFONO", name).evidenceFound, mk("CAMPANELLI E SILOFONO", name).evidenceFromFileName],
    [true, false],
    "抄页面",
  );
  // ② 抄文件名 —— **正当**依据（出版社把乐器名印在文件名里，页面 OCR 可能是乱的）
  eq(
    [mk("Horn_2", name).evidenceFound, mk("Horn_2", name).evidenceFromFileName],
    [false, true],
    "抄文件名",
  );
  // ③ 抄文件名里的**流水号** —— 它确实在文件名里（后端只报事实，不判「支不支撑」），
  //    但它不是页面内容，所以 `evidenceFound` 必须是 false
  eq(
    [mk("PMLASIA01165-13", name).evidenceFound, mk("PMLASIA01165-13", name).evidenceFromFileName],
    [false, true],
    "流水号",
  );
  // ④ 哪儿都没有
  eq(
    [mk("Beethoven", name).evidenceFound, mk("Beethoven", name).evidenceFromFileName],
    [false, false],
    "都没找到",
  );
  // ⑤ 不给文件名（**段级调用**就是这样）→ 恒为 false，不会凭空报「来自文件名」
  eq(
    [mk("Horn_2").evidenceFound, mk("Horn_2").evidenceFromFileName],
    [false, false],
    "没传文件名",
  );
  // ⑥ 页面找得到时**不再**追问文件名（页面上找得到就是最强的那个依据）
  eq(
    [mk("CAMPANELLI", name).evidenceFound, mk("CAMPANELLI", name).evidenceFromFileName],
    [true, false],
    "页面找得到就不看文件名",
  );
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
    // 同样恒存在（不是可选字段）：调用方按「有几个声部要落库」用它，
    // 缺席与空数组在 `?? []` 之下不可区分，而恒存在就少一个分支。
    extraSections: [],
    // 引文能不能在原文里找到 —— 弃权时恒为 false（没有可核对的引文）
    evidenceFound: false,
    // 同样恒存在：引文「只在文件名里找到」是**另一种依据**（pkuso-web#300），
    // 前端据它换一句话显示。缺席与 false 在界面上不可区分，恒存在就少一个分支。
    evidenceFromFileName: false,
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
      // ⚠️ 下面那条 `evidenceFound === true` 是**唯一**钉住总谱分支这个字段的断言：
      // 把它改成恒 false / 恒 true，其余用例全绿（2026-09-25 合规审查实测）。
    },
    "Flauto, Oboe, Clarinetto, Corno",
  );
  eq(a.evidenceFound, true, "总谱分支的 evidenceFound 也要对：引文在原文里");
  // ⚠️ **两侧都要钉**：只钉 true 的话，把总谱分支写成恒 `true` 仍然全绿
  //（2026-09-25 第 14 轮合规复查实测），而那个字段正是删除证据弃权门的唯一补偿。
  const notFound = buildAnalysis(
    { isFullScore: true, instrument: "总谱", section: "其他", evidence: "原文里没有这句" },
    "Campanelli e Silofono",
  );
  eq(notFound.isFullScore, true, "总谱照判");
  eq(notFound.evidenceFound, false, "引文不在原文里 → false");
  eq(a.isFullScore, true, "判成总谱");
  eq(a.section, "总谱", "声部写成总谱");
  eq(a.instrument, "总谱", "乐器名给总谱");
  eq(a.subParts, [], "总谱没有分声部号");
  eq(a.abstainReason, undefined, "不是弃权");
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

Deno.test("总谱证据：**版标词算可靠证据** —— PARTITUR. 直接放行", () => {
  // 用户 2026-09-25 定的：**一般只有总谱会有封面**，所以封面/标题页上的版次标注
  // 是**可靠**的总谱信号。早期版本把这一族当「不算证据」挡掉，那是错的 ——
  // 代价是手上那份真总谱在默认配置下认不出来；而且它被挡之后 `segEligible` 变真，
  // 整份总谱真去跑分段就是按页数烧 OCR。
  const a = buildAnalysis(
    { isFullScore: true, instrument: "总谱", section: "其他", evidence: "PARTITUR." },
    "PARTITUR.",
  );
  eq(a.isFullScore, true, "判成总谱");
  eq(a.instrument, "总谱", "乐器名给总谱");
  eq(a.abstainReason, undefined, "不是弃权");
});

Deno.test("extraSections：主声部不是字符串时兜住，不抛", () => {
  // ⚠️ 这条上一轮被程序化删除误删过（它没引用任何被删机制，属于连带损失）——
  // 而它钉的正是 `parseExtraSections` 首句的 `typeof primary !== "string"`：
  // 删掉那一句，`primary.trim()` 会抛，而**导出的函数要自己判形态**
  // （调用方今天是 `buildAnalysis`、传的恒是字符串，但这个函数是 export 的）。
  for (const bad of [undefined, null, 123, {}, [], true]) {
    eq(parseExtraSections(["低音提琴"], bad as unknown as string), [], `primary=${String(bad)}`);
  }
});

Deno.test("extraSections：主声部落「其他」时一个额外声部都不收", () => {
  // 「其他」= 模型说「我认不出这是哪个声部」，而 extraSections 的语义是
  // 「**除了**主声部，还落到哪几个」—— 主声部没定下来，「除了」就没有立足点。
  // 不挡的话，一次不确定的判读会往**具体**声部里塞一份文件，而用户在「其他」
  // 与那个声部两处都会看到它。
  //
  // 三条到达「其他」的路径都要覆盖：模型字面写「其他」、写了闭集外的词、字段缺失。
  for (const raw of [{ section: "其他" }, { section: "Cello" }, {}]) {
    const a = buildAnalysis(
      {
        ...raw,
        instrument: "大提琴",
        evidence: "Violoncello e Basso",
        extraSections: ["低音提琴"],
      },
      "Violoncello e Basso",
    );
    eq(a.section, "其他", `section=${JSON.stringify(raw.section)} 应落其他`);
    eq(a.extraSections, [], "主声部是其他时不收额外声部");
    eq(a.abstainReason, undefined, "乐器名照样给出来了，不是弃权");
  }
  // 反向自检：主声部**认得出来**时照收（别把这条写成「凡是有其他就丢」）
  const ok = buildAnalysis(
    { section: "大提琴", instrument: "大提琴", evidence: "Violoncello e Basso", extraSections: ["低音提琴"] },
    "Violoncello e Basso",
  );
  eq(ok.extraSections, ["低音提琴"], "主声部正常时照收");
});

Deno.test("extraSections：主声部是总谱时也不收（与前端逐条对应）", () => {
  // ⚠️ 这一条**今天走不到**：`buildAnalysis` 的总谱分支在上一层就写死了
  // `extraSections: []`，而这里拿到的 primary 已经过 `normalizeSection`、
  // 永远不可能是「总谱」（它不在闭集里）。所以这条用例钉的是**函数自身的契约**，
  // 不是一个可达路径 —— 目的正是让这个导出的函数与前端 `normalizeExtraSections`
  // 逐条对应，将来谁把它改成「先统一算再分叉」时不会静默分叉。
  eq(parseExtraSections(["大提琴", "低音提琴"], "总谱"), [], "总谱不该有额外声部");
  eq(parseExtraSections(["大提琴"], "  总谱  "), [], "trim 后同样");
});

Deno.test("extraSections：闭集外的值直接丢弃，不弃权", () => {
  const a = buildAnalysis(
    {
      section: "大提琴",
      instrument: "大提琴",
      evidence: "Violoncello e Basso",
      // 模型把乐器清单当声部列表抄、或编了个不存在的声部名 —— 都只丢那一项
      extraSections: ["低音提琴", "巴松管", "随便写的"],
    },
    "Violoncello e Basso",
  );
  eq(a.extraSections, ["低音提琴"], "只留下闭集里认得的");
  eq(a.abstainReason, undefined, "主声部不受影响，不是弃权");
  eq(a.section, "大提琴", "主声部照常");
});

Deno.test("extraSections：排除「总谱」与「其他」，也排除与主声部重复的", () => {
  eq(
    parseExtraSections(["总谱", "其他", "大提琴", "低音提琴"], "大提琴"),
    ["低音提琴"],
    "总谱不是声部、其他是弃权分组、主声部不重复落",
  );
  // 「总谱」压根不在闭集里（INSTRUMENT_ORDER 不含它），是被 VALID_SECTIONS 挡下的；
  // 「其他」在闭集里，要单独排除 —— 两者走的是不同的分支，所以要一起测
});

Deno.test("extraSections：去重，且上界看**收下的**个数", () => {
  eq(parseExtraSections(["低音提琴", "低音提琴", "中提琴"], "大提琴"), ["低音提琴", "中提琴"], "去重");
  const many = parseExtraSections(
    ["低音提琴", "中提琴", "大提琴", "长笛", "双簧管", "单簧管"],
    "圆号",
  );
  eq(many.length, MAX_EXTRA_SECTIONS, "触顶就停");
});

Deno.test("extraSections：缺字段/没给/给不出声部 → 空数组，且不弃权", () => {
  // **缺省安全**：这不是「模型答错」，而是**旧后端根本不返回这个字段**的形态 ——
  // 前端按 `?? []` 读它，所以「缺席」必须与「空数组」同义，两仓才能各自上线。
  for (const bad of [undefined, null, 1, {}, true]) {
    const a = buildAnalysis(
      {
        section: "大提琴",
        instrument: "大提琴",
        evidence: "Violoncello e Basso",
        extraSections: bad,
      },
      "Violoncello e Basso",
    );
    eq(a.extraSections, [], `坏值 ${JSON.stringify(bad)} 不该造出声部`);
    eq(a.abstainReason, undefined, "也不该因此弃权");
  }
});

Deno.test("extraSections：标量与数组同义（判据不与输入形态相关）", () => {
  // `response_format: json_object` 下模型写成标量完全可达，而
  // `"低音提琴"` 与 `["低音提琴"]` 语义完全相同 —— 一个放行一个拒绝，
  // 就是又一处「形态相关的判据」（与 parseSubParts 那条教训同源）。
  const run = (raw: unknown) =>
    buildAnalysis(
      { section: "大提琴", instrument: "大提琴", evidence: "Violoncello e Basso", extraSections: raw },
      "Violoncello e Basso",
    ).extraSections;
  eq(run("低音提琴"), ["低音提琴"], "标量要接");
  eq(run(["低音提琴"]), ["低音提琴"], "数组要接");
  // 形态不同、语义相同的一对：都是「一个好元素 + 一个坏元素」，结论必须一致
  eq(run(["低音提琴", "巴松管"]), run(["低音提琴", 42]), "坏元素的**形态**不该改变结论");
  eq(run(["低音提琴", 42]), ["低音提琴"], "坏元素只丢自己");
});

Deno.test("extraSections：总谱路径恒为空", () => {
  // 总谱是「所有声部都在里面」，不是「一份谱落到某几个声部」—— 额外声部在这里没有意义
  const a = buildAnalysis(
    {
      isFullScore: true,
      instrument: "总谱",
      section: "其他",
      evidence: "Flauto, Oboe",
      extraSections: ["大提琴", "低音提琴"],
    },
    "Flauto, Oboe",
  );
  eq(a.isFullScore, true, "仍是总谱");
  eq(a.extraSections, [], "总谱不带额外声部");
});

Deno.test("extraSections：与 subParts 互不干扰（同声部多分谱 ≠ 多声部）", () => {
  // 这是最容易混的一对：`Horn_1,_2,_3,_4` 是**一个声部、四个分声部**，
  // 该走 subParts；`Violoncello e Basso` 是**两个声部共用一份**，该走 extraSections。
  const horns = buildAnalysis(
    { section: "圆号", instrument: "F调圆号", subParts: [1, 2, 3, 4], evidence: "Corno I, II, III, IV" },
    "Corno I, II, III, IV",
  );
  eq(horns.subParts, [1, 2, 3, 4], "四个号进 subParts");
  eq(horns.extraSections, [], "不进 extraSections");

  const celli = buildAnalysis(
    {
      section: "大提琴",
      instrument: "大提琴",
      subParts: [],
      extraSections: ["低音提琴"],
      evidence: "Violoncello e Basso",
    },
    "Violoncello e Basso",
  );
  eq(celli.extraSections, ["低音提琴"], "跨声部进 extraSections");
  eq(celli.subParts, [], "没有分声部号");
});

Deno.test("extraSections：主声部带空白时，去重那条也要认得出来", () => {
  // 早返回用的是 `primary.trim()`，而 `s` 也是 trim 过的 —— 只有去重那一处漏了的话，
  // 主声部带空白就绕过它，前端会插两行同名文件。
  for (const primary of ["低音提琴 ", " 低音提琴", "\u3000低音提琴", "低音提琴\u00A0"]) {
    eq(parseExtraSections(["低音提琴"], primary), [], `primary=「${primary}」`);
  }
  eq(parseExtraSections(["低音提琴"], "大提琴"), ["低音提琴"], "不同声部照旧收下");
});

// —— 判断交回 LLM（2026-09-25，用户定：弃权是最后手段 / 词表不能作为分析的直接手段）——

Deno.test("引文找不到也**采用**模型的答案 —— 它现在是信号，不是门", () => {
  // 这是 2026-09-25 这次改动里最重要的一条语义变化。此前 `evidence-not-in-source` 是一道**弃权门**：
  // 模型把引文翻译成中文、或 OCR 把引文打花时，整个本来可用的答案被丢掉。
  // 而弃权在这条链路里不是「安全」——它是「什么都没做」，还会把这份文件推进分段
  // （按页烧 OCR）。
  //
  // 现在：照样采用，只把「引文没在原文里找到」这个事实交给前端提示用户核对。
  const r = buildAnalysis(
    { section: "打击乐", instrument: "木琴", subParts: [], evidence: "这一段原文里根本没有" },
    SOURCE,
  );
  eq(r.instrument, "木琴", "答案照用");
  eq(r.section, "打击乐", "声部照用");
  eq(r.evidenceFound, false, "但要把「没找到」标出来");
  eq(r.abstainReason, undefined, "不再是弃权");

  // 反向：引文真的在原文里 → 标 true
  const ok = buildAnalysis(
    { section: "打击乐", instrument: "木琴", subParts: [], evidence: "Campanelli e Silofono" },
    SOURCE,
  );
  eq(ok.evidenceFound, true, "引文在原文里");
  eq(ok.abstainReason, undefined, "更不该弃权");
});

Deno.test("evidenceFound：模型**没给**引文时是 false，且不弃权", () => {
  const r = buildAnalysis({ section: "打击乐", instrument: "木琴", subParts: [], evidence: "" }, SOURCE);
  eq(r.evidenceFound, false, "空引文 = 没找到");
  eq(r.instrument, "木琴", "答案照用（此前是 no-evidence 弃权）");
  eq(r.abstainReason, undefined, "不再是弃权");
});

Deno.test("总谱分支也照用模型结论：证据弱不再拦", () => {
  // 此前 guard 会把「一个词顶上的证据」打成弃权，于是模型判对的总谱也可能被丢掉。
  // 判据还给模型 + 用户确认（prompt 规则 0），代码只做形状校验。
  for (const evidence of ["PARTITUR.", "Corno in Es", "1st Horn", "Flute part", ""]) {
    const r = buildAnalysis({ section: "其他", instrument: "总谱", subParts: [], evidence, isFullScore: true }, SOURCE);
    eq(r.isFullScore, true, `「${evidence}」不再拦总谱`);
    eq(r.instrument, "总谱", "总谱形态照旧");
    eq(r.abstainReason, undefined, "不弃权");
  }
});

Deno.test("分谱一字不变：isFullScore=false 时结果与没有这个字段一模一样", () => {
  // 「开关关着时对既有行为零影响」是这套改动的既定契约（前端还有一份对应断言）。
  // 这条随 guard 一起被删过一次，重建 —— 它是**契约**用例，不是判据用例。
  const withFalse = buildAnalysis(
    { section: "打击乐", instrument: "木琴", subParts: [1], evidence: "Campanelli", isFullScore: false },
    SOURCE,
  );
  const without = buildAnalysis(
    { section: "打击乐", instrument: "木琴", subParts: [1], evidence: "Campanelli" },
    SOURCE,
  );
  eq(JSON.stringify(withFalse), JSON.stringify(without), "一字不差");
});

Deno.test("弃权只剩形状类：语义类的都不再弃权", () => {
  // 2026-09-25 这次改动删掉的弃权 reason（下面每条各举一例，别数个数）：
  // `full-score-evidence-weak`（词表 guard）、`non-answer`（非答案词表）、
  // `ambiguous-violin`（小提琴正则）、`no-evidence` / `evidence-not-in-source`（证据门）。
  // 这条用「以前会被它们各自拦下的输入」反过来钉住它们没了。
  const cases: Array<[string, Record<string, unknown>]> = [
    ["证据太弱（旧 full-score-evidence-weak）", { section: "其他", instrument: "总谱", subParts: [], evidence: "x", isFullScore: true }],
    ["非答案说法（旧 non-answer）", { section: "其他", instrument: "无法判断", subParts: [], evidence: "Campanelli" }],
    ["小提琴没号（旧 ambiguous-violin）", { section: "其他", instrument: "小提琴", subParts: [], evidence: "Campanelli" }],
    ["没给引文（旧 no-evidence）", { section: "打击乐", instrument: "木琴", subParts: [], evidence: "" }],
  ];
  for (const [what, record] of cases) {
    const r = buildAnalysis(record, SOURCE);
    eq(r.abstainReason, undefined, `${what}：现在照用`);
  }
  // 反向：真正「响应不可用」的仍然弃权（这些是形状，不是语义）
  eq(buildAnalysis({ section: "打击乐", instrument: "", subParts: [], evidence: "x" }, SOURCE).abstainReason, "empty-instrument", "空乐器名照旧弃权");
  eq(buildAnalysis({ section: "打击乐", instrument: "a".repeat(200), subParts: [], evidence: "x" }, SOURCE).abstainReason, "instrument-too-long", "超长照旧弃权");
  // 字符判据那一组搬到了下面独立的 `Deno.test`（向量表与 pkuso-web 逐字同一份）。
  // 长度上界**数码点**（星光平面字符占 2 个码元，用 .length 会让上界凭空减半）
  const astral = "𠀀";
  eq([...astral.repeat(64)].length, 64, "对照组：64 个码点");
  eq(buildAnalysis({ section: "打击乐", instrument: astral.repeat(64), subParts: [], evidence: "x" }, SOURCE).abstainReason, undefined, "64 个码点放行");
  eq(buildAnalysis({ section: "打击乐", instrument: astral.repeat(65), subParts: [], evidence: "x" }, SOURCE).abstainReason, "instrument-too-long", "65 个码点弃权");
});

/**
 * ⚠️ **下面两张表与 pkuso-web 的同名测试是同一份**
 * （`src/app/admin/sheet-music/unsafe-name.test.ts`，搜 `UNSAFE_VECTORS` 定位）。
 * 两仓各判各的（这里判模型给的值、前端判用户手输的那一份），而两仓之间**没有任何机制
 * 能发现漂移**，表是唯一能把「同一件事」钉在两处的东西 —— 改一边必须改两边，
 * **加向量也要两边一起加**。
 *
 * ⚠️ **表里那些看不见的字符一律写成转义**（`\u00a0` 而不是那个字符本身）：它们在编辑器里
 * 是空白的，写成字面量的话，读的人和 diff 都分不出改的是哪一条（可见的全角字符仍是
 * 字面量 —— 那是内容本身，不是看不见的东西）。
 *
 * 表要同时满足两件事：**每一支都有独有的捕获者**（正则里删掉任何一支，都必须有向量
 * 当场变红），且**每一条都是真会走到的输入**（判据的调用方在判之前会 `.trim()`，所以
 * 空白类字符一律得写成夹在名字中间的样子 —— 两端的那种到不了这里）。
 * （前一条不是凑覆盖率 —— 2026-09-25 重写测试时曾只剩 `../etc/passwd` 一条，
 * 于是把 `\p{Cc}|\p{Cf}` 整支删掉也全绿，那是对抗测试实测出来的。）
 */
const UNSAFE_VECTORS: Array<[string, string]> = [
  // —— `\.\.`
  ["..", "两个点"],
  ["../etc/passwd", "路径上跳"],
  ["x/../../y", "藏在中间的 .."],
  ["．.", "NFKC 折叠后才成 ..（全角点 + 半角点）"],
  ["．．", "两个全角点"],
  // —— `\p{Cc}` / `\p{Cf}` / `\p{Cs}`
  ["长笛\u0000", "NUL：整行 insert 会失败，而对象已经传上去了 → 桶里一个孤儿对象"],
  ["a\u001fb", "C0 控制字符"],
  ["长笛\n圆号", "换行"],
  ["长笛\u200b", "零宽空格（Cf）：肉眼同名"],
  ["\ud800", "孤立代理（Cs）：UTF-8 里编不出来，Postgres 收不下"],
  // —— `\p{Default_Ignorable_Code_Point}`：类别是 `Lo`/`Mn`，上面几支**够不着**，
  //    而渲染出来是空白（后端 `BLANK_LETTERS` 认得的几个都落在这一族里）
  ["F调\u3164圆号", "韩文填充符：夹在名字中间，肉眼看不出来"],
  ["\u3164", "整个名字就是它 —— `isBlankName` 也拦不住（它只剥 Cf/Cc）"],
  ["F调\ufe0f圆号", "变体选择符"],
  // —— `\u2800` / `\ufffc`：**属性圈不到、只能点名收**的两个
  ["\u2800", "盲文空格：类别是 `So`，任何属性都圈不到它，只能点名"],
  ["\ufffc", "对象替换符：粘贴带嵌入对象的富文本时会带上它"],
  // —— `\p{Cf}` 里**不在** DICP 的那些（U+0600-0605 / U+FFF9-FFFB / U+13430-1343F…）：
  //    上面那一支接不住它们，删掉 `\p{Cf}` 就会静默漏出这一族
  ["长笛\ufff9", "行间注释锚：只有 `\\p{Cf}` 拦得住"],
  // —— `(?![ ])\p{Zs}`：非空格 Zs 里**除 U+1680 外**只有判 raw 才拦得住（NFKC 都折成普通空格）
  ["F调\u00a0圆号", "NBSP：肉眼与普通空格同形"],
  ["F调\u3000圆号", "全角空格：中文输入法全角模式下很好敲出来"],
  ["F调\u1680圆号", "欧甘空格：Zs 里唯一一个 NFKC 不动它的"],
  // —— `\p{Zl}` / `\p{Zp}`：NFKC 不动它们
  ["F调\u2028圆号", "行分隔符"],
  ["F调\u2029圆号", "段分隔符"],
  // —— Windows 文件名里非法的字符（全角写法折叠后才现形）
  ["Horn\\2", "反斜杠：Windows 上的路径分隔符"],
  ["长笛*", "星号"],
  ["长笛?", "问号"],
  ['长笛"solo"', "双引号"],
  ["长笛<x>", "尖括号"],
  ["长笛|1", "竖线"],
  ["圆号:1", "冒号：NTFS 上会写进备用数据流"],
  ["圆号：1", "全角冒号：NFKC 折成 :"],
  ["圆号＊", "全角星号：NFKC 折成 *"],
];

/**
 * 放行的对照组，与上面的表**同等重要** —— 判据是「拦下」，多拦一个就多一次**弃权**，
 * 而弃权会把多页文件推进分段（按页烧 OCR）＝ 白花钱买一个更差的体验。
 */
const SAFE_VECTORS: Array<[string, string]> = [
  ["圆号", "普通乐器名"],
  ["Bass Clarinet", "普通空格合法（钉住别把 `\\p{Zs}` 整支收进来）"],
  ["木琴/钟琴", "#12 允许的合称（`/` 刻意放行）"],
  ["Ｆ调圆号", "全角字母：NFKC 折成常规形式后合法"],
  ["圆号1,2", "分声部号"],
  ["Oboe 1-2", "连字符"],
  ["圆号.", "结尾的点：值放行（文件名是 `圆号..pdf`，已不在路径段的边界上）"],
];

/** 标题里那些字符要写成码位 —— 不然读的人分不清是哪一条 */
const invisibleInTitle = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800\ufffc]/u;

/** 一个码点写成 `\\u{XXXX}`（表里的转义写法，看得出是哪一个） */
const codePointLabel = (c: string) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`;

function show(s: string): string {
  let out = "";
  for (const c of s) out += invisibleInTitle.test(c) && c !== " " ? codePointLabel(c) : c;
  return out;
}

Deno.test("乐器名的字符判据：与 pkuso-web 同一份向量表", () => {
  const asInstrument = (instrument: string) =>
    buildAnalysis({ section: "打击乐", instrument, subParts: [], evidence: "x" }, SOURCE);
  for (const [raw, why] of UNSAFE_VECTORS) {
    eq(asInstrument(raw).abstainReason, "instrument-illegal-chars", `必须弃权：${show(raw)} —— ${why}`);
  }
  for (const [raw, why] of SAFE_VECTORS) {
    eq(asInstrument(raw).abstainReason, undefined, `必须放行：${show(raw)} —— ${why}`);
  }
});

Deno.test("show：用例标题里的转义（只服务失败信息，不涉生产行为）", () => {
  // 这一份只用在 `必须弃权：${show(raw)}` 这类失败信息里 —— 漏转义不会让任何判据失效，
  // 只会让报错里出现一个空白字符、读的人分不清是哪一条（前端那一份有同款测试）。
  for (const cp of [0x3164, 0xfe0f, 0x2800, 0xfffc, 0x0007, 0x2007]) {
    const label = show(String.fromCharCode(cp));
    eq(label.includes("\\u{"), true, "U+" + cp.toString(16).toUpperCase() + " 没被转义：" + label);
  }
});


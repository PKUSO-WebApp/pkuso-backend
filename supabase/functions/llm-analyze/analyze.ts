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
 * 总谱：**不是声部**，而是「整份谱（所有声部都在里面）」的标记。
 *
 * 与 pkuso-web 的 `FULL_SCORE_SECTION` 是同一份契约（那边用它做详情页排序与
 * 「总谱不参与切分检测」的人工标记）。放这里是因为**后端要能主动判出它** ——
 * 人工标记那条路要等分段跑完才做得出来，那时 OCR 早烧完了（见 pkuso-web#297）。
 */
export const FULL_SCORE_SECTION = "总谱";

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
 * 留着它是因为序号让分谱文件名自解释（`小提琴_1.pdf` 好过 `小提琴.pdf`）。
 *
 * ⚠️ **它的优先级也变了**：现在是「模型给了合法号就采信模型，这里只在模型一个号都没给时兜底」，
 * **不再覆盖模型输出**。覆盖会把信息压掉 —— `Violin_1,_2.pdf` 会被压成 `[1]`，
 * 详见 buildAnalysis 里那段注释。
 */
const VIOLIN_SUB_PART: Record<string, number> = {
  第一小提琴: 1,
  第二小提琴: 2,
};

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
 * 不剥的话，两个零宽空格就能凑够长度冒充引文。
 *
 * 不做归一化就直接比较同样不行 —— OCR 与模型抄写常在空格、连字符、大小写上
 * 不一致（`Horn_2` / `Horn 2` / `HORN-2` 是同一件事）。数字必须保留：分声部号是有意义的证据。
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(BLANK_LETTERS, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
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
 * ⚠️ 这条 guard 的**理由换过一次**：它原是用来防「几千字的乐器名造出一条荒唐的
 * storage 路径」（旧前端把 instrument 当路径的目录名用）。那个前提**已经不成立**
 * —— 存储键是 `{scoreId}/{行 id}.pdf`（uuid），乐器名进不去（也进不去的原因见
 * pkuso-web `upload-modal.tsx` 的 `pathOf`：Storage 的键不认中日韩字符）。
 *
 * 现在它守的是**另外两处**：乐器名会进 `file_name`（`F调圆号.pdf`，用户下载时
 * 落到自己文件系统上的名字）和 `sheet_music_files.instrument` 列。
 * 真实乐器名没有超过 20 字的，给到 64 已经极宽松 —— 触顶说明模型在胡说，
 * 弃权让用户填比把它写进文件名与库好。
 *
 * 只设长度、不做字符替换：`木琴/钟琴` 这种合称是 #12 验收标准里允许的写法，
 * 而后端没有立场去改写一个用户会看到的乐器名。
 *
 * ⚠️ **数的是码点，不是码元**（`[...s].length`）。用 `s.length` 的话，
 * 星光平面字符（`𠀀` 占 2 个码元）会让上界凭空减半 —— 也就是同一个上界对两类字符
 * 给出不同结果。判据不该与输入形态相关，所以按码点数。
 */
const MAX_INSTRUMENT_CHARS = 64;

/**
 * 乐器名里绝对不能让文件名 / 库值出现的东西 —— 与 pkuso-web 的 `unsafe-name.ts`
 * 是**逐字一份**（同一个常量名 `UNSAFE_IN_NAME`，搜它定位，别写行号）。
 * 两仓各判各的（后端判模型给的值、前端判用户手输的那一份），而两仓之间**没有任何机制
 * 能发现漂移** —— 改一边必须改另一边，**加一支也要两边一起加**。
 *
 * 理由从「storage 路径」换过一次：存储键是 `{scoreId}/{行 id}.pdf`（uuid），乐器名进不去。
 * 现在守的是 `file_name`（`F调圆号.pdf`，用户下载时落到自己文件系统上的名字）
 * 与 `sheet_music_files.instrument` 列。
 *
 * 收哪几种只有一条线：**「落不下去」或「落下去之后肉眼分不出来」**。这条线在这一侧
 * 格外要紧 —— 后端每多拦一种就多一次**弃权**，而弃权会把多页文件推进分段
 * （`needsSegmentation`，按页烧 OCR），所以「看着可疑」的字符一律不收。
 * 逐支的理由与前端那份注释一致。其中 `\p{Default_Ignorable_Code_Point}` 一支收的是
 * **默认不可见的那一整族**（4 千多个码点：韩文填充符、变体选择符…，类别是 `Lo`/`Mn`
 * 所以 `\p{Cf}` 够不着）—— 它值这一次弃权：放过去就是一个肉眼看着没有名字的乐器名，
 * 而本文件的 `BLANK_LETTERS`（引文归一化）认得的几个都落在这一族里 —— 它是**子集**，
 * 不是同一份清单（那段只列了 4 个韩文填充符，不含变体选择符）。
 * 另有 \u2800 / \ufffc 一支（盲文空格、对象替换符）：它们**不在任何属性集里**，只能逐码点点名 ——
 * 空白字形是一类**渲染**性质、圈不全，所以这一支是一个**点名清单**，只收了确实会从
 * 别处粘进来的那两个。
 *
 * **拦下让用户手填，而不是替换字符**：`木琴/钟琴` 这种合称是 #12 允许的写法，
 * 后端没有立场去改写一个用户会看到的乐器名 —— 而 `/` 只是多一个斜杠，不致命。
 *
 * ⚠️ **判 raw 与 NFKC 折叠后两种形态**（存的是原始值），缺哪一种都会漏 —— 见 `unsafeInName`。
 */
const UNSAFE_IN_NAME =
  /\.\.|\p{Cc}|\p{Cf}|\p{Cs}|\p{Default_Ignorable_Code_Point}|[\u2800\ufffc]|(?![ ])\p{Zs}|\p{Zl}|\p{Zp}|[\\*?"<>|:]/u;

/**
 * 两种形态任一命中即算。缺哪一种都会漏：
 *
 * - **折叠会造出问题**：`．.`（全角点 + 半角点）折完就是 `..`；`：＊？＜＞｜＂＼` 折完
 *   是 `:*?<>|"\`。旧版判的就是折叠后那一份，这一半它拦得住。
 * - **折叠会消掉问题**：非空格 `Zs`（NBSP、全角空格…）的 NFKC **全是普通空格**
 *   （U+1680 是唯一的例外，它没有兼容分解），而普通空格是合法的。只判折叠后那一份，
 *   夹在名字当中的它们一个也拦不住 —— 而它们与真正的空格**肉眼完全同形**，
 *   唯一约束也拦不住（两个值并不相等）。这一半是本次补上的。
 *
 * 两端的那类空白到不了这里：调用点拿到的是 `.trim()` 过的值，而 `trim` 按规范会把所有
 * `Zs` 从两端去掉（`\p{Cf}` 不在它的范围内 —— 零宽空格在两端也留得下来，由 `\p{Cf}` 接住）。
 *
 * 代价是顺带拒掉几个本来无害的字符（`‥`/`…`/`︙`/`︰` 都会折出点），可接受 ——
 * 那几种写法在乐器名里本来也不该出现。
 */
function unsafeInName(s: string): boolean {
  return UNSAFE_IN_NAME.test(s) || UNSAFE_IN_NAME.test(s.normalize("NFKC"));
}

/**
 * 「看不见的字符」整族 —— 判「这一格到底给没给东西」时，连同空白一起算「没给」。
 *
 * 为什么不能只用 `.trim()`：它按规范只剥 WhiteSpace 与 LineTerminator，而 `\p{Cf}`
 * （零宽空格 U+200B、行间注释锚 U+FFF9…）与 `\p{Default_Ignorable_Code_Point}`
 * （韩文填充符 U+3164、变体选择符 U+FE0F…）都不在里头 —— 后者的类别是 `Lo`/`Mn`，
 * `\p{Cf}` 也够不着它。于是「只由它们组成的文件名」肉眼全空、`.trim()` 之后却非空，
 * 会一路进 prompt：`文件名（…）：` 后面什么都没有，等于花一次调用让模型对着一串
 * 看不见的「名字」编答案（pkuso-backend#40）。
 *
 * ⚠️ **这是 `UNSAFE_IN_NAME` 的「看不见」子集，不是它本身**：那一条还收 `\.\.`、
 * `(?![ ])\p{Zs}`、`\p{Zl}\p{Zp}`、`[\\*?"<>|:]` —— 那些让一个名字**危险**，不叫**空**
 * （`..`、`圆号:1`、`长笛*` 都被它命中，却显然不是空名字；反过来 `Horn_1,_2.pdf` 一个
 * 危险字符都没有）。把整条当成「**命中即算空**」的判据（`s.trim() === "" || unsafeInName(s)`
 * 那种写法），被命中的那些名字就会被判成「没给名字」。
 *
 * ⚠️ 与 pkuso-web 的 `isBlankName`（`row-text.ts`）**刻意不同名、也不同宽**：那一份只剥
 * `Cf`/`Cc`，因为它那边「只填 U+3164 的名字」有 `findUnsafeInName` 接住、能给用户一句
 * 说得清的话（那一侧的注释写明了这个分工）。这一侧没有那样一条后手 —— `file_name` 至今
 * 没有任何**危险字符**判据（`UNSAFE_IN_NAME` 只判模型给的 `instrument`，正是 #40 的另一半）
 * —— 所以判空必须把整族算进去，否则没人接。
 *
 * ⚠️ **实现形态是有选择的**（换写法前先看这三组实测，同一台机器）：
 * - 先归一、再 trim 那种写法（`s.replace(不可见族, "").trim() === ""`）：**它要为需要
 *   拼接的段数各分配一次新串** —— 关键不是命中多少，而是**非相邻的命中各成一段**。
 *   单变量对照（22.9M 码点、都是 ~11.45M 处命中，只改命中布局）：交替形态在
 *   **老生代上限 256 MB** 下崩溃（稳定复现），而把命中连成**一整片**只要 86 ms 就正常完成。
 *   于是 22.9 MB 的交替 body 会把峰值堆推到 385 MB，而 Supabase 给 isolate 的上限是
 *   256 MB（官方 Limits 页）：一条**本该被 400 拒掉**的请求会先把实例打爆。
 * - **逐字符 JS 扫**（`for (const ch of s) …`）：内存没问题，但**没有早退点的形态**
 *   （整串都不可见，必须扫完才能确认）要付迭代器协议 + 每字符一次 `.test()` 的代价 ——
 *   5000 万个空格实测 1148 ms，用掉平台 2s CPU 上限的一半还多（Limits 页）。
 * - **一条原生正则扫描**（现在这个）：不分配、也不退化成 JS 循环 —— 同样输入降到
 *   几十毫秒。顺带把白名单收成一份（`VISIBLE` 取反），没有「两处都要改」的漂移面。
 *
 * ⚠️ `VISIBLE` **不要加 `g`**：它的唯一消费者是 `test()`，而 `g` 正则会带 `lastIndex` 状态 ——
 * 同一个串连判两次会给出两个答案（这条判据被调用的次数不少，踩上就是随机的错答案）。
 * `analyze.test.ts` 那条静态守卫按**白名单**钉着这个形态（整段文本必须原样存在），
 * 改实现前先看那条用例的注释 —— 它会告诉你为什么不能用禁词表。
 */
const VISIBLE = /[^\s\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800\ufffc]/u;

/**
 * 「整串都看不见」吗？看不到任何可见字符 = 这一格**等于没给**。
 *
 * 判据只有这一份：`handler.ts` 的入口校验与 prompt 分支都用它（两份拷贝迟早漂移，
 * 本仓栽过 —— #41 就是这么来的：同一个真值判据写在两处，两处一起错）。
 */
export function isEffectivelyBlank(s: string): boolean {
  return !VISIBLE.test(s);
}

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
  /**
   * 模型**给了**分声部号、但我们一个都没解析出来时，带上原文（截断到 60 字）。
   *
   * 它把「本来就没有分声部」与「给了但没读懂」区分开 —— 前者用户什么都不用做，
   * 后者**需要用户手填**，而两者的 `subParts` 都是空数组。没有这个字段，界面会显示
   * 「已识别 → 圆号 / F调圆号」，用户既不会去填、也不知道要填，号就这么静默丢了。
   *
   * 与 `sectionRaw` 是同一个用途（把静默差异变成可见信号），命名也照它。
   */
  subPartsRaw?: string;
  /** 弃权原因，仅在 instrument 为空串时出现 */
  abstainReason?: string;
  /**
   * 引文能不能在原文里找到。
   *
   * ⚠️ **这是信号，不是门**（用户 2026-09-25 定：弃权是最后手段）。找不到时**照样采用**
   * 模型的答案，只把这个事实交给前端提示用户核对。此前它是一道**弃权门**
   * （`evidence-not-in-source`），代价是模型把引文翻译成中文、或 OCR 把引文打花时，
   * 一个本来可用的答案被整条丢掉 —— 而弃权在这条链路里不是「安全」，是「什么都没做」，
   * 还会把这份文件推进分段（按页烧 OCR）。
   */
  evidenceFound: boolean;

  /**
   * 引文**只在文件名里**找得到（页面 OCR 文本里没有）。
   *
   * 与 `evidenceFound` 分开报，是因为「引文来自文件名」和「引文根本没找到」是两件
   * 完全不同的事，而它们此前都被算成「找到了」：
   *
   * · 出版社扫描分谱的乐器名往往就印在文件名里（`PMLASIA01165-13-Horn_2.pdf`），
   *   而页面是扫描件、OCR 读出来是乱的 —— 这时抄文件名是**正当**的依据；
   * · 但抄文件名里的**流水号**（`IMSLP807980-PMLP2711-10`）就不支撑任何结论了 ——
   *   那正是「引文存在于输入 ≠ 支撑结论」这个弱点的形态（pkuso-web#300 实测 36 次里 2 次）。
   *
   * 后端**判不了**「这句引文到底支不支撑这个结论」（那是子串检查做不到的事，同
   * `score-guard-cannot-judge` 那条教训），所以这里只报**事实**：引文出现在哪儿。
   * 用户据此知道该去页面上核对、还是去看文件名 —— 这才是「让用户复核」。
   */
  evidenceFromFileName: boolean;

  /**
   * 这一页是不是**总谱**（多个乐器并列、多行谱表）。
   *
   * **必须在「空乐器 → 弃权」之前判定**：没有任何单一乐器**正是总谱的特征**，
   * 按原有顺序走，模型的正确回答会被 `abstain("empty-instrument")` 当成「答不出来」丢掉 ——
   * 总谱就永远判不出来（2026-09-25 那次改动里最容易写错的一处）。
   */
  isFullScore: boolean;
  /**
   * 主声部之外，这份谱**还要落到**哪几个声部。恒为数组（没有额外声部时是 `[]`）。
   *
   * 起因是一类**一个分部、跨两个声部、又不能切**的谱：贝多芬的 `Violoncello e Basso`
   * 是低音提琴与大提琴共用的那一份（低音提琴低八度跟大提琴走），**每一页页眉都是
   * 同一行** —— 没有任何页边界可找，所以分段救不了它，而两个声部**都得拿到整份**
   * （硬切成两段的结果是两个声部各拿到一半的谱）。
   *
   * 表达方式是**两行**：同一份谱在 `sheet_music_files` 里落成两行，各自有自己的
   * `part_id` 与 `file_name`，于是两个声部的分组里都看得到它。
   * 这个字段只是把「要落哪几个声部」这件事告诉调用方 —— **存储对象由调用方负责，
   * 而且必须每行一个**：详情页删除时是**先删对象再删行**，两行共用对象的话，
   * 删掉一行会把另一行还在用的 PDF 一起删掉（详情页看着完好、下载 404）。
   * （前端 `sections.ts` 与 `upload-modal.tsx` 的 `uploadOne` 里记着同一条。）
   *
   * ⚠️ **与 `subParts` 是两回事**，别混：`subParts` 是**同一个声部**内的分声部号
   * （`Horn_1,_2,_3,_4` → `[1,2,3,4]`，四个号都归圆号声部）；`extraSections` 是
   * **不同的声部**（大提琴 + 低音提琴）。所以「同一件乐器的多个分声部」不该写进这里。
   *
   * ⚠️ 与 `subPartsRaw` / `sectionRaw` 不同，这个字段**没有 Raw 信号**：非法元素直接
   * 丢弃。理由它不是「模型给了但我们读不懂」（那种要用户手填），而是「模型多写了一个
   * 词」—— 丢掉的只是一个多余的目的地，主声部不受影响，界面上也能手工补。
   *
   * ⚠️ **保留模型给的顺序、不排序**（理由见 `parseExtraSections`）。调用方按这个顺序
   * 依次建 part 与文件行，所以顺序是有后果的，不是展示细节。
   */
  extraSections: string[];
}

/**
 * evidence 是否真的能在输入文本里找到。
 *
 * 用来算 `evidenceFound` —— **信号，不是门**（2026-09-25 改）：
 * 引文找不到时仍然采用模型的答案，只把这个事实交给前端提示用户核对。
 * 此前它是一道弃权门，代价是模型把引文翻译成中文、或 OCR 把引文打花时，
 * 一个本来可用的答案被整条丢掉 —— 而弃权在这条链路里不是「安全」，是「什么都没做」。
 *
 * ⚠️ 它判的是「引文**存在于**输入」而非「引文**支撑**结论」。具体到最松的一例：
 * 调用方（pkuso-web upload-modal.tsx）会把文件名与 OCR 文本拼成
 * `文件名: X\nOCR 文本: Y` 再发过来，于是模型抄那四个字的**标签**就能通过。
 * 所以这个信号本身也偏松：它能判的只是「引文确实出现在输入里」，
 * 判不了「这段引文支撑这个结论」。**别把它读成可靠性评分。**
 * 后端没有立场去剥调用方拼的标签（那是给调用方格式打指纹，比这个弱点更脆）；
 * 真正的收紧手段是让前端分开传两个字段，而不是拼成一段。
 */
export function evidenceSupports(evidence: string, source: string): boolean {
  const needle = normalizeForMatch(evidence);
  // 归一化会剥掉一切非字母数字，于是「。」「👨\u200d👩\u200d👦」、两个零宽空格（U+200B）
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
 *
 * **要 export**：prompt 里那句「个数最多 N」由它插值出来（同 `SECTIONS` → `SECTION_LIST`
 * 的做法）。抄一份数字进 prompt 的话，改了这里而 prompt 仍在对模型说旧值 ——
 * 模型照着旧上界给号、代码按新上界弃权，两边静默拆台。
 */
export const MAX_SUB_PARTS = 32;

/**
 * 分声部号。**唯一合法格式是英文逗号分隔的阿拉伯数字**：`1` / `1,2` / `1,2,3`。
 *
 * 归一化只收敛「同一个符号的不同写法」，不做语义猜测：
 * - NFKC 折叠 —— 注意它折出来的范围**比"全角"宽**：`２`（全角）、`①`（带圈数字，
 *   有 `<circle> 0031` 兼容分解）、`²`（上标）、`𝟏`（数学字母）都会变成 `1`。
 *   NFKC 是**无差别**折叠的，另一些字符它同样会折，只是折完仍非法、于是照样弃权：
 *   `Ⅰ`（U+2160）→ `I`、`⑵` → `(2)`、`½` → `1⁄2`（U+2044）。
 *   所以「弃权」在这些字符上**不是**因为 NFKC 放过了它们，而是因为折完不是数字
 *   （`/^\d+$/` 挡下）—— 理由要记对，否则下次有人「修」NFKC 会把它们放进来。
 *   这是 NFKC 的既定行为、不是这里加的特例（旧版单值实现同理），但契约文字得说实话。
 * - 全角逗号「，」与顿号「、」折半角；去空白 —— 中文语境下这两种写法太常见。
 *
 * 其余一律**弃权（返回空数组）**：
 * - `1-3` 这类区间：是 1,2,3 还是「第 1 和第 3」？替模型决定语义就是猜。
 * - 罗马数字 / 中文数字：prompt 已明确要求阿拉伯数字，容忍它们等于同时维护两套解析。
 * - **只要有一个非空片段不是正整数，整个弃权** —— 部分解析比不解析更危险：
 *   `1,2,3支` 若丢掉 `3支` 得到 `[1,2]`，那是个**看起来对**的错答案，会一路写进文件名；
 *   而弃权只是让用户手填一次。（这是**解析**的取舍 —— 数字本身没有语义可猜。）
 *
 * 返回升序去重的数组。
 *
 * ⚠️ 空数组有两个来源：**「本来就没有分声部」与「给了但没解析出来」**。二者对调用方
 * **不等价**（后者需要用户手填）—— 所以调用方不能只看这个返回值，见 `Analysis.subPartsRaw`。
 * 本函数只管解析，不做区分。
 */
export function parseSubParts(raw: unknown): number[] {
  // 标量写成数组、数组写成标量，JSON 里两种都会发生，都接
  const parts = Array.isArray(raw) ? raw : [raw];

  const out = new Set<number>();
  for (const part of parts) {
    if (typeof part === "number") {
      if (!isValidSubPart(part)) return [];
      out.add(part);
      continue;
    }
    if (typeof part !== "string") return [];
    // 数组里的空串与字符串里的空片段是**同一件事**（补位写法 / 多打的逗号），
    // 都只是格式噪声。只在下面那层豁免会让 `[1,""]` 弃权、而 `"1,"` 放行 ——
    // 又一处与形态相关的判据，正是上面那段注释要消灭的东西。
    if (part.trim() === "") continue;
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
  // 个数上界用**去重后**的个数判：上界防的是「号进 file_name 把文件名撑爆」，
  // 那看的就是最后落进文件名的个数。
  //
  // ⚠️ 刻意**不**在解析前按 `parts.length` 预检 —— 那会让判据变成**形态相关**的：
  // `Array(33).fill(1)` 与 `"1,1,…（33 个）"` 语义完全相同，前者弃权而后者放行。
  //
  // 想知道这句预检值不值得有，跑一次就知道：把它加回函数开头，看
  // 「parseSubParts：个数上界看**去重后**的个数，且与形态无关」这条用例是否变红。
  // （别把某次实测的结论写在这里 —— 后来人补一条数组形态的用例，那句话就不再成立了。）
  if (out.size > MAX_SUB_PARTS) return [];

  return [...out].sort((a, b) => a - b);
}

/**
 * 模型**确实给了点什么**（而不是在表达「没有分声部」）。
 *
 * 判据：**只有「什么都没有」才算没给，其余一律算给了**。拿不准时偏向**报警** ——
 * 多一条提示让用户看一眼，好过把真号静默丢掉（那正是 `subPartsRaw` 要消灭的失败模式）。
 *
 * ⚠️ **不再用词表认「模型说没有」的说法**（`"无"` / `"none"` / `"unknown"` / `"N/A"`…）：
 * 那是一条开放的用词清单，加不全，每加一个都可能误伤。改为只认**结构性**的「没有」——
 * 字段缺失 / `null` / 空数组 / 空串。代价是模型用自然语言答「没有」时会多显示一次
 * 「请核对分声部号」；prompt 规则 8 要求的本来就是数组，那属于它没照契约答。
 */
function providedSubParts(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "string") return raw.trim() !== "";
  // number / boolean / object …：都不是「没有」的表达，算给了，交给 parseSubParts 去拒
  return true;
}

/**
 * 把「没解析出来」的那个值压成一句短的，供界面提示用户手填。太长会把响应撑大且没人看。
 *
 * ⚠️ 它**不是原文回显**，只是给用户看的线索。两处损失是 `JSON.parse` 造成的、找不回来：
 * 超长整数在解析时就已经丢精度（`99999999999999999999999` → `1e+23`），
 * 非有限数（`1e999` → `Infinity`）只剩一个名字。所以前端别拿它当原文用。
 */
function describeRaw(raw: unknown): string {
  let s: string;
  if (typeof raw === "string") {
    s = raw.trim();
  } else if (typeof raw === "number") {
    // 单独走 String()：`JSON.stringify` 会把 Infinity / NaN 写成字面量 `null` ——
    // 而 `"null"` 正是本模块规定的「模型说没有」写法，那会造出一句
    // 「给了 null 却读不懂，请手填」的自相矛盾提示。
    s = String(raw);
  } else {
    s = JSON.stringify(raw) ?? String(raw);
  }
  // 按**码点**截断：`slice(0, 60)` 数的是 UTF-16 码元，会在 emoji 中间劈开代理对
  const points = [...s];
  return points.length > 60 ? `${points.slice(0, 60).join("")}…` : s;
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
    isFullScore: false,
    extraSections: [],
    // 弃权时引文恒为空 —— 没有可核对的引文
    evidenceFound: false,
    evidenceFromFileName: false,
    abstainReason: reason,
    ...(sectionRaw ? { sectionRaw } : {}),
  };
}

/**
 * 额外声部的**个数**上界。
 *
 * 与 `MAX_SUB_PARTS` 同一个用途（防模型胡说），但量级小得多：真实的「共用分谱」
 * 是两件乐器的事（`Violoncello e Basso`、`Celli e Bassi`）。给到 3 已经极宽松 ——
 * 触顶说明模型把乐器清单当声部列表抄了。
 *
 * **要 export**（同 `MAX_SUB_PARTS`）：prompt 里那句「个数最多 N」由它插值出来，
 * 抄一个数字进 prompt 的话，改了这里而 prompt 仍在对模型说旧值 —— 模型照着旧上界给、
 * 代码按新上界截，两边静默拆台。`index.test.ts` 有一条断言把这条插值钉住。
 * 前端 `sections.ts` 另有一份同名常量（跨仓没有自动同步机制，改的时候两边一起看）。
 */
export const MAX_EXTRA_SECTIONS = 3;

/**
 * 解析 `extraSections`。**只接受原样落在闭集里的声部名**，其余一律丢弃。
 *
 * ⚠️ **不能复用 `normalizeSection`**：那个函数把不认识的值折成「其他」并带上
 * `sectionRaw`，那套语义是给**主声部**用的（落「其他」是合法退路，原值是个要看得见的
 * 词表漂移信号）。额外声部这里折成「其他」等于**凭空造一个声部**出来 ——
 * 而「其他」是弃权分组，不该有一份谱以「额外声部是其他」的身份落进去。
 *
 * 丢弃而不是弃权：丢的只是一个多余的目的地，主声部照常成立，且界面上可以手工补。
 * 与 `parseSubParts` 的「有一项非法就整个弃权」相反 —— 那边弃权是为了不让一个
 * **看起来对**的号写进文件名；这里没有对应的危险。
 */
export function parseExtraSections(raw: unknown, primary: string): string[] {
  // 导出的函数自己兜住入参形态，不要让调用方的
  // 类型假设变成运行时异常（`primary` 声明成 `string`，但请求体是用户可控的 JSON）。
  // 报错会让**整次分析**失败，而这里的语义是「算不出额外声部就一个都不给」。
  if (typeof primary !== "string") return [];
  // ⚠️ 主声部落「其他」时**一个额外声部都不收**。
  //
  // 「其他」是**弃权分组**：模型说「我认不出这是哪个声部」。而 `extraSections` 的语义是
  // 「**除了**主声部，还落到哪几个」—— 主声部都没定下来，「除了」就没有立足点。
  // 更要紧的是后果：主声部未知却照落一个**具体**声部，等于用同一次不确定的判读
  // 往「低音提琴」组里塞一份文件，而用户在「其他」与「低音提琴」两处都会看到它。
  // 宁可少落一处、让用户手填（界面上有「+ 声部」），也不要在不确定的基础上落库。
  if (primary.trim() === OTHER_SECTION) return [];
  // 总谱：它是「所有声部都在里面」，不是「一份谱落到某几个声部」—— 与前端
  // `normalizeExtraSections` 逐条对应（那条判据在那边也是早返回）。
  //
  // ⚠️ 今天走不到这里：`buildAnalysis` 的总谱分支在**上一层**就直接写了
  // `extraSections: []`，而这里拿到的 `section` 已经过 `normalizeSection`，
  // **永远不可能是「总谱」**（它不在闭集里）。写成显式的，是为了让这个**导出的、
  // 有单测的**函数自身成立 —— 否则哪天有人把它改成「先统一算 extraSections 再分叉」，
  // 两侧就会静默分叉（界面上看得到 chip、落库却少一行，或反过来）。
  if (primary.trim() === FULL_SCORE_SECTION) return [];
  // 标量写成数组、数组写成标量，JSON 里两种都会发生，都接 —— 与 `parseSubParts` 同一条
  // 规矩。判据**不能与输入形态相关**：`"低音提琴"` 与 `["低音提琴"]` 语义完全相同，
  // 一个放行一个拒绝就是又一处形态相关的判据（`parseSubParts` 的注释里记着这条教训）。
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    // 「总谱」不在 VALID_SECTIONS 里（它不是声部），自动挡下；
    // 「其他」在闭集里但是弃权分组，单独排除。
    if (!VALID_SECTIONS.includes(s) || s === OTHER_SECTION) continue;
    // 与主声部重复的丢掉：一份谱落到同一个声部两次会让前端插两行同名文件。
    // ⚠️ 比的是 `primary.trim()` —— 上面两处早返回用的是 `primary.trim()`，而 `s`
    // 也是 trim 过的；只有这里漏掉的话，主声部带空白就绕过这条去重（第 5 轮实测）。
    if (s === primary.trim()) continue;
    out.add(s);
    // 上界按**收下的**个数判（与 MAX_SUB_PARTS 同一套：上界防的是最终落库的规模）
    if (out.size >= MAX_EXTRA_SECTIONS) break;
  }
  // **保留模型给的顺序，不排序。** 与 `subParts` 相反（那边是数字，升序是自然的）：
  // 声部名之间没有天然次序，而 `sort()` 比的是 UTF-16 码元 —— 中文会排成
  // 「中提琴 → 低音提琴 → 大提琴」这种谁都不认得的顺序。而这个顺序**是有后果的**：
  // 调用方按它依次建 part 与文件行，模型的顺序至少还反映谱面上的先后。
  return [...out];
}

/**
 * 把 LLM 返回的 JSON 收敛成契约结果。**只有形状不对才弃权** ——
 * 语义判断交给模型（prompt 规则 0）与用户确认那一步，代码不再复核。
 *
 * @param parsed 已 JSON.parse 的模型输出
 * @param source **页面的 OCR 文本**（不含文件名）—— 用来算 `evidenceFound`
 *   （信号，不参与弃权）。⚠️ 2026-09-26 起这里**只收 OCR 文本**：以前收的是
 *   「文件名 + OCR」拼成的一整段，于是引文抄文件名也算「在原文里找到」，
 *   而那个信号是「让用户复核」的唯一依据（pkuso-web#300）。
 *   收 `unknown` 而非 `string`：请求体是用户可控的 JSON，值不一定是字符串，
 *   这里必须自己兜住而不是让调用方的类型假设变成运行时异常。
 * @param fileName 文件名（可选）。只用来算 `evidenceFromFileName` —— 引文**没在页面上、
 *   只在文件名里**找得到时，前端会显示成另一种依据（来自文件名，不是页面）。
 */
export function buildAnalysis(parsed: unknown, source: unknown, fileName?: unknown): Analysis {
  const record =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  const instrument = typeof record.instrument === "string" ? record.instrument.trim() : "";
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
  const { section, sectionRaw } = normalizeSection(record.section);
  // 只有**恰好 `true`** 才算：`"true"` / `1` / 缺字段一律按「不是总谱」——
  // 总谱会改写落库的声部与分声部号，宁可漏判（用户还能人工标），不可误判。
  const isFullScore = record.isFullScore === true;

  // ⚠️ **总谱必须在下面那条「空乐器 → 弃权」之前判**：没有单一乐器正是总谱的特征。
  // 引文能不能在原文里找到 —— **信号，不是门**（见 `evidenceFound` 字段的说明）。
  const evidenceFound =
    typeof source === "string" && evidence !== "" && evidenceSupports(evidence, source);
  // 只在「页面上找不到」时才问文件名 —— 页面上找得到就是最强的那个依据，
  // 不必再报「也在文件名里」这种没有信息量的组合。
  const evidenceFromFileName =
    !evidenceFound &&
    evidence !== "" &&
    typeof fileName === "string" &&
    evidenceSupports(evidence, fileName);

  if (isFullScore) {
    if (typeof source !== "string") return abstain("bad-source", sectionRaw);
    return {
      section: FULL_SCORE_SECTION,
      // 乐器名给「总谱」而不是空串：前端据此生成文件名「总谱.pdf」，且不会被
      // 「未识别出乐器」那道拦截挡下（总谱本来就没有单一乐器可填）
      instrument: FULL_SCORE_SECTION,
      subParts: [],
      // 总谱是「所有声部都在里面」，不是「一份谱落到某几个声部」——
      // 额外声部这个概念在这里没有意义（见 extraSections 的说明）。
      extraSections: [],
      evidence,
      isFullScore: true,
      evidenceFound,
      evidenceFromFileName,
    };
  }

  // 模型自己弃权了
  if (!instrument) return abstain("empty-instrument", sectionRaw);
  if ([...instrument].length > MAX_INSTRUMENT_CHARS) return abstain("instrument-too-long", sectionRaw);
  // ⚠️ **判 raw 与折叠后两种形态、存原始的** —— 乐器名本身的全角/兼容字符是模型给的原文，
  // 不该被我们改写；而两种形态各有对方看不见的东西（`．.` 折叠后才成 `..`，NBSP 折叠后
  // 反而成了合法的空格），只判一种就一定漏。详见 `unsafeInName`。
  if (unsafeInName(instrument)) {
    return abstain("instrument-illegal-chars", sectionRaw);
  }

  // source 类型不对就没法验证据。正常路径下 index.ts 已经拦掉了，
  // 这里是兜底：区分「请求非法」与「模型在编」，不要让后者替前者背锅。
  if (typeof source !== "string") return abstain("bad-source", sectionRaw);

  const violinSubPart = VIOLIN_SUB_PART[section];
  const parsedSubParts = parseSubParts(record.subParts);
  // **有合法号就采信模型**，只在它一个号都没给出时才回退到按声部推导。
  //
  // 数组化之前这里的优先级是反的（声部推导**覆盖**模型输出），当时那是对的：旧前端的
  // 存储路径里带乐器名，两支小提琴缺号就会撞成同一条路径。但存储键早已是
  // `{scoreId}/{行 id}.pdf`，而反过来覆盖会**把信息压掉** —— 一份 `Violin_1,_2.pdf`
  // （IMSLP 真实存在，与 `Horn_1,_2,_3,_4.pdf` 完全同类）模型给 `[1,2]`，被压成 `[1]`：
  // 那正是本 issue 要消灭的那类错（把「含 1、2」记成「只有 1」），
  // 而且比模型犯错更隐蔽 —— 用户永远看不到模型本来给了什么。
  //
  // 冲突情形（section 是「第二小提琴」、模型却给 [1]）同样采信模型的号：两个值出自
  // **同一次**模型输出，谁对谁错这里没有依据判；而默默改成 2 等于把「模型读到了 1」
  // 这个观测抹掉。界面两个字段都显示，用户一眼能看出不自洽。
  const subParts = parsedSubParts.length > 0
    ? parsedSubParts
    : violinSubPart !== undefined
      ? [violinSubPart]
      : [];

  // 模型给了号、但我们一个都没解析出来 —— 必须让调用方看得见，理由见 subPartsRaw 的注释
  const subPartsRaw =
    parsedSubParts.length === 0 && providedSubParts(record.subParts)
      ? describeRaw(record.subParts)
      : undefined;

  // 序号从两处取：模型自己给的 `subParts`（优先，见上），或声部名（`VIOLIN_SUB_PART`）。
  // 两处都给不出时就是空数组 —— 交回给模型/用户，不再为此弃权（2026-09-25）。
  //
  // ⚠️ 这一段的旧版本描述的是一道 `ambiguous-violin` 弃权（已删），
  // 其中的 `sectionRaw &&` 条件也随之作废 —— 别照着找那段 if。
  return {
    section,
    instrument,
    subParts,
    // 主声部已经定了才轮到它 —— 由 section 反推，所以传的是上面那个**已校验**的 section
    extraSections: parseExtraSections(record.extraSections, section),
    evidence,
    isFullScore: false,
    evidenceFound,
    evidenceFromFileName,
    ...(sectionRaw ? { sectionRaw } : {}),
    ...(subPartsRaw ? { subPartsRaw } : {}),
  };
}

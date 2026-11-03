// ==UserScript==
// @name         学习通自动学习助手
// @namespace    https://scriptcat.org/scripts/chaoxing-auto-study
// @version      4.0.1
// @description  自动播放学习通/超星课程视频、解码 font-cxsecret 混淆字体、自动完成视频弹题与章节测验、自动跳转下一任务点，可接入 DeepSeek / OpenCode Go 答题。适配脚本猫(ScriptCat)、油猴(Tampermonkey)、暴力猴(Violentmonkey)。
// @author       学习通助手
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.julym.com
// @connect      api.deepseek.com
// @connect      opencode.ai
// @connect      ananas.chaoxing.com
// @connect      chaoxing.com
// @run-at       document-start
// ==/UserScript==

/*
 * v2.0.0 相对 v1.5.9 的关键改动（依据 2026-10 调研，见仓库内《学习通自动化调研报告.md》）：
 *
 *  1. 完播优先：达标阈值 90% → 98%，且末段必须自然播放，不再用 currentTime 补满。
 *     原因：平台"完整观看才判定任务点通过"，官方客户端播完才上报 isdrag=4(complete)，
 *           90% 跳节会永远跳过该事件。见报告 §4.1 / §6.3。
 *  2. 字体反爬解码：新增 FONT 模块，解析 font-cxsecret 动态混淆字体并还原题面。
 *     原因：题面字符被字形重映射，不解码则 AI 在错字上答题且无法自知。见报告 §0.2。
 *  3. 倍速硬上限 2x：>2x 是平台明确的高回滚区。见报告 §5.1-B。
 *  4. 单端纪律：检测同账号其它标签页在播放时主动让路，避免"多终端同时学习"判定。
 *     原因：多端并发是明确高危项，可能清空进度。见报告 §9。
 *  5. 保留原生上报链路：绝不自己伪造 multimedia/log 心跳（自算 enc 出错反而是硬异常证据）。
 */

(function () {
  'use strict';

  /* ============================================================
   * 一、配置
   * ============================================================ */
  const DEFAULTS = {
    enabled: true,
    speed: 1,                 // 默认 1x（最保守）
    maxSpeed: 2,              // 硬上限：平台官方支持 ≤2x，>2x 会清空已完成任务点
    speedList: [1, 1.25, 1.5, 1.75, 2],
    mute: true,
    autoPlay: true,
    autoNext: true,

    // ---- 完播判定 ----
    nextAtPercent: 98,        // 达标阈值：必须接近完播，90 会跳过 complete 事件
    requireEnded: true,       // 优先等待 ended（真播完）再跳
    completeDelay: 5000,      // 播完后等待多久再跳，留给平台上报
    endedFallbackMs: 20000,   // 到 99.5% 后仍无 ended，最多等这么久就兜底跳转
    jumpRetryDelay: 30000,
    minWatchSeconds: 30,
    thresholdDelay: 15000,    // 达标后继续自然播放多久再跳（不 seek）

    // ---- 每日上限 / 分天完成（t8；依据 research/daily-limit.md）----
    // 平台日上限是**唯一有逐字文案支撑**的硬信号：.maskDiv.jobCountDiv 里的
    // 「今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点」。
    // 阈值（每天到底多少个）查不到，所以只能识别、不能预设数字。
    detectPlatformDailyLimit: true,
    /* 分天（spreadDays）**不做自动估算**，保留这一行是给后人的说明：
     * "分天"的依据（A 级公文「学习周期至少一周以上」）比"每日个数"强，但脚本只能控制**单次运行**，
     * 强制不了跨天行为；自动估算出来的天数只会制造新的错误期望。
     * 因此：面板只给预设（关/8/12/20），分天建议写在 README，不写自动估算逻辑。 */
    // 本地软限制：**默认 0 = 关闭**。没有任何平台依据，强推阈值只会误伤正常用户；
    // 面板里提供 8/12/20 的预设按钮，并注明"无平台依据，基于公文与社区经验的保守值"。
    dailyTaskLimit: 0,
    // 播完先等平台的完成标记（.icon_Completed / .ans-job-finished）再跳：
    // video.ended ≠ 任务点已记录（real-video.md §6），没记录就重播一次，再没有才硬跳（防止卡死）。
    waitForCompletion: true,
    completionTimeoutMs: 30000,
    completionMaxRetry: 1,
    // 分页考试的页数上限（防死循环）。默认 50；测试用 2/3 的小值覆盖"到达上限即停止"这条路径
    examMaxPages: 50,
    reloadAfterNext: false,
    reloadDelay: 2500,

    /* ---- 非视频任务点（文档 / PPT / 音频）----
     * 新版任务点容器是 `.ans-attach-ct:has(.ans-job-icon)`，视频任务点额外带 `ans-job-video`；
     * 其余类型（文档 / PPT / 音频）只有滚动阅读或播放才会被平台记录。
     * 旧版脚本完全不处理它们 —— 典型症状是"视频都刷完了，任务点还是 0/10"。
     * 节奏刻意放慢：每次滚动约 0.9 屏、间隔 1.2 秒。瞬间读完是最典型的机器特征。 */
    docTask: true,
    docScrollRatio: 0.9,
    docScrollIntervalMs: 1200,

    /* ---- 人脸识别 ----
     * 平台要求人脸核验时，正确做法是**停下来等人**，不是想办法过掉。
     * 检测到就暂停自动推进、在面板写明原因，避免"人不在、视频继续、任务点被判无效"。 */
    pauseOnFace: true,

    /* ---- 播放控制节流（v3.2.2）----
     * 旧实现每 tick（1s）都 play()+点播放按钮抢控制权：
     * 平台一自己暂停（风控页 / 记录延迟 / 播放器重载）就变成每秒一次的播放-暂停拉锯。
     * 这是最像机器人的行为，已因此触发过风控。现在限制间隔并允许放弃。 */
    controlGapMs: 4000,

    /* ---- 抖动自检（v4.0）----
     * 3.2.2 修的是「每秒抢控制权」这个具体成因，但后续任何改动都可能重新引入抖动。
     * 与其靠人盯，不如让脚本自己发现「我是不是在抽风」并熔断：
     * 60 秒窗口内 play/pause 切换超过 flapMaxPerMin 次 → 自动停止并写明原因。 */
    flapMaxPerMin: 12,

    /* ---- 音频任务点（v4.0）----
     * 真正需要播放的音频任务点，只滚动是推不动的。限频沿用 controlGapMs。 */
    audioTask: true,

    /* ---- 断点续刷（v3.2）----
     * 刷新 / 重进课程列表后，自动跳回上次所在的小节。
     * 用 chapterId 做身份（不靠文案，文案会随平台改版变化）。 */
    resume: true,
    resumeMaxAgeHours: 12,   // 超过该时长不再自动跳回，避免隔几天突然跳到旧节

    /* ---- 课程链（v3.2）----
     * 一门课刷完（目录里没有下一节）后，回课程列表进入下一门**没进过**的课。
     * 默认关闭：跨课程自动操作影响面更大，按本项目"保守默认"的惯例需要显式开启。
     * 开启方式：把下面 false 改成 true，或面板里后续版本提供的开关。 */
    courseChain: false,
    courseChainMaxAgeMin: 5,  // 从"本课结束"到"进下一门"的有效窗口（分钟）

    /* ---- 空小节自动跳过（v3.2.1）----
     * 有些目录节点打开后 cards 里就是「暂无内容」（老师未发布 / 未开放）。
     * 这种页面既没有视频也没有题目，**没有任何事件能触发 goNext**，脚本会永远停在里面 ——
     * 这是实测踩到的：自动跳到 2.1 后，cards 文本就是「暂无内容」，进度彻底停住。
     * 判据：cards 就绪 + 无任务点容器 + 无题目 + 无 video + 文案含「暂无内容」。
     * 频率上限是刚需：若整章都未发布，无上限会连环跳 —— 那是最像机器人的行为。 */
    skipEmptySection: true,
    emptyWaitMs: 8000,
    emptyMaxJumps: 5,
    emptyWindowMin: 10,

    // ---- 弹题 ----
    solveQuiz: true,
    submitDelay: 1200,
    answerSource: 'local',
    apiUrl: 'https://api.julym.com/class/damn.php?question={q}',
    fallback: 'first',

    // ---- 字体反爬解码 ----
    fontDecode: true,         // 是否启用 font-cxsecret 解码
    fontConfidence: 0.72,     // 字形匹配最低置信度，低于此值保留原文并记警告
    skipAnswerIfFontFail: true, // 解码失败时拒绝答题：宁可不答，也不在错字上答（防污染题库）
    fontBatch: 120,           // 基准字形分批渲染的批大小

    // ---- AI 答题 ----
    aiEnabled: true,
    aiApiKey: '',
    aiProvider: 'deepseek',   // deepseek | opencode-go | custom
    aiBaseUrl: 'https://api.deepseek.com',
    aiModel: 'deepseek-flash',
    aiTimeout: 15000,
    aiMaxTokens: 256,
    aiCache: true,
    /* 解析失败重试：模型偶尔不听话（输出解释、带标点），第一次解析不出答案时
     * 用更严格的指令重问一次，比直接走随机兜底强得多。 */
    aiRetryOnParseFail: true,
    /* 多采样投票：同一题问 N 次（第一次 temperature=0，其余 0.3），取多数答案。
     * 这是提升准确率最有效的手段之一，代价是 token 变成 N 倍。
     * 0 = 关闭（只问一次，最省）；建议 3（成本 3x，准确率提升明显）。 */
    aiVoteSamples: 0,
    aiPrompt:
      '你是课程答题助手。根据题目和选项给出正确答案。\n' +
      '严格要求：\n' +
      '1. 单选题：只输出一个选项字母，如 A\n' +
      '2. 多选题：输出**全部**正确选项的字母，按字母顺序连写，如 ABD（不要只给一个）\n' +
      '3. 判断题：只输出「对」或「错」\n' +
      '4. 填空题：按空格顺序输出答案，多个空用 | 分隔，只给答案本身\n' +
      '5. 即使不确定，也必须给出最可能的答案，绝不解释、绝不输出「无法确定」\n' +
      '6. 不要输出题号、标点、括号或任何多余字符',

    // ---- 章节测验 / 作业 ----
    solveWork: true,          // 自动作答章节测验/作业（题目页检测到就答）
    autoSubmitQuiz: true,     // 章节测验自动提交（可重做，取最高分，风险低）
    autoSubmitWork: false,    // 作业自动提交（通常只有一次机会，默认关）
    // 保留字段；**考试提交在 allow 判定里硬禁**（kind==='exam' 直接 false），改这个值无效
    autoSubmitExam: false,
    autoConfirmSubmit: true,  // 提交后自动点"确定"确认框
    autoNextAfterWork: true,  // 提交成功后自动跳下一节
    workSubmitDelay: 3000,    // 作答完成后等多久再提交(ms)
    safeMode: true,           // 安全模式：禁止自动提交作业/考试（测验不受影响）

    // ---- 分题型答题策略（t4；依据 research/real-dom.md §3）----
    // 客观题（单选/多选/判断）：本来就能可靠落点，默认作答
    answerObjective: true,
    // 填空题：多空答案用 | 分隔；分段数与空位数对不上就放弃该题（不猜）
    answerFill: true,
    // 简答/名词解释/论述：默认不作答——AI 写的长文本风险高，且平台常需人工批阅
    answerSubjective: false,
    // 计算题：默认不作答（同上，过程分靠运气）
    answerCalc: false,
    // 无答案时的兜底：默认随机选一个，而不是固定第一个（"全选 A"是明显的机械化特征）
    fallbackRandom: true,

    // ---- 单端纪律 ----
    singleSession: true,      // 检测到同账号其它标签在播放时主动让路
    sessionBeatMs: 2000,      // 心跳间隔
    sessionStaleMs: 8000,     // 超过这么久没心跳视为已关闭

    // ---- 拟人化（降低行为序列可检测性，见调研报告 §6.5 / P1-9）----
    // humanize 是总开关：关掉后"随机暂停 + 作息时段限制"必须整体失效。
    // 面板文案与两处闸门都读它（t14/F1：之前注释承诺了总开关，代码却只看 activeHours）。
    humanize: true,
    // 随机暂停与作息时段是两个目标相反的东西，必须能分开开关（t15/A）：
    //   随机暂停是"伪装"，但实测（research/real-video.md §8）它会压低 playingTime/墙钟，
    //   叠加 ≥90% 口径可能不判通过；作息时段是纯保护，没有通过率代价。
    // 所以允许「只要时段保护、不要随机暂停」：humanizePause:false + activeHours 保留。
    humanizePause: true,
    humanizePauseChance: 0.0005, // 每个 tick(≈1s) 触发一次随机暂停的概率；0.0005 ≈ 平均 33 分钟一次
    humanizePauseMin: 3,      // 随机暂停最短秒数（模拟人离开座位）
    humanizePauseMax: 15,     // 随机暂停最长秒数
    // 暂停占比硬上限：累计暂停秒数 / 已播秒数。超过就不再暂停。
    // 为什么要有：服务端按真实墙钟核对观看时长，暂停越多有效观看率越低（撞 ≥90% 口径）。
    humanizePauseBudget: 0.05,
    // 两次随机暂停的最小间隔（秒）。0.0005/tick 只是概率，加间隔后频率才真正可控。
    // 0 = 不限制间隔（可能刚恢复就再次暂停，由 humanizePauseBudget 占比闸门兜底）；默认 180 秒。
    humanizeMinGapSec: 180,
    // 暂停结束后多久校验 currentTime 是否推进（毫秒）；不推进先点播放按钮，再不推进就告警。
    humanizeResumeCheckMs: 2500,
    // 只在这些小时里学习（平台把"凌晨连续播放"当异常行为）；受 humanize 总开关约束。
    // '' / null = 全天不限；跨午夜写 '22-6'；支持 '7:30-23:00' 与 { start, end }。
    activeHours: '7-23',

    // ---- 日志 ----
    logEnabled: true,
    logMax: 500,

    // ---- 调试 ----
    debugBadge: false,        // 默认关闭：徽标是零成本可检测的 DOM 指纹（见报告 §6.5）
    verbose: false,
  };

  const BUILTIN_BANK = {
    // '以下关于计算机网络的描述，正确的是': 'A',
  };

  /* ============================================================
   * 二、环境与存储
   * ============================================================ */
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const doc = win.document;

  const IS_TOP = (() => {
    try { if (win.self === win.top) return true; } catch (e) { /* 继续 */ }
    try { return win.top.location.href === win.location.href; } catch (e) { return false; }
  })();

  const store = {
    get(key) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, undefined);
        const raw = localStorage.getItem('cxas_' + key);
        return raw ? JSON.parse(raw) : undefined;
      } catch (e) { return undefined; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, val);
        else localStorage.setItem('cxas_' + key, JSON.stringify(val));
      } catch (e) { /* 忽略 */ }
    },
  };

  const CFG = Object.assign({}, DEFAULTS, store.get('cfg') || {});
  // 硬性纠正：任何历史配置都不能突破安全边界
  CFG.maxSpeed = DEFAULTS.maxSpeed;
  CFG.speed = Math.min(Math.max(1, Number(CFG.speed) || 1), CFG.maxSpeed);
  CFG.nextAtPercent = Math.min(Math.max(50, Number(CFG.nextAtPercent) || 98), 100);
  // 拟人化参数兜底：写错的配置不能让脚本卡在"永远暂停"或"每秒暂停"里，夹到可用区间
  CFG.humanizePauseChance = Math.max(0, Math.min(0.05, Number(CFG.humanizePauseChance) || 0));
  CFG.humanizePauseMin = Math.max(1, Math.min(600, Number(CFG.humanizePauseMin) || 3));
  CFG.humanizePauseMax = Math.max(
    CFG.humanizePauseMin,
    Math.min(600, Number(CFG.humanizePauseMax) || 15)
  );
  // 分开关与闸门参数：0 是合法值（= 永不暂停 / 无最小间隔），所以用 isFinite 而不是 || 默认值
  CFG.humanizePause = CFG.humanizePause !== false;                  // 只认显式 false，避免历史配置误伤
  const nBudget = Number(CFG.humanizePauseBudget);
  CFG.humanizePauseBudget = Math.max(0, Math.min(0.5, isFinite(nBudget) ? nBudget : 0.05));
  const nGap = Number(CFG.humanizeMinGapSec);
  CFG.humanizeMinGapSec = Math.max(0, Math.min(3600, isFinite(nGap) ? nGap : 180));
  const nCheck = Number(CFG.humanizeResumeCheckMs);
  CFG.humanizeResumeCheckMs = Math.max(200, Math.min(15000, isFinite(nCheck) ? nCheck : 2500));
  const saveCfg = () => store.set('cfg', CFG);

  /* ============================================================
   * 每日上限 / 分天完成（t8，依据 research/daily-limit.md）
   * ------------------------------------------------------------
   * 三条调研结论决定这里做什么、不做什么：
   *   1) 平台**确实**有日上限，但阈值查不到（七类来源全无数字）→ 只能识别提示，不能预设数字；
   *   2) 超限是"静默不计分"（视频照播、任务点不绿），不识别它就会被误当成完播判定 bug；
   *   3) 单日分钟数上限没有公开规则 → 本板块不做分钟限制。
   * 所以：A 段（平台硬信号）是真正的安全阀；B 段（本地软限）默认关闭，只是可选的自我约束。
   * ============================================================ */

  /* B 段的存储：key 必须是独立的 cxas_daily，绝不和 cxas_epoch / cxas_jump_guard 混用
   * （那两个是跳转守卫，混用会互相覆盖）。日期边界用**本地时间**，不能用 toISOString。 */
  const DAILY = (() => {
    const KEY = 'cxas_daily';
    function readRaw() {
      try { if (typeof GM_getValue === 'function') return GM_getValue(KEY, null); } catch (e) { /* 忽略 */ }
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }
    function writeRaw(v) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(KEY, v); return; }
      } catch (e) { /* 忽略 */ }
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
    }
    function todayKey(now) {
      const d = new Date(now == null ? Date.now() : now);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return d.getFullYear() + '-' + mm + '-' + dd;   // 本地日期，不用 toISOString
    }
    function load(now) {
      const key = todayKey(now);
      const raw = readRaw();
      if (!raw || raw.date !== key) {
        // 跨天：计数归零（本地记录，不代表平台是否重置——平台那边要重新探测提示是否消失）
        return { date: key, count: 0, sections: [] };
      }
      return {
        date: key,
        count: Number(raw.count) || 0,
        sections: Array.isArray(raw.sections) ? raw.sections.slice() : [],
      };
    }
    function limitOf() {
      const n = Number(CFG.dailyTaskLimit);
      return isFinite(n) && n > 0 ? Math.floor(n) : 0;   // 0 = 关闭（默认）
    }
    function state(now) {
      const rec = load(now);
      const lim = limitOf();
      return { date: rec.date, count: rec.count, limit: lim, reached: lim > 0 && rec.count >= lim };
    }
    function limitReached(now) {
      return state(now).reached;
    }
    /* 只在"当前节出现平台完成标记"时调用；同一节只计一次（按章节标识去重，不按 tick 累加）。 */
    function markSection(sectionId, now) {
      if (!sectionId) return { counted: false, reason: 'no-id', rec: load(now) };
      const rec = load(now);
      if (rec.sections.indexOf(sectionId) >= 0) return { counted: false, reason: 'dup', rec };
      rec.sections.push(sectionId);
      rec.count += 1;
      writeRaw(rec);
      return { counted: true, reason: 'ok', rec };
    }
    function reset(now) {
      const rec = { date: todayKey(now), count: 0, sections: [] };
      writeRaw(rec);
      return rec;
    }
    return { KEY, todayKey, load, state, limitReached, markSection, reset, limitOf };
  })();

  /* A 段：平台日上限。三条件**必须同时满足**：元素存在 + 文案逐字匹配 + 可见（宽高 > 0）。
   * 接受可选的 docs 参数，便于单元测试注入假文档（默认 allDocs()）。 */
  function platformDailyLimitHit(docs) {
    if (!CFG.detectPlatformDailyLimit) return false;
    const list = docs || allDocs();
    for (const d of list) {
      try {
        const els = d.querySelectorAll('.maskDiv.jobCountDiv, .jobCountDiv');
        for (const el of els) {
          if (!/今日视频任务点完成数已达上限/.test(String(el.textContent || ''))) continue;
          if (visibleIn(el)) return true;
        }
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  /* C 段：计数口径用"平台完成标记"，不是 video ended。
   * 权威顺序：目录当前行的 .icon_Completed（实时）→ 卡片内 .ans-job-finished。
   * 只认**当前节**的标记，避免把上一节的完成图标算进来。 */
  function currentCatalogNode(docs) {
    const list = docs || allDocs();
    for (const d of list) {
      try {
        const nodes = Array.from(d.querySelectorAll('.posCatalog .chapter_item, .posCatalog_select .chapter_item, .chapter_item'));
        if (!nodes.length) continue;
        const cur = nodes.find((n) =>
          // 新版目录当前小节用 id=cur<chapterId> 标记，没有 class 可用（见 research/real-video.md）
          (n.id && /^cur\d/.test(n.id)) ||
          (n.classList &&
            (n.classList.contains('currents') || n.classList.contains('current') || n.classList.contains('active'))));
        if (cur) return cur;
      } catch (e) { /* 跨域 */ }
    }
    return null;
  }

  function currentSectionKey() {
    const cur = currentCatalogNode();
    if (cur) {
      const t = String(cur.textContent || '').replace(/\s+/g, '');
      if (t) return 'sec:' + t.slice(0, 40);
    }
    try { return 'url:' + (location.href || ''); } catch (e) { return 'url:'; }
  }

  /* 新版学习通（mooc-ans 的 cards 页）用 .ans-job-icon 表达任务点状态：
   * 未完成时带 `ans-job-icon-clear`，完成后该 class 消失。
   * 老版是 .icon_Completed / .ans-job-finished。两套都认，避免新版永远判"未完成"
   * → waitForCompletion 白等 30 秒再硬跳。
   * 返回 false 表示"没看到任务点图标"，由上层其它判据决定，不代表已完成。 */
  function jobIconsFinished(docs) {
    const list = docs || allDocs();
    for (const d of list) {
      try {
        const icons = d.querySelectorAll('.ans-job-icon');
        for (const ic of icons) {
          /* v4.0：aria-label / title 作为第二信号。
           * 依据：同赛道实测发现单靠 class 会**双向**误判（已完成不摘 -clear、未完成却丢了 -clear 都有）。
           * 顺序要紧：先判「未完成」，否则 /完成/ 会把「未完成」也匹配上。 */
          let aria = '';
          try {
            aria = String((ic.getAttribute && (ic.getAttribute('aria-label') || ic.getAttribute('title'))) || '');
          } catch (e) { aria = ''; }
          if (/未完成|未看|未学/.test(aria)) continue;
          if (/已完成|完成|已看/.test(aria)) return true;
          if (!ic.classList.contains('ans-job-icon-clear')) return true;
        }
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  function sectionCompleted(docs) {
    const list = docs || allDocs();
    const cur = currentCatalogNode(list);
    if (cur) {
      try {
        if (cur.querySelector('.icon_Completed')) return true;
        if (cur.querySelector('.orangeNew')) return false;   // 旧版：有这个就是未完成
      } catch (e) { /* 忽略 */ }
    }
    for (const d of list) {
      try { if (d.querySelector('.ans-job-finished')) return true; } catch (e) { /* 跨域 */ }
    }
    return jobIconsFinished(list);
  }

  let platformLimitLogged = false;
  // t28/F2：本次运行的计数口径——基线只做一次；preCompleted 里的节永不计数；已计过的节不重复
  let dailyBaselineDone = false;
  const preCompletedSections = new Set();
  const dailyCountedSections = new Set();
  /* t29/F1：lastAction 是单值字段，多模块写入会互相覆盖（同类问题已出现三次：
   * 作息时段文案、平台日上限文案、98% 进度文案）。
   * 轻量锁：关键态（平台日上限、作答异常）置锁后，普通进度提示不再覆盖它；
   * 关键条件解除时用 force 写回一条并释放锁（不用引入完整的事件/优先级框架）。 */
  let actionLocked = false;
  function setAction(msg, opts) {
    const o = opts || {};
    if (actionLocked && !o.lock && !o.force) return false;
    stats.lastAction = msg;
    actionLocked = !!o.lock;
    return true;
  }

  /* 每 tick 跑一次：维护平台日上限状态 + 本地计数（同一节只 +1）。 */
  function tickDaily() {
    const hit = platformDailyLimitHit();
    stats.platformLimit = hit;
    if (hit) {
      if (!platformLimitLogged) {
        platformLimitLogged = true;
        setAction('平台提示：今日视频任务点完成数已达上限，已停止自动跳转（明日先探测该提示是否消失）', { lock: true });
        warn(stats.lastAction);
        log('检测到 .maskDiv.jobCountDiv 日上限提示，停止自动跳转');
      }
      return;
    }
    if (platformLimitLogged) {
      platformLimitLogged = false;
      setAction('平台日上限提示已消失，恢复自动跳转', { force: true });
      log(stats.lastAction);
    }
    /* t28/F2：只统计**本次运行中处理过**的节。
     * 页面一加载时就已完成的节（昨天看完的、回看老节）不能算进今天：
     * 第一次 tick 只做基线，把"启动时已完成"的当前节记进 preCompleted；此后同一节不再计数。 */
    const id = currentSectionKey();
    if (!dailyBaselineDone) {
      dailyBaselineDone = true;
      if (sectionCompleted()) {
        preCompletedSections.add(id);
        stats.lastAction = '当前节在启动时已完成（历史记录），不计入今日计数';
        log(stats.lastAction);
      }
      return;
    }
    if (!sectionCompleted()) return;
    if (preCompletedSections.has(id)) return;   // 历史已完成的节：永远不计
    if (dailyCountedSections.has(id)) return;   // 本次运行已计过：不重复
    dailyCountedSections.add(id);
    const r = DAILY.markSection(id);
    stats.dailyCount = r.rec.count;
    if (r.counted) {
      stats.lastAction = '检测到平台完成标记，本地计数 +1（今日 ' + r.rec.count +
        (DAILY.limitOf() ? ' / ' + DAILY.limitOf() : '') + '）';
      log(stats.lastAction);
    }
  }

  const log = (...a) => { if (CFG.verbose) console.log('[学习通助手]', ...a); };
  const warn = (...a) => console.warn('[学习通助手]', ...a);

  log('注入成功', IS_TOP ? '(顶层)' : '(子框架)', location.host, location.pathname);

  const stats = {
    video: false, quiz: 0, work: 0, speed: 0, progress: 0,
    lastAction: '待命中', fontStatus: '未启用', fontMapped: 0, fontMiss: 0,
    lastScore: null,          // 最近一次提交后从页面读到的真实分数（唯一能验证准确率的信号）
    lastScoreAt: 0,
    humanize: '',             // 拟人化状态（跨 iframe 中继给顶层面板显示）
    humanizeUsage: '',        // 暂停台账：已用/上限秒数与次数（跨 iframe 中继）
    doc: '',                  // 非视频任务点（文档 / PPT / 音频）状态文案
    face: '',                 // 人脸核验状态（检测到即暂停，等待人工完成）
    audio: '',                // 音频任务点状态（v4.0）
    flap: '',                 // 抖动自检状态（v4.0，熔断后写明次数）
    diag: '',                 // 本页任务点/题目识别诊断（v4.0）
    qtypes: '',               // 题型分布（t4：单选题3 多选题1 …，跨 iframe 中继给面板）
    qskip: 0,                 // 按题型策略跳过的题数（t22/F5）
    collected: 0,             // 已采集题数（t6 两遍法）
    answered: 0,              // 已作答题数（t6 两遍法）
    collectedAt: 0,           // 采集完成时间戳（t6：e2e 用它证明采集期零点击）
    mode: '',                 // 作答模式：two-pass / paged（t6）
    platformLimit: false,     // 平台日上限提示是否命中（t8/A，硬信号）
    dailyCount: 0,            // 本地当日任务点计数（t8/C，只按平台完成标记 +1）
    completionState: '',      // 等完成标记的状态文案（t8/D）
    completionRetries: 0,     // 当前节已重播次数（t28/F1：跨调用累计，超上限必硬跳）
    replays: 0,               // 累计重播次数（t28：可观测）
    hardJumps: 0,            // 累计硬跳次数（t28：证明硬跳出口真的会执行）
  };

  /* ============================================================
   * 三、工具函数
   * ============================================================ */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const w = (el.ownerDocument && el.ownerDocument.defaultView) || win;
    const s = w.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  // 题目归一化：去空白、去中英文标点、转小写，便于题库模糊匹配
  function norm(s) {
    return String(s || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。；：、“”‘’（）()【】\[\]<>《》?!？！.,;:'"\-_/\\]/g, '')
      .toLowerCase();
  }

  function isCourseHost() {
    return /chaoxing|chaoxing\.cn|xuexitong/i.test(location.hostname) ||
      /ananas|studentstudy|mycourse|knowledge|\/work\//i.test(location.pathname + location.search);
  }

  // 把各种可能的二进制返回统一成 ArrayBuffer。
  // 注意：跨 realm（沙箱 / iframe / 脚本管理器包装）时 instanceof ArrayBuffer 会失败，
  // 所以用 Object.prototype.toString 兜底判断，这是真实踩过的坑。
  function toArrayBuffer(x) {
    if (!x) return null;
    try {
      if (x instanceof ArrayBuffer) return x;
      if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(x)) return x.buffer;
      const tag = Object.prototype.toString.call(x);
      if (tag === '[object ArrayBuffer]') return x;
      if (tag === '[object Uint8Array]' || tag === '[object Uint8ClampedArray]') return x.buffer;
      if (x.buffer && Object.prototype.toString.call(x.buffer) === '[object ArrayBuffer]') return x.buffer;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function xhrBinary(url, timeout) {
    return new Promise((resolve) => {
      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'GET', url, timeout: timeout || 15000,
            responseType: 'arraybuffer',
            onload: (res) => {
              try { resolve(toArrayBuffer(res.response || res.responseText)); }
              catch (e) { resolve(null); }
            },
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
          });
        } else {
          fetch(url).then((r) => r.arrayBuffer()).then((b) => resolve(toArrayBuffer(b))).catch(() => resolve(null));
        }
      } catch (e) { resolve(null); }
    });
  }

  /* ---------------- 拟人化：作息时段 ----------------
   * 为什么要有：调研报告 §6.6 里"访问课程视频的天数"是最被模型看重的特征之一，
   * 凌晨 3 点连播 40 集是典型非人特征。这里只做最简单的时段闸门。
   *
   * 解析失败一律回退"全天"而不是"永远不在时段"：
   * 配置写错时宁可不管，也不能让脚本静默停摆——原因会显示在面板上。
   */
  function parseActiveHours(v) {
    if (v === null || v === undefined || v === false || v === '') return null; // 全天
    let start = NaN;
    let end = NaN;
    if (typeof v === 'object') {
      start = Number(v.start);
      end = Number(v.end);
    } else {
      // 支持 '7-23'、'7:30-23:00'、'22-6'（跨午夜）
      const m = String(v).trim().match(/^(\d{1,2})(?::(\d{1,2}))?\s*[-~—]\s*(\d{1,2})(?::(\d{1,2}))?$/);
      if (!m) return null;
      start = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
      end = Number(m[3]) + (m[4] ? Number(m[4]) / 60 : 0);
    }
    if (!isFinite(start) || !isFinite(end)) return null;
    if (start < 0 || start > 24 || end < 0 || end > 24) return null;
    if (start === 0 && end === 24) return null; // '0-24' 等价全天
    if (start === end) return null; // 起止相同没有区间意义，按全天处理
    return { start: start % 24, end: end % 24 };
  }

  function fmtHour(x) {
    const h = Math.floor(x) % 24;
    const m = Math.round((x - Math.floor(x)) * 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* 判断某个时刻是否在允许时段内。
   * range 传 null/undefined 语义不同：null = 明确全天；undefined = 读当前配置。
   * 跨午夜（start > end，如 22-6）走 h >= start || h < end 分支。 */
  function inActiveHours(range, at) {
    const r = range === undefined ? parseActiveHours(CFG.activeHours) : range;
    if (!r) return true;
    const d = at instanceof Date ? at : new Date(at === undefined ? Date.now() : at);
    const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    if (r.start < r.end) return h >= r.start && h < r.end;
    return h >= r.start || h < r.end;
  }

  // 面板文案：允许/不允许/全天/配置无法解析/总开关关闭，五种状态都要能看见
  function activeHoursLabel() {
    const raw = CFG.activeHours;
    const r = parseActiveHours(raw);
    if (!r) {
      const off = raw === null || raw === undefined || raw === false || raw === '';
      return off ? '全天（未限制）' : '全天（配置无法解析：' + String(raw).slice(0, 16) + '）';
    }
    const span = fmtHour(r.start) + '–' + fmtHour(r.end);
    // humanize 是总开关：关掉后时段不生效。面板必须说清楚，
    // 否则会出现"拟人化：关 + 因时段暂停"同屏的自相矛盾（t14/F1）。
    if (!CFG.humanize) return span + '（humanize 已关，未生效）';
    return inActiveHours(r) ? span + ' 内' : span + ' 外（已暂停播放）';
  }

  /* 时段闸门的状态位：只在"刚进入时段外"时写一次 lastAction。
   * 原因（t14/F2）：mainTick 每 tick 依次跑 tickVideo → tickQuiz → tickWork，
   * 三者都无条件写 lastAction 时，主因「已暂停播放」会被次要信息「已跳过弹题作答」覆盖，
   * 面板上只剩后者，用户看不出为什么停了。 */
  let hoursBlockedState = false;

  function hoursBlockMessage(r) {
    return '不在作息时段（' + fmtHour(r.start) + '–' + fmtHour(r.end) + '）';
  }

  // 只在状态切换时落字：同一段"时段外"期间，后到的调用不覆写先到的主因
  function markHoursBlocked(msg) {
    if (hoursBlockedState) return false;
    hoursBlockedState = true;
    stats.lastAction = msg;
    log(msg);
    return true;
  }

  /* 自动动作的时段闸门：时段外跳过自动答题/自动作答。
   * humanize 是"随机暂停 + 作息时段"的总开关，关掉后这里整体失效（t14/F1）。
   * 面板按钮仍可手动触发——那是"人在现场操作"，不该被时段限制拦住。
   * 返回值 true 表示"已跳过"，调用方直接 return。 */
  function autoHoursPaused(what) {
    if (!CFG.humanize) return false;
    const r = parseActiveHours(CFG.activeHours);
    if (!r) return false;
    if (inActiveHours(r)) { hoursBlockedState = false; return false; }
    markHoursBlocked(hoursBlockMessage(r) + '，已跳过' + what);
    return true;
  }

  /* ============================================================
   * 四、字体反爬解码（font-cxsecret）
   * ------------------------------------------------------------------
   * 原理：平台用自定义 TTF 把「真实字符的码位」映射到「别的字的字形」。
   *       DOM 里的 textContent 是码位对应的字符，但人眼看到的是另一批字。
   *       直接把 textContent 送去 AI，等于在乱码上答题。
   *
   * 做法：
   *   1) 从 @font-face 找到字体 URL，下载 TTF
   *   2) 解析 cmap 表拿到该字体覆盖的码位集合
   *   3) 用 FontFace 加载字体，Canvas 渲染每个码位的字形 → 特征向量
   *   4) 用若干基准字体渲染候选汉字 → 特征向量，逐一比对求最相似
   *   5) 建立 码位→真实字符 映射并缓存（按字体内容哈希隔离，绝不做全局字典）
   *
   * 关键设计：匹配置信度不足时【保留原文并标记失败】，绝不静默输出错字。
   *          这是调研里最惨的失效模式（"字体解密假成功"），必须可感知。
   * ============================================================ */
  const FONT = (() => {
    const GLYPH_SIZE = 20;      // 渲染画布边长
    const FEAT_SIZE = 10;       // 降采样后的特征边长（100 维）
    // 候选字：3000 常用汉字 + 标点 + 数字字母。学习通题面用字绝大多数落在此范围。
    const CANDIDATES = (
      '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪汇币丰蓝殊献桌啦瓦莱援译夺汽烧距裁偏符勇触课敬哭懂墙袭召罚侠厅拜巧侧韩冒债曼融惯享戴童犹乘挂奖绍厚纵障讯涉彻刊丈爆乌役描洗玛患妙镜唱烦签仙彼弗症仿倾牌陷鸟轰咱菜闭奋庆撤泪茶疾缘播朗杜奶季丹狗尾仪偷奔珠虫驻孔宜艾桥淡翼恨繁寒伴叹旦愈潮粮缩罢聚径恰挑袋灰捕徐珍幕映裂泰隔启尖忠累炎暂估泛荒偿横拒瑞忆孤鼻闹羊呆厉衡胞零穷舍码赫婆魂灾洪腿胆津俗辩胸晓劲贫仁偶辑邦恢赖圈摸仰润堆碰艇稍迟辆废净凶署壁御奉旋冬矿抬蛋晨伏吹鸡倍糊秦盾杯租骑乏隆诊奴摄丧污渡旗甘耐凭扎抢绪粗肩梁幻菲皆碎宙叔岩荡综爬荷悉蒂返井壮薄悄扫敏碍殖详迪矛霍允幅撒剩凯颗骂赏液番箱贴漫酸郎腰舒眉忧浮辛恋餐吓挺励辞艘键伍峰尺昨黎辈贯侦滑券崇扰宪绕趋慈乔阅汗枝拖墨胁插箭腊粉泥氏彭拔骗凤慧媒佩愤扑龄驱惜豪掩兼跃尸肃帕驶堡届欣惠册储飘桑闲惨洁踪勃宾频仇磨递邪撞拟滚奏巡颜剂绩贡疯坡瞧截燃焦殿伪柳锁逼颇昏劝呈搜勤戒驾漂饮曹朵仔柔俩孟腐幼践籍牧凉牲佳娜浓芳稿竹腹跌逻垂遵脉貌柏狱猜怜惑陶兽帐饰贷昌叙躺钢沟寄扶铺邓寿惧询汤盗肥尝匆辉奈扣廷澳嘛董迁凝慰厌脏腾幽怨鞋丢埋泉涌辖躲晋紫艰魏吾慌祝邮吐狠鉴曰械咬邻赤挤弯椅陪割揭韦悟聪雾锋梯猫祥阔誉筹丛牵鸣沈阁穆屈旨袖猎臂蛇贺柱抛鼠瑟戈牢逊迈欺吨琴衰瓶恼燕仲诱狼池疼卢仗冠粒遥吕玄尘冯抚浅敦纠钻晶岂峡苍喷耗凌敲菌赔涂粹扁亏寂煤熊恭湿循暖糖赋抑秩帽哀宿踏烂袁侯抖夹昆肝擦猪炼恒慎搬纽纹玻渔磁铜齿跨押怖漠疲叛遣兹祭醉拳弥斜档稀捷肤疫肿豆削岗晃吞宏癌肚隶履涨耀扭坛拨沃绘伐堪仆郭牺歼墓雇廉契拼惩捉覆刷劫嫌瓜歇雕闷乳串娃缴唤赢莲霸桃妥瘦搭赴岳嘉舱俊址庞耕锐缝悔邀玲惟斥宅添挖呵讼氧浩羽斤酷掠妖祸侍乙妨贪挣汪尿莉悬唇翰仓轨枚盐览傅帅庙芬屏寺胖璃愚滴疏萧姿颤丑劣柯寸扔盯辱匹俱辨饿蜂哦腔郁溃谨糟葛苗肠忌溜鸿爵鹏鹰笼丘桂滋聊挡纲肌茨壳痕碗穴膀卓贤卧膜毅锦欠哩函茫昂薛皱夸豫胃舌剥傲拾窝睁携陵哼棉晴铃填饲渴吻扮逆脆喘罩卜炉柴愉绳胎蓄眠竭喂傻慕浑奸扇柜悦拦诞饱乾泡贼亭夕爹酬儒姻卵氛泄杆挨僧蜜吟猩遂狭肖甜霞驳裕顽於摘矮秒卿畜咽披辅勾盆疆赌塑畏吵囊嗯泊肺骤缠冈羞瞪吊贾漏斑涛悠鹿俘锡卑葬铭滩嫁催璇翅盒蛮矣潘歧赐鲍锅廊拆灌勉盲宰佐啥胀扯禧辽抹筒棋裤唉朴咐孕誓喉妄拘链驰栏逝窃艳臭纤玑棵趁匠盈翁愁瞬婴孝颈倘浙谅蔽畅赠妮莎尉冻跪闯葡後厨鸭颠遮谊圳吁仑辟瘤嫂陀框谭亨钦庸歉芝吼甫衫摊宴嘱衷娇陕矩浦讶耸裸碧摧薪淋耻胶屠鹅饥盼脖虹翠崩账萍逢赚撑翔倡绵猴枯巫昭怔渊凑溪蠢禅阐旺寓藤匪伞碑挪琼脂谎慨菩萄狮掘抄岭晕逮砍掏狄晰罕挽脾舟痴蔡剪脊弓懒叉拐喃僚捐姊骚拓歪粘柄坑陌窄湘兆崖骄刹鞭芒筋聘钩棍嚷腺弦焰耍俯厘愣厦恳饶钉寡憾摔叠惹喻谱愧煌徽溶坠煞巾滥洒堵瓷咒姨棒郡浴媚稣淮哎屁漆淫巢吩撰啸滞玫硕钓蝶膝姚茂躯吏猿寨恕渠戚辰舶颁惶狐讽笨袍嘲啡泼衔倦涵雀旬僵撕肢垄夷逸茅侨舆窑涅蒲谦杭噢弊勋刮郊凄捧浸砖鼎篮蒸饼亩肾陡爪兔殷贞荐哑炭坟眨搏咳拢舅昧擅爽咖搁禄雌哨巩绢螺裹昔轩谬谍龟媳姜瞎冤鸦蓬巷琳栽沾诈斋瞒彪厄咨纺罐桶壤糕颂膨谐垒咕隙辣绑宠嘿兑霉挫稽辐乞纱裙嘻哇绣杖塘衍轴攀膊譬斌祈踢肆坎轿棚泣屡躁邱凰溢椎砸趟帘帆栖窜丸斩堤塌贩厢掀喀乖谜捏阎滨虏匙芦苹卸沼钥株祷剖熙哗劈怯棠胳桩瑰娱娶沫嗓蹲焚淘嫩韵衬匈钧竖峻豹捞菊鄙魄兜哄颖镑屑蚁壶怡渗秃迦旱哟咸焉谴宛稻铸锻伽詹毙恍贬烛骇芯汁桓坊驴朽靖佣汝碌迄冀荆崔雁绅珊榜诵傍彦醇笛禽勿娟瞄幢寇睹贿踩霆呜拱妃蔑谕缚诡篷淹腕煮倩卒勘馨逗甸贱炒灿敞蜡囚栗辜垫妒魁谣寞蜀甩涯枕丐泳奎泌逾叮黛燥掷藉枢憎鲸弘倚侮藩拂鹤蚀浆芙垃烤晒霜剿蕴圾绸屿氢驼妆捆铅逛淑榴丙痒钞蹄犬躬昼藻蛛褐颊奠募耽蹈陋侣魅岚侄虐堕陛莹荫狡阀绞膏垮茎缅喇绒搅凳梭丫姬诏钮棺耿缔懈嫉灶匀嗣鸽澡凿纬沸畴刃遏烁嗅叭熬瞥骸奢拙栋毯桐砂莽泻坪梳杉晤稚蔬蝇捣顷麽尴镖诧尬硫嚼羡沦沪旷彬芽狸冥碳咧惕暑咯萝汹腥窥俺潭崎麟捡拯厥澄萎哉涡滔暇溯鳞酿茵愕瞅暮衙诫斧兮焕棕佑嘶妓喧蓉删樱伺嗡娥梢坝蚕敷澜杏绥冶庇挠搂倏聂婉噪稼鳍菱盏匿吱寝揽髓秉哺矢啪帜邵嗽挟缸揉腻驯缆晌瘫贮觅朦僻隋蔓咋嵌虔畔琐碟涩胧嘟蹦冢浏裔襟叨诀旭虾簿啤擒枣嘎苑牟呕骆凸熄兀喔裳凹赎屯膛浇灼裘砰棘橡碱聋姥瑜毋娅沮萌俏黯撇粟粪尹苟癫蚂禹廖俭帖煎缕窦簇棱叩呐瑶墅莺烫蛙歹伶葱哮眩坤廓讳啼乍瓣矫跋枉梗厕琢讥釉窟敛轼庐胚呻绰扼懿炯竿慷虞锤栓桨蚊磅孽惭戳禀鄂馈垣溅咚钙礁彰豁眯磷雯墟迂瞻颅琉悼蝴拣渺眷悯汰慑婶斐嘘镶炕宦趴绷窘襄珀嚣拚酌浊毓撼嗜扛峭磕翘槽淌栅颓熏瑛颐忖'
    ).split('');

    const PUNCT = '，。、；：？！“”‘’（）《》—…·,.;:?!()<>-'.split('');
    const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
    const POOL = CANDIDATES.concat(PUNCT, ALNUM);

    // 基准字体：黑体 + 宋体 + 系统无衬线。cxsecret 的字形通常源自其中一种，
    // 多字体投票能显著提升鲁棒性（任一字形只要在某基准字体下高度相似即可）。
    const BASE_FONTS = [
      '20px "Microsoft YaHei"',
      '20px "SimHei"',
      '20px "SimSun"',
      '20px sans-serif',
    ];

    let canvas = null;
    let ctx = null;
    let pool = null;                  // [{ch, feats:[Float32Array]}]
    let probeFont = null;             // '20px "<随机家族名>"'
    /* t11/D：探测字体也是指纹——以前家族名固定 'cxas_probe_<hash>'，平台/其它脚本能直接匹配。
     * 现在每次加载随机取名，并且"用完就从 document.fonts 删掉"，只在真正要匹配字形时临时 add。
     * 这样既不残留自定义 FontFace，也不会留下可匹配的固定字符串。 */
    let probeFace = null;
    let faceAdded = false;
    const randFam = () => 'p' + Math.random().toString(36).slice(2, 9) + Math.random().toString(36).slice(2, 6);

    function faceAdd() {
      if (!probeFace || faceAdded) return;
      try {
        if (doc.fonts && typeof doc.fonts.add === 'function') { doc.fonts.add(probeFace); faceAdded = true; }
      } catch (e) { /* 忽略 */ }
    }

    function faceDelete() {
      if (!probeFace || !faceAdded) return;
      try {
        if (doc.fonts && typeof doc.fonts.delete === 'function') doc.fonts.delete(probeFace);
      } catch (e) { /* 忽略 */ }
      faceAdded = false;
    }
    let fontKey = null;
    let ready = false;
    let failed = null;
    let building = null;
    let noFont = false;               // 本页是否"确实没有"混淆字体
    let urlCache = null;
    let urlCacheAt = 0;

    // 扫描样式表有一定开销，缓存几秒；字体可能是动态注入的，所以不能永久缓存
    function findFontUrlCached() {
      const now = Date.now();
      if (now - urlCacheAt < 5000) return urlCache;
      urlCache = findFontUrl();
      urlCacheAt = now;
      return urlCache;
    }

    const map = Object.create(null);      // 码位 -> 真实字符
    const conf = Object.create(null);     // 码位 -> 置信度
    const missed = Object.create(null);   // 码位 -> true（尝试过但未达阈值）

    function ensureCanvas() {
      if (canvas) return;
      canvas = doc.createElement('canvas');
      canvas.width = canvas.height = GLYPH_SIZE;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#000';
      }
    }

    // 渲染单个字形 → 归一化灰度特征（FEAT_SIZE²）
    // 减去均值 + L2 归一化，抵消整体位置与笔画粗细差异
    function glyphFeature(ch, fontSpec) {
      if (!ctx) return null;
      const S = GLYPH_SIZE;
      ctx.clearRect(0, 0, S, S);
      ctx.font = fontSpec;
      try { ctx.fillText(ch, 0, 0); } catch (e) { return null; }
      let img;
      try { img = ctx.getImageData(0, 0, S, S); } catch (e) { return null; }
      const d = img.data;
      const step = S / FEAT_SIZE;
      const f = new Float32Array(FEAT_SIZE * FEAT_SIZE);
      let sum = 0;
      for (let y = 0; y < FEAT_SIZE; y++) {
        for (let x = 0; x < FEAT_SIZE; x++) {
          let acc = 0, n = 0;
          for (let yy = 0; yy < step; yy++) {
            for (let xx = 0; xx < step; xx++) {
              const px = ((y * step + yy) | 0) * S + ((x * step + xx) | 0);
              acc += d[px * 4 + 3];
              n++;
            }
          }
          const v = acc / (n * 255);
          f[y * FEAT_SIZE + x] = v;
          sum += v;
        }
      }
      const mean = sum / f.length;
      let nrm = 0;
      for (let i = 0; i < f.length; i++) { f[i] -= mean; nrm += f[i] * f[i]; }
      nrm = Math.sqrt(nrm);
      if (nrm < 1e-6) return null;
      for (let i = 0; i < f.length; i++) f[i] /= nrm;
      return f;
    }

    function cosine(a, b) {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * b[i];
      return s;
    }

    /* ---- TTF/OTF cmap 解析 ---- */
    function parseCmap(buf) {
      const dv = new DataView(buf);
      if (buf.byteLength < 12) return [];
      const numTables = dv.getUint16(4);
      let cmapOff = -1;
      for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        if (rec + 16 > buf.byteLength) break;
        const tag = String.fromCharCode(
          dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3));
        if (tag === 'cmap') { cmapOff = dv.getUint32(rec + 8); break; }
      }
      if (cmapOff < 0 || cmapOff >= buf.byteLength) return [];

      const nSub = dv.getUint16(cmapOff + 2);
      const subs = [];
      for (let i = 0; i < nSub; i++) {
        const rec = cmapOff + 4 + i * 8;
        if (rec + 8 > buf.byteLength) break;
        const plat = dv.getUint16(rec);
        const enc = dv.getUint16(rec + 2);
        const off = cmapOff + dv.getUint32(rec + 4);
        if (off < 0 || off >= buf.byteLength) continue;
        let score = 9;
        if (plat === 3 && enc === 1) score = 0;
        else if (plat === 3 && enc === 10) score = 1;
        else if (plat === 0) score = 2;
        subs.push({ off, score });
      }
      subs.sort((a, b) => a.score - b.score);

      const codes = new Set();
      for (const s of subs) {
        try {
          const fmt = dv.getUint16(s.off);
          if (fmt === 4) readFormat4(dv, s.off, codes, buf.byteLength);
          else if (fmt === 12) readFormat12(dv, s.off, codes, buf.byteLength);
          else if (fmt === 6) readFormat6(dv, s.off, codes, buf.byteLength);
          if (codes.size) break;
        } catch (e) { /* 换下一个子表 */ }
      }
      return Array.from(codes);
    }

    function readFormat4(dv, off, out, limit) {
      const segX2 = dv.getUint16(off + 6);
      const seg = segX2 / 2;
      if (!seg || seg > 2000) return;
      const endOff = off + 14;
      const startOff = endOff + segX2 + 2;
      const deltaOff = startOff + segX2;
      const rangeOff = deltaOff + segX2;
      if (rangeOff + segX2 > limit) return;
      for (let i = 0; i < seg; i++) {
        const end = dv.getUint16(endOff + i * 2);
        const start = dv.getUint16(startOff + i * 2);
        if (start === 0xFFFF || start > end) continue;
        const delta = dv.getInt16(deltaOff + i * 2);
        const ro = dv.getUint16(rangeOff + i * 2);
        if (end - start > 8192) continue;
        for (let c = start; c <= end; c++) {
          let g;
          if (ro === 0) {
            g = (c + delta) & 0xFFFF;
          } else {
            const idx = rangeOff + i * 2 + ro + (c - start) * 2;
            if (idx + 2 > limit) continue;
            g = dv.getUint16(idx);
            if (g !== 0) g = (g + delta) & 0xFFFF;
          }
          if (g !== 0) out.add(c);
        }
      }
    }

    function readFormat12(dv, off, out, limit) {
      const n = dv.getUint32(off + 12);
      if (n > 20000) return;
      for (let i = 0; i < n; i++) {
        const rec = off + 16 + i * 12;
        if (rec + 12 > limit) break;
        const s = dv.getUint32(rec);
        const e = dv.getUint32(rec + 4);
        if (e < s || e - s > 8192) continue;
        for (let c = s; c <= e; c++) out.add(c);
      }
    }

    function readFormat6(dv, off, out, limit) {
      const first = dv.getUint16(off + 6);
      const count = dv.getUint16(off + 8);
      if (count > 8192) return;
      for (let i = 0; i < count; i++) {
        const idx = off + 10 + i * 2;
        if (idx + 2 > limit) break;
        const g = dv.getUint16(idx);
        if (g !== 0) out.add(first + i);
      }
    }

    // 从页面样式表找 font-cxsecret 的字体 URL
    function findFontUrl() {
      let hit = null;
      const scan = (rules) => {
        for (const r of rules) {
          if (hit) return;
          try {
            const isFontFace = r.type === 5 || r.constructor.name === 'CSSFontFaceRule';
            if (isFontFace && r.style) {
              const fam = (r.style.getPropertyValue('font-family') || '').replace(/['"]/g, '');
              const src = r.style.getPropertyValue('src') || '';
              if (!/cxsecret|secret/i.test(fam) && !/cxsecret/i.test(src)) continue;
              const m = src.match(/url\(["']?([^"')]+)["']?\)/);
              if (m && m[1]) { hit = { family: fam || 'font-cxsecret', url: m[1] }; return; }
            } else if (r.cssRules) {
              scan(r.cssRules);
            }
          } catch (e) { /* 跨域样式表忽略 */ }
        }
      };
      for (const sheet of Array.from(doc.styleSheets)) {
        try { scan(sheet.cssRules); } catch (e) { /* 跨域 */ }
        if (hit) break;
      }
      return hit;
    }

    // 字体内容哈希：用于按字体隔离映射（不同试卷同码位真字不同，绝不可共用）
    function hashBuf(buf) {
      const bytes = new Uint8Array(buf);
      let h = 0x811c9dc5;
      const step = Math.max(1, Math.floor(bytes.length / 4096));
      for (let i = 0; i < bytes.length; i += step) {
        h ^= bytes[i];
        h = (h * 0x01000193) >>> 0;
      }
      return h.toString(16) + '_' + bytes.length.toString(16);
    }

    function pickFonts() {
      const ok = BASE_FONTS.filter((f) => {
        try { ctx.font = f; return !!ctx.font; } catch (e) { return false; }
      });
      return ok.length ? ok : ['20px sans-serif'];
    }

    // 分批渲染基准字形池，每批让出主线程，避免长时间阻塞 UI
    async function buildPool() {
      if (pool) return pool;
      const useFonts = pickFonts();
      const out = [];
      const batch = Math.max(40, CFG.fontBatch || 120);
      for (let i = 0; i < POOL.length; i += batch) {
        const end = Math.min(i + batch, POOL.length);
        for (let j = i; j < end; j++) {
          const ch = POOL[j];
          const feats = [];
          for (const f of useFonts) {
            const v = glyphFeature(ch, f);
            if (v) feats.push(v);
          }
          if (feats.length) out.push({ ch, feats });
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      pool = out;
      return pool;
    }

    async function loadFont() {
      const found = findFontUrlCached();
      if (!found) throw new Error('未发现 cxsecret 字体');
      const buf = await xhrBinary(found.url, 20000);
      if (!buf) throw new Error('字体下载失败');
      const key = hashBuf(buf);
      if (key !== fontKey) {
        // 换字体 → 旧映射全部作废（不同试卷同码位真字不同）
        Object.keys(map).forEach((k) => delete map[k]);
        Object.keys(conf).forEach((k) => delete conf[k]);
        Object.keys(missed).forEach((k) => delete missed[k]);
        fontKey = key;
      }
      // 换字体先把旧的探测 face 从 document.fonts 摘掉，避免越积越多（t11/D）
      faceDelete();
      probeFace = null;
      const fam = randFam();      // 随机家族名：不再留 'cxas_probe_*' 这种固定特征
      try {
        const face = new win.FontFace(fam, buf);
        await face.load();
        probeFace = face;
        faceAdded = false;
        faceAdd();                // 构建/首次匹配期间需要可用；准备池结束后会删掉
      } catch (e) {
        throw new Error('字体加载失败：' + (e && e.message ? e.message : e));
      }
      probeFont = '20px "' + fam + '"';
      return probeFont;
    }

    async function ensureReady(force) {
      if (ready && !force) return true;
      if (building) return building;
      building = (async () => {
        ensureCanvas();
        if (!ctx) throw new Error('无 Canvas 上下文');
        await loadFont();
        await buildPool();
        // 基准池只用系统基准字体渲染，buildPool 之后就不再需要探测字体常驻（t11/D）
        faceDelete();
        ready = true;
        failed = null;
        stats.fontStatus = '基准池就绪（' + (pool ? pool.length : 0) + ' 字）';
        return true;
      })()
        .catch((e) => {
          failed = (e && e.message) || String(e);
          stats.fontStatus = '失败：' + failed;
          warn('字体解码失败：', failed);
          throw e;
        })
        .finally(() => { building = null; });
      return building;
    }

    // 匹配单个码位（带缓存），惰性触发
    async function matchCode(code) {
      if (code in map || code in missed) return map[code] || null;
      if (!probeFont || !pool) return null;
      const target = glyphFeature(String.fromCodePoint(code), probeFont);
      if (!target) { missed[code] = true; return null; }
      let best = null, bestScore = -2;
      for (const cand of pool) {
        let sc = -2;
        for (const f of cand.feats) {
          const s = cosine(target, f);
          if (s > sc) sc = s;
        }
        if (sc > bestScore) { bestScore = sc; best = cand.ch; }
      }
      if (best && bestScore >= CFG.fontConfidence) {
        map[code] = best;
        conf[code] = bestScore;
        return best;
      }
      missed[code] = true;
      return null;
    }

    /* 预解码：把文本里出现的码位先匹配好，供随后同步 decode 使用。
     * 只处理实际出现的字符，复杂度 = 题面不同字符数 × 候选池，而不是字体全覆盖。 */
    async function prepare(texts) {
      if (!CFG.fontDecode) return { ok: false, skipped: true, reason: '解码已关闭' };

      // 关键区分：页面根本没有 cxsecret 字体 = 题面没有混淆，直接正常答题。
      // 只有"有字体但下载/解析/匹配失败"才算真失败，才需要考虑跳过答题。
      const found = findFontUrlCached();
      if (!found) {
        noFont = true;
        faceDelete();   // 页面已无混淆字体：顺手把之前可能残留的探测 face 清掉（t11/D）
        stats.fontStatus = '本页无混淆字体（无需解码）';
        return { ok: true, noFont: true, mapped: 0 };
      }
      noFont = false;

      try { await ensureReady(); } catch (e) {
        return { ok: false, reason: failed || '构建失败' };
      }
      // 匹配字形时才需要探测字体在 document.fonts 里，用完立刻删（t11/D）
      faceAdd();
      try {
        const codes = new Set();
        for (const t of (texts || [])) {
          for (const ch of String(t || '')) {
            const c = ch.codePointAt(0);
            if (c < 0x20) continue;
            if (c in map || c in missed) continue;
            codes.add(c);
          }
        }
        let n = 0;
        for (const c of codes) {
          const r = await matchCode(c);
          if (r) n++;
          // 每 20 个让出一次，避免长任务
          if (++n % 20 === 0) await new Promise((r2) => setTimeout(r2, 0));
        }
        const mapped = Object.keys(map).length;
        stats.fontMapped = mapped;
        stats.fontStatus = '已解码 ' + mapped + ' 字（本次命中 ' + n + '）';
        return { ok: true, mapped, hit: n };
      } finally {
        faceDelete();
      }
    }

    // 同步解码：只用已建立的映射，未命中的码位保留原字符
    function decode(text) {
      const s = String(text || '');
      if (!CFG.fontDecode || !s) return s;
      let out = '';
      for (const ch of s) {
        const real = map[ch.codePointAt(0)];
        out += real || ch;
      }
      return out;
    }

    // 健康检查：用于暴露"假成功"——映射为空说明字体没被正确加载
    function health() {
      if (!ready) return { ok: false, reason: failed || '未构建' };
      const n = Object.keys(map).length;
      const m = Object.keys(missed).length;
      if (!n) return { ok: false, reason: '映射为空（字体可能未被正确加载）', missed: m };
      return { ok: true, mapped: n, missed: m };
    }

    // 解码失败时是否应阻止答题（避免在错字上答题并污染题库）
    // 注意：页面本来就没有混淆字体时不算失败——那种情况题面是明文，正常答即可
    function blocked() {
      if (!CFG.fontDecode || !CFG.skipAnswerIfFontFail) return false;
      if (noFont) return false;
      return !health().ok;
    }

    // 页面卸载时确保探测字体不残留（t11/D）
    try {
      win.addEventListener('pagehide', faceDelete);
      win.addEventListener('beforeunload', faceDelete);
    } catch (e) { /* 忽略 */ }

    return {
      prepare, decode, health, blocked, ensureReady, findFontUrl,
      // 供测试/排查：当前探测字体的家族名与是否仍挂在 document.fonts 上
      family: () => probeFont,
      faceState: () => ({ family: probeFace ? probeFace.family : '', added: faceAdded }),
    };
  })();


  /* ============================================================
   * 五、单端纪律：同账号多标签互斥
   * ------------------------------------------------------------------
   * 平台把"多终端不同地点同时学习相同内容"列为明确高危项，可能导致进度清空。
   * 这里用 localStorage 心跳做同浏览器多标签互斥（无法覆盖多设备，但能覆盖最常见场景）。
   * ============================================================ */
  const SESSION = (() => {
    const TAB_ID = 't' + Math.random().toString(36).slice(2, 10);
    const KEY_PREFIX = 'cxas_hb_';
    let playing = false;
    let conflictWith = null;

    function beat() {
      try {
        localStorage.setItem(KEY_PREFIX + TAB_ID, JSON.stringify({ at: Date.now(), playing }));
      } catch (e) { /* 忽略 */ }
    }

    function others() {
      const now = Date.now();
      const list = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k.indexOf(KEY_PREFIX) !== 0) continue;
          const id = k.slice(KEY_PREFIX.length);
          if (id === TAB_ID) continue;
          let v;
          try { v = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
          if (!v || !v.at) continue;
          if (now - v.at > CFG.sessionStaleMs) continue;
          list.push({ id, ...v });
        }
      } catch (e) { /* 忽略 */ }
      return list;
    }

    function check() {
      if (!CFG.singleSession) return null;
      const live = others().filter((o) => o.playing);
      if (!live.length) { conflictWith = null; return null; }
      // 仲裁：所有活跃标签里 ID 字典序最小的获得播放权，其余让路。
      // 若单纯"看到别人在播就暂停"，两个标签会互相暂停又互相恢复，形成抖动。
      const ids = [TAB_ID].concat(live.map((o) => o.id)).sort();
      if (ids[0] === TAB_ID) { conflictWith = null; return null; }
      conflictWith = ids[0];
      return conflictWith;
    }

    function cleanup() {
      try { localStorage.removeItem(KEY_PREFIX + TAB_ID); } catch (e) { /* 忽略 */ }
    }

    return {
      beat,
      check,
      cleanup,
      setPlaying(v) { playing = !!v; },
      get conflict() { return conflictWith; },
      tabId: TAB_ID,
    };
  })();

  /* ============================================================
   * 六、反"后台暂停"补丁
   *   注意：这只改变页面 JS 读到的值，服务端看不到。
   *   它的作用是"防止播放器自己暂停"，不是反检测手段（见报告 §5.1-A）。
   * ============================================================ */
  function patchVisibility() {
    try {
      Object.defineProperty(doc, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(doc, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(doc, 'webkitHidden', { get: () => false, configurable: true });
      // 旧版播放器会看 hasFocus 决定是否自己暂停（real-video.md §4.1），这里直接伪造成"一直有焦点"
      Object.defineProperty(doc, 'hasFocus', { value: () => true, configurable: true, writable: true });
    } catch (e) { /* 某些环境不可重定义 */ }
    const swallow = (e) => e.stopImmediatePropagation();
    /* 可见性 + 焦点事件一起拦（real-video.md §4.2，uxuescript 同款）：
     * 旧版播放器监听 blur/focusout，切窗口会被平台自己暂停；mouseleave/mouseout 一并拦掉。
     * 绝不能拦 ended / pause / timeupdate —— 它们是媒体元素事件，也是我们判定"播完/平台暂停"的信号。 */
    ['visibilitychange', 'webkitvisibilitychange', 'pagehide',
      'blur', 'focusout', 'mouseleave', 'mouseout'].forEach((ev) => {
      try { doc.addEventListener(ev, swallow, true); } catch (e) { /* 忽略 */ }
      try { win.addEventListener(ev, swallow, true); } catch (e) { /* 忽略 */ }
    });
  }

  /* ============================================================
   * 七、视频控制
   * ============================================================ */
  const CATALOG_NODE_SELS = [
    '.posCatalog .chapter_item',
    '#coursetree .chapter_item',
    '.chapter_item',
    '.posCatalog_select',
  ];
  const CATALOG_ACTIVE_SELS = [
    '.posCatalog_select.posCatalog_active',
    '.posCatalog_active',
    '.chapter_item.on',
    '.chapter_item.active',
    '.currents',
    /* 新版（mooc2-ans / 泛雅）目录：当前小节的 id 形如 cur<chapterId>。
     * 依据：仓库内 research/real-video.md 记录的实测结构
     *   新版目录页 → iframe #frame_content-zj → .chapter_item#cur{chapterId}（onclick=toOld(...)）
     *   任务/章节页签  → .posCatalog_select#cur{chapterId}
     * 旧选择器全落空时，findCurrentNode() 返回 null，goNext() 直接判"未找到下一任务点"——
     * 这正是新版平台跑到一节结束后不再自动切节的原因。 */
    '.chapter_item[id^="cur"]',
    '.posCatalog_select[id^="cur"]',
    '[id^="cur"]',
  ];

  let videoEl = null;
  /* v3.2.2 播放控制节流状态：见 tickVideo 里的说明 */
  let lastPlayAttemptAt = 0;
  let playAttempts = 0;
  let gaveUpPlaying = false;
  let humanPauseRepauseCount = 0;
  let videoMissLogged = false;
  let lastChildStatsAt = 0;
  let navPendingUntil = 0;
  let curVideoKey = '';
  let curVideoKeyAt = 0;
  let lastCur = 0;
  let lastDur = 0;
  let curVideoStartCur = 0;
  let nearEndSince = 0;
  let endedFlag = false;      // 当前视频是否真的触发过 ended 事件
  let endedAt = 0;
  /* ended 的身份快照（t11/B1）：
   * 真实播放器 ended 后可能自动从头重播，重播会再触发 playing —— 绝不能因此把
   * "已经播完"这个事实抹掉，否则跳转要再等一整节时长。
   * 所以标记只在"真的换了源/换了节"时清：emptied/loadstart、checkEpoch、跳转重置块，
   * 以及 tickVideo 里"视频身份键变了"的兜底（最坏晚 1 tick 自愈）。 */
  let endedKey = '';          // ended 时对应的视频身份键（由 tickVideo 补记）
  let endedSrc = '';          // ended 时的 currentSrc
  let endedDur = 0;           // ended 时的 duration
  let seenEpoch = '';
  try { seenEpoch = sessionStorage.getItem('cxas_epoch') || ''; } catch (e) { /* 忽略 */ }

  /* ---------------- 拟人化：随机暂停状态机 ----------------
   * 为什么要有：一次"永远匀速播放、从不暂停"的观看记录本身就是显著特征。
   * 关键点：必须能区分"脚本自己发起的暂停"与"弹题/平台/用户导致的暂停"，
   *        否则每 tick 的 autoPlay 会立刻把我们刚按下的暂停又抬起来，两边打架。
   *        humanPausedByMe 就是这个内部标记：只有它为 true 才认为暂停是我们的。
   *
   * 但随机暂停是有代价的（research/real-video.md §8）：服务端按真实墙钟核对观看时长，
   * 暂停越多 playingTime/墙钟 越低，撞上 ≥90% 口径可能反而不判通过。
   * 所以这里加三道闸门：占比上限、最小间隔、恢复校验；并让 humanizePause 可单独关
   * （只保留作息时段这个纯收益的保护，见 DEFAULTS 注释）。 */
  let humanPauseUntil = 0;      // 拟人化暂停的结束时间戳（0 = 未暂停）
  let humanPausedByMe = false;  // 当前暂停是否由本模块发起
  let humanPauseStartedAt = 0;  // 本次暂停的开始时间（用于台账累计实际暂停时长）

  /* 暂停台账：按"当前视频身份键"隔离，换节/换源时重置。
   * playedMs 用 currentTime 的最大值（视频秒），不是墙钟 —— 因为要回答的是
   * "这段视频我看的时间里有几成是停着的"，而不是"这段墙钟时间里我停了几成"。 */
  const HM_LEDGER = { key: '', playedMs: 0, pausedMs: 0, pauseCount: 0, lastPauseAt: 0 };

  /* 恢复校验：暂停结束后 play() 可能"假成功"（后台节流/播放器状态机卡住），
   * 必须等一小会儿看 currentTime 有没有真的往前走。 */
  let resumeCheck = null;       // { at, base, tried }
  let resumeFailed = false;     // 兜底也失败 → 面板告警，不再重试

  function resetHumanizeLedger(key, curSec) {
    HM_LEDGER.key = key || '';
    HM_LEDGER.playedMs = Math.max(0, (Number(curSec) || 0) * 1000);
    HM_LEDGER.pausedMs = 0;
    HM_LEDGER.pauseCount = 0;
    HM_LEDGER.lastPauseAt = 0;
    resumeCheck = null;
    resumeFailed = false;
  }

  function humanPauseLeftSec() {
    return humanPauseUntil ? Math.max(0, Math.ceil((humanPauseUntil - Date.now()) / 1000)) : 0;
  }

  function humanPauseDurationSec() {
    const min = CFG.humanizePauseMin || 3;
    const max = Math.max(min, CFG.humanizePauseMax || 15);
    return Math.round(min + Math.random() * (max - min));
  }

  /* 占比闸门（纯函数，便于单测）：已暂停 + 本次计划暂停 必须不超过 budget × 已播。
   * 例：已播 100s、budget 5% → 上限 5s；已用 4.9s 时想停 1s 就被拦。 */
  function humanPauseBudgetAllows(playedSec, pausedSec, plannedSec, budget) {
    if (!(plannedSec > 0)) return false;
    const cap = Math.max(0, Number(budget) || 0) * Math.max(0, Number(playedSec) || 0);
    return (Number(pausedSec) || 0) + plannedSec <= cap;
  }

  /* 触发前闸门：总开关 → 分开关 → 最小间隔 → 占比。任一不过就本次不暂停。 */
  function canStartHumanPause(now, plannedSec) {
    if (!CFG.humanize || !CFG.humanizePause) return false;
    const gapMs = (CFG.humanizeMinGapSec || 0) * 1000;
    if (HM_LEDGER.lastPauseAt && now - HM_LEDGER.lastPauseAt < gapMs) return false;
    return humanPauseBudgetAllows(
      HM_LEDGER.playedMs / 1000,
      HM_LEDGER.pausedMs / 1000,
      plannedSec,
      CFG.humanizePauseBudget
    );
  }

  // 面板台账文案：已用 X/Y 秒（Z%）· 共 N 次
  function humanizeUsageText() {
    const playedSec = HM_LEDGER.playedMs / 1000;
    const pausedSec = HM_LEDGER.pausedMs / 1000;
    const capSec = playedSec * (CFG.humanizePauseBudget || 0);
    const pct = playedSec > 0 ? Math.round((pausedSec / playedSec) * 100) : 0;
    return '已用 ' + Math.round(pausedSec) + '/' + Math.round(capSec) + ' 秒（' + pct +
      '%）· 共 ' + HM_LEDGER.pauseCount + ' 次';
  }

  function clearHumanPause(reason) {
    if (!humanPauseUntil && !humanPausedByMe) return;
    const startedAt = humanPauseStartedAt;
    humanPauseUntil = 0;
    humanPausedByMe = false;
    humanPauseStartedAt = 0;
    resumeCheck = null;   // 暂停被打断（弹题/关开关）时，上一次的恢复校验也一并作废
    if (startedAt) {
      // 台账只记"真的停过多久"，被弹题打断也按实际时长累计
      const dur = Math.max(0, Date.now() - startedAt);
      HM_LEDGER.pausedMs += dur;
      log('拟人化暂停结束：实际 ' + Math.round(dur / 1000) + ' 秒（累计 ' +
        Math.round(HM_LEDGER.pausedMs / 1000) + ' 秒 / ' + HM_LEDGER.pauseCount + ' 次）');
    }
    if (reason) {
      stats.humanize = CFG.humanize ? '运行中' : '';
      stats.lastAction = reason;
      log(reason);
    }
  }

  /* 发起一次拟人化暂停：只暂停，不 seek、不改进度；到点由 tickVideo 恢复播放。
   * sec 由调用方（tickVideo）先算好，便于先过占比闸门再落暂停；调试/测试可直接调用。 */
  function startHumanPause(v, sec) {
    const dur = Math.max(1, Math.round(Number(sec) || humanPauseDurationSec()));
    humanPauseUntil = Date.now() + dur * 1000;
    humanPausedByMe = true;
    humanPauseStartedAt = Date.now();
    // 新的暂停接管控制权：上一次的恢复校验必须作废，否则它会在暂停期间点播放按钮，和暂停打架
    resumeCheck = null;
    resumeFailed = false;
    HM_LEDGER.pauseCount += 1;
    HM_LEDGER.lastPauseAt = humanPauseStartedAt;
    try { if (v && !v.paused) v.pause(); } catch (e) { /* 忽略 */ }
    SESSION.setPlaying(false);
    stats.humanize = '暂停中（剩 ' + dur + 's）';
    stats.lastAction = '拟人化暂停中：模拟人离开 ' + dur + ' 秒';
    log('拟人化暂停开始：' + dur + ' 秒；台账 ' + humanizeUsageText());
  }

  function rectArea(v) {
    try {
      const r = v.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch (e) { return 0; }
  }

  // 逐层检查祖先：学习通会把上一章内容留在 DOM 里并透明化
  // 注意：元素可能来自**另一个同源文档**（iframe 里的播放器），
  // getComputedStyle 必须用元素自己的 window，否则在跨文档元素上拿不到真实样式（甚至抛错）。
  function isDeeplyVisible(v) {
    let n = v;
    while (n && n.nodeType === 1) {
      let s = null;
      try {
        const w = (n.ownerDocument && n.ownerDocument.defaultView) || win;
        s = w.getComputedStyle(n);
      } catch (e) { s = null; }
      if (s && (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0)) return false;
      n = n.parentElement;
    }
    let r = null;
    try { r = v.getBoundingClientRect(); } catch (e) { return false; }
    return r.width >= 80 && r.height >= 45;
  }

  /* 视频查找：**必须跨同源 iframe**。
   * 新版学习通（mooc-ans / 新版目录点小节走 toOld()）把播放器放在
   * `ananas/modules/video/index.html` 这个 iframe 里，顶层文档里一个 <video> 都没有。
   * 旧实现只查本地 doc，于是新版平台永远「视频：未检测到」，整个脚本形同空转。
   * 现在的口径：顶层跨所有同源文档找；子框架仍只看自己（避免父子两套实例抢同一个 video）。 */
  function pickLocalVisibleVideo() {
    /* v3.2.2 所有权判定：子框架里的实例如果正在驱动同一个 video，
     * 它会每 tick 发 STATS 上来（lastChildStatsAt 就是心跳）。此时顶层**必须让位**，
     * 否则父子两个实例各自 play/pause 同一个元素 —— 实测表现就是"视频一直在开始/暂停"，
     * 而且每秒一次的合成点击是最典型的机器人特征（已因此触发过平台风控）。 */
    if (IS_TOP && Date.now() - lastChildStatsAt < 4000) return null;
    const docs = IS_TOP ? allDocs() : [doc];
    const vids = [];
    for (const d of docs) {
      try {
        for (const v of d.querySelectorAll('video')) {
          if (v.isConnected) vids.push(v);
        }
      } catch (e) { /* 跨域文档，跳过 */ }
    }
    const visible = [];
    for (const v of vids) {
      try { if (isDeeplyVisible(v)) visible.push(v); } catch (e) { /* 忽略 */ }
    }
    if (!visible.length) return null;
    const playing = visible.find((v) => !v.paused && !v.ended);
    if (playing) return playing;
    return visible.sort((a, b) => rectArea(b) - rectArea(a))[0];
  }

  function bindVideoEvents(v) {
    if (!v || v.__cxasBound) return;
    v.__cxasBound = true;
    /* v4.0 抖动计数：每次 play/pause 都记一笔（见 noteFlapEvent）。
     * 挂事件而不是轮询——轮询只能看到"当前状态"，看不到"刚刚抖了一下"。 */
    try {
      v.addEventListener('play', noteFlapEvent);
      v.addEventListener('pause', noteFlapEvent);
    } catch (e) { /* 忽略 */ }
    const reset = () => {
      curVideoKey = '';
      curVideoKeyAt = Date.now();
      curVideoStartCur = 0;
      stats.progress = 0;
      lastCur = 0;
      lastDur = 0;
      nearEndSince = 0;
      endedFlag = false;
      endedAt = 0;
      endedKey = '';
      endedSrc = '';
      endedDur = 0;
      // 换源/换节时清掉拟人化暂停，否则新视频会被旧的暂停窗口一直按住
      clearHumanPause('');
    };
    v.addEventListener('emptied', reset);
    v.addEventListener('loadstart', reset);
    // 用事件记录"真播完"，比轮询 videoEl.ended 可靠：
    // 部分播放器在 ended 后立刻切源，轮询会错过这一帧
    v.addEventListener('ended', () => {
      endedFlag = true;
      endedAt = Date.now();
      endedSrc = v.currentSrc || v.src || '';
      endedDur = v.duration || 0;
      endedKey = '';   // 身份键在 tickVideo 里补记（那里才算得出 catalog 部分）
    });
    /* t11/B1：ended 后播放器可能自动从头重播（真实行为），此时会再触发 playing 且 currentTime≈0。
     * 以前在这里清 endedFlag，等于把"已播完"抹掉；现在只在"真的换源"时清。 */
    v.addEventListener('playing', () => {
      if (!endedFlag) return;
      const src = v.currentSrc || v.src || '';
      const dur = v.duration || 0;
      if (src !== endedSrc || Math.abs(dur - endedDur) > 0.5) {
        endedFlag = false;
        endedAt = 0;
        endedKey = '';
        endedSrc = '';
        endedDur = 0;
      }
    });
  }

  function clickPlayButton(d) {
    d = d || doc;
    const btn = d.querySelector('.vjs-big-play-button, .vjs-play-control.vjs-paused, .ans-videoquiz-play');
    if (btn && isVisible(btn)) btn.click();
  }

  /* 恢复失败时的兜底：优先点 vjs 的大播放按钮（真浏览器里它才是"从暂停恢复"的开关）。
   * 返回是否点到，便于调用方决定要不要再退一步点播放控件。 */
  function clickBigPlay(d) {
    d = d || doc;
    const btn = d.querySelector('.vjs-big-play-button');
    if (btn && isVisible(btn)) { btn.click(); return true; }
    return false;
  }

  /* 防双跳（t20/F1）：
   * `#prevNextFocusNext` 是"下一节整页跳转"，如果提交后既点它又 postNext，
   * 顶层 goNext 会再点一次目录节点 → 双跳。两个时间戳 + jumpGuard 一起做闸门。 */
  let nextPostedAt = 0;        // 最近一次 postNext 的时间
  let lastNextClickAt = 0;     // 最近一次点"下一节"按钮的时间

  function postNext() {
    if (Date.now() - nextPostedAt < 15000) return;   // 15s 内只发一次 NEXT
    nextPostedAt = Date.now();
    try { win.top.postMessage({ __cxas: 'NEXT' }, '*'); } catch (e) { /* 忽略 */ }
  }

  function relayStats() {
    if (IS_TOP) return;
    try {
      win.top.postMessage({
        __cxas: 'STATS',
        data: {
          video: stats.video, progress: stats.progress, speed: stats.speed,
          quiz: stats.quiz, lastAction: stats.lastAction,
          fontStatus: stats.fontStatus, humanize: stats.humanize,
          humanizeUsage: stats.humanizeUsage,
          qtypes: stats.qtypes,
          platformLimit: stats.platformLimit,
          dailyCount: stats.dailyCount,
          completionState: stats.completionState,
          completionRetries: stats.completionRetries,
          replays: stats.replays,
          hardJumps: stats.hardJumps,
        },
      }, '*');
    } catch (e) { /* 忽略 */ }
  }

  /* 题目页（作业/测验）的中继：不能复用 STATS —— 那个消息会把顶层 stats.video 置 true，
   * 在纯题目页上会让面板显示"视频：已接管"（t4 实测）。 */
  function relayWorkStats() {
    if (IS_TOP) return;
    try {
      win.top.postMessage({
        __cxas: 'WORK_STATS',
        data: { qtypes: stats.qtypes, qskip: stats.qskip, work: stats.work, lastAction: stats.lastAction, collected: stats.collected, answered: stats.answered, collectedAt: stats.collectedAt, mode: stats.mode },
      }, '*');
    } catch (e) { /* 忽略 */ }
  }

  function catalogKey() {
    /* t11/B2：目录不一定在顶层文档——新版在 #frame_content-zj iframe 里（real-video.md §1.2）。
     * 以前只查 win.top.document，取空后 videoKeyOf 退化成 |src|dur，换节会误判成同一视频。 */
    try {
      const docs = allDocs();     // 顶层优先，递归同源 iframe
      for (const d of docs) {
        let nodes = [];
        for (const s of CATALOG_NODE_SELS) {
          try { nodes = Array.from(d.querySelectorAll(s)); } catch (e) { nodes = []; }
          if (nodes.length) break;
        }
        let active = null;
        for (const s of CATALOG_ACTIVE_SELS) {
          try { active = d.querySelector(s); } catch (e) { active = null; }
          if (active) break;
        }
        if (!active) continue;
        let idx = nodes.indexOf(active);
        if (idx < 0) {
          let bestLen = Infinity;
          nodes.forEach((x, i) => {
            if (!x.contains(active)) return;
            const len = (x.textContent || '').length;
            if (len < bestLen) { bestLen = len; idx = i; }
          });
        }
        if (idx >= 0) return 'c' + idx;
        const t = (active.textContent || '').replace(/\s+/g, '').slice(0, 12);
        if (t) return 't' + t;
      }
    } catch (e) { /* 跨域 */ }
    return '';
  }

  function videoKeyOf(v, dur) {
    const src = v.currentSrc || v.src || '';
    const d = dur && isFinite(dur) && dur > 0 ? Math.round(dur * 10) : 0;
    return catalogKey() + '|' + src + '|' + d;
  }

  function jumpGuardHit(key) {
    try {
      const raw = sessionStorage.getItem('cxas_jump_guard');
      if (!raw) return false;
      const g = JSON.parse(raw);
      return g.key === key && Date.now() - g.at < (CFG.jumpRetryDelay || 30000);
    } catch (e) { return false; }
  }

  function markJumped(key) {
    try {
      sessionStorage.setItem('cxas_jump_guard', JSON.stringify({ key, at: Date.now() }));
    } catch (e) { /* 忽略 */ }
  }

  function reloadPage() {
    try { win.top.location.reload(); return; } catch (e) { /* 跨域 */ }
    try { win.top.postMessage({ __cxas: 'RELOAD' }, '*'); } catch (e) { /* 忽略 */ }
  }

  function checkEpoch() {
    let ep = '';
    try { ep = sessionStorage.getItem('cxas_epoch') || ''; } catch (e) { return; }
    if (!ep || ep === seenEpoch) return;
    seenEpoch = ep;
    videoEl = null;
    curVideoKey = '';
    curVideoKeyAt = Date.now();
    curVideoStartCur = 0;
    videoMissLogged = false;
    lastCur = 0;
    lastDur = 0;
    nearEndSince = 0;
    stats.progress = 0;
    stats.lastAction = '已切换章节，重新识别视频';
    navPendingUntil = Date.now() + 8000;
    endedFlag = false;      // t11/B1：换节显式重置 ended 的锁定状态
    endedAt = 0;
    endedKey = '';
    endedSrc = '';
    endedDur = 0;
    resetCompletionAttempts();   // t28/F1：新节重新拥有完整的重播额度
    clearHumanPause('');
  }

  /* t8/D：播完先等平台的完成标记再跳（video.ended ≠ 任务点已记录，real-video.md §6）。
   * 只在页面**确实存在**完成标记这一族元素时才等——老版本/无目录页面没有标记，干等 30s 只会白卡。
   * 超时 → 重播当前节（最多 completionMaxRetry 次）→ 仍无标记则硬跳（否则会永远卡住）。 */
  function completionMarkerFamilyPresent(docs) {
    const list = docs || allDocs();
    for (const d of list) {
      try {
        if (d.querySelector('.icon_Completed, .orangeNew, .ans-job-finished, .ans-job-icon:not(.ans-job-icon-clear)')) return true;
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  function pollCompletionMark(timeoutMs) {
    const interval = Math.max(100, Number(CFG.completionPollMs) || 500);
    return new Promise((resolve) => {
      const started = Date.now();
      const step = () => {
        if (sectionCompleted()) { resolve(true); return; }
        if (Date.now() - started >= timeoutMs) { resolve(false); return; }
        setTimeout(step, interval);
      };
      step();
    });
  }

  let completionWaitActive = false;
  /* t28/F1：按"节/视频身份"记录**跨调用**的重播次数。
   * 旧实现里循环体内 `return false` 直接退出函数，第二轮永远走不到 → 硬跳出口不可达，
   * 默认 completionMaxRetry=1 时会"每次都重播"，表现为无限重播（静默不计分的场景必踩）。
   * 现在：重播次数记在 Map 里，跨多次 ended 累加，超过上限就**必然**走硬跳。 */
  const completionAttempts = new Map();

  function completionRetryKey() {
    let sec = '';
    try { sec = currentSectionKey(); } catch (e) { sec = ''; }
    return sec || ('vid|' + (curVideoKey || ''));
  }

  function completionRetriesUsed() {
    return completionAttempts.get(completionRetryKey()) || 0;
  }

  // 换节/换源时清空（否则新节会被上一节的"已重播 N 次"误伤，直接硬跳）
  function resetCompletionAttempts() {
    completionAttempts.clear();
    stats.completionRetries = 0;
  }

  async function waitForCompletionMark() {
    const timeout = Math.max(500, Number(CFG.completionTimeoutMs) || 30000);
    const maxRetry = Math.max(0, Math.min(3, Number(CFG.completionMaxRetry) || 0));
    const key = completionRetryKey();
    const used = completionAttempts.get(key) || 0;
    stats.completionRetries = used;

    stats.completionState = '等待平台记录中…';
    if (hud && hud.__refresh) hud.__refresh();
    const ok = await pollCompletionMark(timeout);
    if (ok) {
      stats.completionState = '已记录，准备跳转';
      completionAttempts.delete(key);   // 记录到了：这一节的重播计数清零
      stats.completionRetries = 0;
      if (hud && hud.__refresh) hud.__refresh();
      return true;
    }

    // 超时：还有重播额度就重播一次（累计计数），额度用完就硬跳——这条出口必须可达
    if (used < maxRetry) {
      completionAttempts.set(key, used + 1);
      stats.completionRetries = used + 1;
      stats.replays = (stats.replays || 0) + 1;
      stats.completionState = '超时未记录，重播中（第 ' + (used + 1) + ' 次）';
      stats.lastAction = stats.completionState;
      warn(stats.lastAction);
      if (hud && hud.__refresh) hud.__refresh();
      try {
        if (videoEl) {
          videoEl.currentTime = 0;
          const p = videoEl.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) { /* 忽略 */ }
      endedFlag = false;
      endedAt = 0;
      endedKey = '';
      endedSrc = '';
      endedDur = 0;
      return false;   // 交回主循环：重播后再次 ended 会重新进入本函数，used 继续累加
    }

    stats.hardJumps = (stats.hardJumps || 0) + 1;
    stats.completionState = '超时未记录，仍无标记';
    stats.lastAction = '已重播 ' + used + ' 次仍无完成标记，硬跳转（避免卡死）';
    warn(stats.lastAction);
    /* 刻意**不**清空计数：万一下一跳失败、同一节又被重新判定，这里会直接再硬跳，
     * 绝不会再回到'重播'（清空只发生在真正换节时：checkEpoch / 跳转成功）。 */
    return true;
  }

  /* ============================================================
   * 抖动自检（v4.0）
   * ============================================================ */
  /* 记录 play/pause 切换。熔断后不再计数、也不自动恢复：
   * 自动恢复会让「抖动→熔断→恢复→再抖动」变成循环，而那正是最像机器人的行为。 */
  const flapTimes = [];
  let flapTripped = false;
  function noteFlapEvent() {
    if (flapTripped) return;
    const now = Date.now();
    flapTimes.push(now);
    while (flapTimes.length && now - flapTimes[0] > 60000) flapTimes.shift();
    const raw = Number(CFG.flapMaxPerMin);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 12;
    if (flapTimes.length < limit) return;
    flapTripped = true;
    CFG.enabled = false;
    try { store.set('cfg', CFG); } catch (e) { /* 忽略 */ }
    stats.flap = '已熔断（60 秒 ' + flapTimes.length + ' 次切换）';
    setAction('检测到播放抖动（60 秒内 ' + flapTimes.length + ' 次播放/暂停切换），已自动暂停以防触发风控', { lock: true });
    warn(stats.lastAction);
  }

  /* ============================================================
   * 任务点诊断（v4.0）
   * ============================================================ */
  /* 面板上看清「本页识别到了什么」：几类任务点、各几个、多少题。
   * 用途很具体：下次在真实章节测验页，一眼判断是「没识别到题目」还是「识别到了没作答」。
   * 5 秒刷新一次，避免每 tick 扫 DOM。 */
  let lastDiagAt = 0;
  function tickDiag() {
    if (!IS_TOP) return;
    if (Date.now() - lastDiagAt < 5000) return;
    lastDiagAt = Date.now();
    const cards = findCardsDoc();
    if (!cards) { stats.diag = ''; return; }
    const types = {};
    try {
      for (const ic of cards.querySelectorAll('.ans-job-icon')) {
        const cls = String(ic.className || '').split(/\s+/);
        const hit = cls.find((x) => /^ans-job-(video|doc|audio|ppt|work|read)$/.test(x));
        const key = hit ? hit.replace('ans-job-', '') : 'other';
        types[key] = (types[key] || 0) + 1;
      }
    } catch (e) { /* 忽略 */ }
    let q = 0;
    try { q = cards.querySelectorAll('.TiMu, .questionLi, .ans-videoquiz, .TiMuNew').length; } catch (e) { /* 忽略 */ }
    const parts = Object.keys(types).map((k) => k + '×' + types[k]);
    stats.diag = (parts.length ? parts.join(' ') : '无任务点') + ' ｜ 题 ' + q;
  }

  /* ============================================================
   * 音频任务点（v4.0）
   * ============================================================ */
  let lastAudioPlayAt = 0;
  function tickAudio() {
    stats.audio = '';
    if (!CFG.audioTask || !IS_TOP) return;
    /* 总开关门禁：暂停 / 熔断后不得再驱动（与 tickVideo 一致）。 */
    if (!CFG.enabled) return;
    if (Date.now() - lastChildStatsAt < 4000) return;   // 子实例在驱动，顶层让位

    const cands = [];
    for (const d of allDocs()) {
      try {
        for (const a of d.querySelectorAll('audio')) {
          if (!a.isConnected) continue;
          if (!isDeeplyVisible(a)) continue;
          /* 完成态过滤：落在任务点容器里、图标已去掉 -clear 的说明本节已完成，
           * 不再拉起 —— 否则「已完成但被平台暂停」的音频会被反复 play。 */
          let finished = false;
          try {
            const box = a.closest && a.closest('.ans-attach-ct');
            if (box) {
              const ic = box.querySelector('.ans-job-icon');
              if (ic && !ic.classList.contains('ans-job-icon-clear')) finished = true;
            }
          } catch (e) { /* 忽略 */ }
          if (finished) continue;
          cands.push(a);
        }
      } catch (e) { /* 跨域 */ }
    }
    if (!cands.length) return;

    /* 一 tick 只驱动一个：多个音频同时 play 既吵也不像人。
     * 优先「未在播且没播完」的。 */
    const a = cands.find((x) => x.paused && !x.ended) || cands[0];
    if (!a) return;

    /* 音频的 play/pause 也计入抖动熔断（之前的盲区：只统计 <video>） */
    if (!a.__cxasFlapBound) {
      a.__cxasFlapBound = true;
      try {
        a.addEventListener('play', noteFlapEvent);
        a.addEventListener('pause', noteFlapEvent);
      } catch (e) { /* 忽略 */ }
    }

    if (CFG.mute) { try { a.muted = true; a.volume = 0; } catch (e) { /* 忽略 */ } }
    const rawGap = Number(CFG.controlGapMs);
    const gapMs = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : 4000;
    /* 与视频同一套节流：不抢控制权，播完不再播 */
    if (a.paused && !a.ended && Date.now() - lastAudioPlayAt >= gapMs) {
      lastAudioPlayAt = Date.now();
      try {
        const p = a.play();
        if (p && p.catch) p.catch(() => { /* 自动播放被拦，等下一轮 */ });
      } catch (e) { /* 忽略 */ }
    }
    const dur = Number(a.duration);
    const pos = Number.isFinite(dur) && dur > 0
      ? Math.round(a.currentTime) + '/' + Math.round(dur) + 's'
      : Math.round(a.currentTime || 0) + 's';
    stats.audio = (a.paused ? '未播放 ' : '播放中 ') + pos + (cands.length > 1 ? '（共 ' + cands.length + ' 个）' : '');
  }

  function tickVideo() {
    if (!CFG.enabled) return;
    checkEpoch();

    const local = pickLocalVisibleVideo();
    if (local !== videoEl) {
      videoEl = local;
      videoMissLogged = false;
      bindVideoEvents(videoEl);
    }
    if (!videoEl) {
      if (IS_TOP && Date.now() - lastChildStatsAt < 3000) return;
      stats.video = false;
      stats.progress = 0;
      SESSION.setPlaying(false);
      if (IS_TOP && !videoMissLogged) {
        videoMissLogged = true;
        const srcs = Array.from(doc.querySelectorAll('iframe')).map((f) => f.src || '(无src)').slice(0, 12);
        log('未检测到可见视频。iframe 列表：', srcs);
      }
      return;
    }
    stats.video = true;

    // ---- 拟人化：作息时段闸门 ----
    // humanize 是总开关：关掉后时段限制整体不生效（t14/F1，保证 humanize:false 真的能关掉）。
    // 超出时段主动暂停播放（不 seek、不改进度）。这里不静默跳过：
    // 面板和 lastAction 都要能说清"为什么不动了"，否则用户以为脚本坏了。
    const hoursRange = CFG.humanize ? parseActiveHours(CFG.activeHours) : null;
    if (hoursRange && !inActiveHours(hoursRange)) {
      if (!videoEl.paused) { try { videoEl.pause(); } catch (e) { /* 忽略 */ } }
      clearHumanPause('');
      SESSION.setPlaying(false);
      stats.humanize = '';
      // 只在"刚进入时段外"写一次，避免每 tick 被后面的 tickQuiz/tickWork 覆盖（t14/F2）
      markHoursBlocked(hoursBlockMessage(hoursRange) +
        '，已暂停播放；改配置 activeHours 或关闭 humanize 可调整');
      if (!IS_TOP) relayStats();
      return;
    }
    // 回到允许时段（或总开关被关）：补一条状态切换提示，否则面板一直挂着旧的"已暂停"
    if (hoursBlockedState) {
      hoursBlockedState = false;
      stats.lastAction = '已进入作息时段，恢复自动播放';
      log(stats.lastAction);
    }

    // 单端纪律：别的标签在播 → 主动让路
    if (CFG.singleSession) {
      const conflict = SESSION.check();
      if (conflict) {
        if (!videoEl.paused) { try { videoEl.pause(); } catch (e) { /* 忽略 */ } }
        SESSION.setPlaying(false);
        stats.lastAction = '检测到另一标签页正在学习，已主动暂停（避免多端判定）';
        return;
      }
    }

    if (CFG.mute) { videoEl.muted = true; videoEl.volume = 0; }

    // 倍速硬上限
    const wantSpeed = Math.min(Math.max(1, CFG.speed), CFG.maxSpeed);
    if (Math.abs(videoEl.playbackRate - wantSpeed) > 0.01) {
      try { videoEl.playbackRate = wantSpeed; } catch (e) { /* 忽略 */ }
    }
    stats.speed = videoEl.playbackRate;

    const quizShowing = !!getQuizBox();
    // 关键：视频播完后 paused 也会变 true。若无脑 play() 会把它从头重播，
    // 导致永远停在"99% 等待播完"而触发不了跳转（真实踩过的坑）。
    // 所以已播完的视频绝不再自动播放，交给跳转逻辑处理。
    const endedNow = videoEl.ended || endedFlag;

    // ---- 拟人化：随机暂停 ----
    // 收尾：到点 / 功能被关 / 弹题打断了我们 → 清标记，autoPlay 下一句就能恢复播放。
    // 弹题是平台自己暂停的，绝不和它抢控制权（humanPausedByMe 只在我们自己暂停时为 true）。
    if (humanPauseUntil) {
      if (!CFG.humanize || !CFG.humanizePause) {
        clearHumanPause('随机暂停已关闭，恢复播放');
      } else if (quizShowing) {
        clearHumanPause('弹题优先，拟人化暂停让位');
      } else if (Date.now() >= humanPauseUntil) {
        clearHumanPause('拟人化暂停结束，继续播放');
        // 只有"脚本会去恢复播放"时才需要校验推进：autoPlay 关掉时不该替用户点播放
        if (CFG.autoPlay && !endedNow) {
          resumeFailed = false;
          resumeCheck = {
            at: Date.now() + CFG.humanizeResumeCheckMs,
            base: videoEl.currentTime,
            tried: false,
          };
        }
      } else if (!videoEl.paused && humanPausedByMe) {
        // 暂停期内播放器/平台又把视频拉起来了：按回去，保持"人离开"的状态
        /* 拉锯上限 3 次：拟人化不值得拿风控去换，超过就让位给它播。 */
        if (humanPauseRepauseCount < 3) {
          humanPauseRepauseCount++;
          try { videoEl.pause(); } catch (e) { /* 忽略 */ }
          SESSION.setPlaying(false);
        } else {
          clearHumanPause('拟人化暂停与平台冲突，已让位（避免拉锯）');
        }
      }
    }
    let humanPausing = humanPauseUntil > 0 && humanPausedByMe;

    // 触发：只在"确实在播放 + 没有弹题 + 不在跳转等待期"时掷骰子。
    // 概率是每 tick（≈1s）一次，所以 humanizePauseChance 用 0.0005 量级。
    // 掷骰子之前先过闸门（分开关 / 最小间隔 / 暂停占比上限），否则概率越大越容易撞 ≥90% 口径。
    if (
      CFG.humanize && CFG.humanizePause && !humanPausing && !videoEl.paused &&
      !endedNow && !quizShowing && Date.now() >= navPendingUntil
    ) {
      const plannedSec = humanPauseDurationSec();
      if (canStartHumanPause(Date.now(), plannedSec) &&
          Math.random() < (CFG.humanizePauseChance || 0)) {
        startHumanPause(videoEl, plannedSec);
        humanPausing = true;
      }
    }
    stats.humanize = !CFG.humanize
      ? ''
      : (humanPausing
        ? '暂停中（剩 ' + humanPauseLeftSec() + 's）'
        : (resumeFailed ? '恢复失败（请手动点播放）' : '运行中'));
    stats.humanizeUsage = CFG.humanize ? humanizeUsageText() : '';

    if (CFG.autoPlay && videoEl.paused && !endedNow && !quizShowing && !humanPausing) {
      /* v3.2.2 节流：间隔不到 controlGapMs 不重试；连续 3 次没起来就放弃等人。
       * 合成点击只在前两次发生 —— 反复点播放器是最容易被判机器人的动作之一。 */
      const rawGap = Number(CFG.controlGapMs);
      const gapMs = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : 4000;
      if (!gaveUpPlaying && Date.now() - lastPlayAttemptAt >= gapMs) {
        lastPlayAttemptAt = Date.now();
        playAttempts++;
        try { videoEl.play().catch(() => {}); } catch (e) { /* 忽略 */ }
        if (playAttempts <= 2) clickPlayButton(videoEl.ownerDocument);
        if (playAttempts >= 3) {
          gaveUpPlaying = true;
          setAction('播放被平台反复拒绝，已停止抢控制权（请手动点一下播放器）', { lock: true });
          warn('play() 连续失败，停止重试以免触发风控');
        }
      }
    }
    if (!videoEl.paused) { playAttempts = 0; gaveUpPlaying = false; lastPlayAttemptAt = 0; }
    SESSION.setPlaying(!videoEl.paused);

    // ---- 拟人化：恢复校验（最多重试一次，绝不无限重试）----
    // 弹题出现时直接作废校验：弹题浮层下 currentTime 本来就不动，
    // 这时去点 .vjs-big-play-button 会在弹题遮罩底下把视频拉起来（t18/F2'）。
    if (resumeCheck && quizShowing) {
      resumeCheck = null;
    } else if (resumeCheck && Date.now() >= resumeCheck.at) {
      const advanced = videoEl.currentTime > resumeCheck.base + 0.2;
      if (advanced) {
        resumeCheck = null;
        resumeFailed = false;
      } else if (!resumeCheck.tried) {
        resumeCheck.tried = true;
        resumeCheck.at = Date.now() + CFG.humanizeResumeCheckMs;
        resumeCheck.base = videoEl.currentTime;
        const clicked = clickBigPlay(videoEl.ownerDocument) || clickPlayButton(videoEl.ownerDocument);
        stats.lastAction = clicked
          ? '拟人化暂停后进度未推进，已点播放按钮兜底'
          : '拟人化暂停后进度未推进，未找到播放按钮';
        log(stats.lastAction);
      } else {
        // 兜底也失败：告警 + 面板可见，清掉校验位避免每 tick 重复点
        resumeCheck = null;
        resumeFailed = true;
        stats.lastAction = '视频未能恢复播放，请手动点一下';
        warn('拟人化暂停恢复失败：currentTime 未推进，已停止重试');
      }
    }

    const dur = videoEl.duration;
    const durOk = dur > 0 && isFinite(dur);
    const cur = videoEl.currentTime;
    const ratio = durOk ? cur / dur : 0;
    stats.progress = Math.round(ratio * 100);

    if (durOk && lastDur > 0 && cur < 1 && lastCur > lastDur * 0.5) {
      curVideoKey = '';
      curVideoKeyAt = Date.now();
      nearEndSince = 0;
    }
    if (durOk) { lastCur = cur; lastDur = dur; }

    const key = videoKeyOf(videoEl, dur);
    if (key !== curVideoKey) {
      curVideoKey = key;
      curVideoKeyAt = Date.now();
      curVideoStartCur = cur;
      nearEndSince = 0;
      // 暂停台账按视频身份隔离：换节/换源就归零，已播时长以新视频的 currentTime 起算
      resetHumanizeLedger(key, cur);
    } else if (durOk) {
      // 已播时长取 currentTime 的最大值（视频秒）；回退/重播不会被算成"多看了"
      HM_LEDGER.playedMs = Math.max(HM_LEDGER.playedMs, cur * 1000);
    }
    /* t11/B1：ended 身份校验（刻意不放在上面 key!==curVideoKey 分支里——
     * 自动重播会走"回到 0 秒"的重播检测把 curVideoKey 清空，若把校验挂在那里，
     * 自动重播就会被误判成换节，B1 等于没修）。 */
    if (endedFlag) {
      if (!endedKey) {
        endedKey = key;                       // 首次在 ended 后算出身份键，补记
      } else if (key !== endedKey) {
        // 视频身份真的变了（换节/换源）："已播完"不再适用于新视频
        endedFlag = false;
        endedAt = 0;
        endedKey = '';
        endedSrc = '';
        endedDur = 0;
      }
    }
    const settled = Date.now() - curVideoKeyAt >= 3000 && (cur - curVideoStartCur) >= 2;

    if (!IS_TOP) relayStats();

    // 拟人化暂停期间：跳过后面的完播判定与跳转。
    // 暂停不是"进度异常"，人只是不在；让计时等待在暂停里悄悄走完会出现
    // "人暂停着却跳到下一节"这种明显不像人的行为。
    // 注意 navPendingUntil 是"等待跳转"的时间戳、nearEndSince 是"到阈值后等了多久"的起点，
    // 两者都在这个 return 之后，所以暂停期间不会被推进/复位，也不会误触兜底跳转。
    if (humanPausing) return;

    // ---- 完播判定（v2 核心改动）----
    // 1) 真播完（ended 事件触发 且 位置接近结尾）→ 视为 complete
    // 2) 到 98% 后继续自然播放，绝不用 currentTime 补满
    //    （seek 会触发 isdrag=1 且不发 complete，等于白刷）
    // 3) ended 迟迟不触发时，99.5% 以上等够 endedFallbackMs 才兜底
    const posAtEnd = durOk && cur >= dur - 1;
    /* t11/B1：锁定态直接算"这段已经播完"，不再要求当前停留在片尾。
     * 旧公式是 endedFlag && posAtEnd —— 自动重播后 cur≈0、posAtEnd 为假，
     * 于是"已播完"这个事实永远触发不了跳转（这才是 B1 里更隐蔽的一半）。 */
    const realEnded = endedFlag || (videoEl.ended && posAtEnd);
    const minWatch = durOk ? Math.min(CFG.minWatchSeconds || 30, dur * 0.9) : 0;
    const threshold = CFG.nextAtPercent / 100;
    const passedThreshold = durOk && settled && ratio >= threshold && cur >= minWatch;

    if (passedThreshold && !realEnded && nearEndSince === 0) {
      nearEndSince = Date.now();
      setAction('已到 ' + stats.progress + '%，等待自然播完（不补进度）');
      log(stats.lastAction);
    }
    if (!passedThreshold) nearEndSince = 0;

    let shouldJump = false;
    let reason = '';
    if (realEnded && CFG.autoNext && Date.now() >= navPendingUntil) {
      shouldJump = true;
      reason = '已播完';
    } else if (
      CFG.autoNext && !CFG.requireEnded && passedThreshold &&
      Date.now() >= navPendingUntil && nearEndSince &&
      Date.now() - nearEndSince >= (CFG.thresholdDelay || 15000)
    ) {
      shouldJump = true;
      reason = '达标后自然播放 ' + Math.round((CFG.thresholdDelay || 15000) / 1000) + 's';
    } else if (
      CFG.autoNext && passedThreshold && Date.now() >= navPendingUntil &&
      ratio >= 0.995 && nearEndSince &&
      Date.now() - nearEndSince >= (CFG.endedFallbackMs || 20000)
    ) {
      // 兜底：视频卡在 99.5% 以上迟迟不 ended（部分源不发 ended）
      shouldJump = true;
      reason = '已到 ' + stats.progress + '%，ended 未触发，兜底跳转';
    }

    if (shouldJump) {
      /* t8/A：平台日上限（硬信号）→ 当日停止自动跳转，但**不阻止当前视频播完**。
       * 超限在平台上表现为"静默不计分"，不识别就会被误当成完播判定 bug。 */
      if (platformDailyLimitHit()) {
        stats.platformLimit = true;
        if (!platformLimitLogged) {
          platformLimitLogged = true;
          setAction('平台提示：今日视频任务点完成数已达上限，已停止自动跳转（改天先探测该提示是否消失）', { lock: true });
          warn(stats.lastAction);
        }
        return;
      }
      // t8/B：本地软限（默认关闭；0 = 不限）
      if (DAILY.limitReached()) {
        stats.lastAction = '已达本地日限 ' + DAILY.limitOf() +
          ' 个任务点，停止自动跳转（本地计数只是自我约束，不是平台规则）';
        return;
      }
      if (jumpGuardHit(key)) return;
      const doJump = () => {
        markJumped(key);
        const wait = realEnded ? (CFG.completeDelay || 5000) : 800;
        stats.lastAction = reason + '，' + Math.round(wait / 1000) + ' 秒后跳转';
        log(stats.lastAction);
        setTimeout(() => {
        videoEl = null;
        curVideoKey = '';
        curVideoKeyAt = Date.now();
        curVideoStartCur = 0;
        videoMissLogged = false;
        lastCur = 0;
        lastDur = 0;
        nearEndSince = 0;
        navPendingUntil = Date.now() + 10000;
        endedFlag = false;      // t11/B1：跳转后重来，ended 锁定必须一起清
        endedAt = 0;
        endedKey = '';
        endedSrc = '';
        endedDur = 0;
        resetCompletionAttempts();   // t28/F1：跳转成功，新节重播额度重置
        clearHumanPause('');   // 跳转后重来，别让旧的暂停窗口压住下一节
          postNext();
          if (CFG.reloadAfterNext) setTimeout(reloadPage, Math.max(CFG.reloadDelay || 0, 800));
        }, wait);
      };
      /* t8/D：播完后先等平台完成标记再跳；超时（重播一次后仍无）才硬跳。
       * 只有页面存在完成标记这一族元素时才等，否则保持原行为（老版本页面干等毫无意义）。 */
      if (CFG.waitForCompletion && realEnded && !completionWaitActive && completionMarkerFamilyPresent()) {
        completionWaitActive = true;
        stats.lastAction = '已播完，等待平台完成标记（最多 ' + Math.round((CFG.completionTimeoutMs || 30000) / 1000) + 's）';
        log(stats.lastAction);
        waitForCompletionMark().then((ok) => {
          completionWaitActive = false;
          if (ok) { doJump(); }
          // ok=false：已经重播，等下一次 ended 重新判定（不在这里跳）
        }).catch(() => { completionWaitActive = false; });
        return;
      }
      doJump();
    }
  }

  /* ============================================================
   * 八、弹题作答
   * ============================================================ */
  const QUIZ_SELECTORS = ['.ans-videoquiz', '.ans-videoquiz-box', '#ext-comp-1001', '.videoquiz'];
  const OPT_SELECTORS = '.ans-videoquiz-opt, .ans-videoquiz-opts li, .ans-videoquiz-opts label';
  /* t11/A3：真实弹题提交按钮是 a#videoquiz-submit（不是 .ans-videoquiz-submit），
   * 继续按钮是 #videoquiz-continue；旧选择器保留在后面作兜底（real-dom.md §3.3）。 */
  const SUBMIT_SELECTORS = '#videoquiz-submit, .ans-videoquiz-submit, .ans-videoquiz-submitBtn, .submit-btn';
  const QUIZ_CONTINUE_SELECTORS = '#videoquiz-continue, .ans-videoquiz-continue';

  function quizDocOf(box) {
    return (box && box.ownerDocument) || doc;
  }

  function quizQuestionText(box) {
    // 新版题面在 .tkTopic，旧版在 .tkItem_title；都没有才退回"容器文本扣掉选项/按钮"
    const titleEl = box.querySelector('.tkTopic, .tkItem_title');
    if (titleEl && (titleEl.textContent || '').trim()) {
      return titleEl.textContent.replace(/\s+/g, ' ').trim();
    }
    const clone = box.cloneNode(true);
    clone.querySelectorAll(OPT_SELECTORS + ', input, button, a, ' + SUBMIT_SELECTORS)
      .forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  let quizLock = false;

  function getQuizBox() {
    const docs = [doc];
    if (videoEl && videoEl.ownerDocument && videoEl.ownerDocument !== doc) docs.push(videoEl.ownerDocument);
    for (const d of docs) {
      for (const sel of QUIZ_SELECTORS) {
        const el = d.querySelector(sel);
        if (el && isVisible(el)) return el;
      }
    }
    return null;
  }

  /* 弹题选项元素：优先 li（真实结构 li.ans-videoquiz-opt），没有 li 才退回 label。
   * 关键：OPT_SELECTORS 同时包含 li 和 label，直接 querySelectorAll 会把每个选项算两次
   * （li 里还套着 label），题面会变成「A. UDP / B. UDP / C. TCP / D. TCP」这种重复项。 */
  function quizOptionElements(box) {
    let list = Array.from(box.querySelectorAll('li.ans-videoquiz-opt, .ans-videoquiz-opts li'));
    if (!list.length) list = Array.from(box.querySelectorAll('.ans-videoquiz-opt, .ans-videoquiz-opts label'));
    return list;
  }

  function parseQuiz(box) {
    const question = quizQuestionText(box);

    const options = quizOptionElements(box).map((el) => {
      const input = el.querySelector('input') || (el.tagName === 'INPUT' ? el : null);
      let text = el.textContent.replace(/\s+/g, ' ').trim();
      text = text.replace(/^[A-Ha-h][.、)）:：\s]+/, '');
      return { el, input, text };
    }).filter((o) => o.input || o.text);

    return { question, options };
  }

  /* t11/A3：弹题选项必须点 input 并校验 checked，点 li 不生效（real-video.md §4）。
   * 只处理被选中的项：对未选中的项乱点会把已选点成取消。 */
  function applyQuizAnswer(options, picked) {
    options.forEach((o, i) => {
      if (!picked.has(i)) return;
      if (o.input) {
        if (!o.input.checked) o.input.click();
        if (!o.input.checked) {
          const label = o.el.querySelector('label') || (o.el.tagName === 'LABEL' ? o.el : null);
          if (label) label.click();
        }
        if (!o.input.checked) {
          // 最后兜底：直接置位 + 派发事件（个别播放器只在 change 里同步状态）
          o.input.checked = true;
          o.input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (!o.input.checked) warn('弹题选项未能选中：', o.text);
      } else {
        // 没有 input 的旧弹题：只能点 label，点 li 无效
        const label = o.el.querySelector('label');
        if (label) label.click();
        else warn('弹题选项缺少 input/label，无法可靠点选：', o.text);
      }
    });
  }

  function submitQuiz(box) {
    const d = quizDocOf(box);
    const btn =
      (d.getElementById && d.getElementById('videoquiz-submit')) ||
      box.querySelector(SUBMIT_SELECTORS) ||
      Array.from(box.querySelectorAll('a, button'))
        .find((b) => isVisible(b) && /^\s*(提交|确定)\s*$/.test((b.textContent || '').trim()));
    if (btn) { btn.click(); return true; }
    warn('弹题未找到提交按钮（#videoquiz-submit 与旧选择器都未命中）');
    return false;
  }

  // 提交后如果出现「继续学习」按钮，点它恢复播放（否则视频停在那里）
  function clickQuizContinue(box) {
    const d = quizDocOf(box);
    let btn = null;
    try { btn = (d.getElementById && d.getElementById('videoquiz-continue')) || box.querySelector(QUIZ_CONTINUE_SELECTORS); } catch (e) { btn = null; }
    if (btn && isVisible(btn)) { btn.click(); return true; }
    return false;
  }

  function tickQuiz() {
    if (!CFG.solveQuiz || CFG.answerSource === 'off' || quizLock) return;
    const box = getQuizBox();
    if (!box) return;
    // 作息时段外不做自动作答（面板「作答本页」是人工操作，不受此限）
    if (autoHoursPaused('弹题作答')) return;

    quizLock = true;
    stats.lastAction = '检测到弹题，正在作答…';

    setTimeout(async () => {
      const { question, options } = parseQuiz(box);
      if (!options.length) { quizLock = false; return; }

      let answer = null, src = 'none', fontFail = false;
      /* 弹题的题型从选项控件推断：checkbox → 多选，其余按单选。
       * 传下去让模型知道该给几个字母（不传的话多选题常只给一个）。 */
      const quizType = options.some((o) => o.input && o.input.type === 'checkbox') ? 'multiple' : 'single';
      try {
        const r = await getAnswer(question, options, quizType);
        answer = r.answer; src = r.src; fontFail = !!r.fontFail;
      } catch (e) { answer = null; src = 'none'; }

      // 字体解码失败：宁可不答，也不在错字上盲选（避免制造异常作答模式）
      if (fontFail) {
        stats.lastAction = '字体解码失败，本题未作答（请检查网络或关闭解码）';
        recordLog('video', question, null, 'none', options, new Set());
        quizLock = false;
        if (hud && hud.__refresh) hud.__refresh();
        return;
      }

      let picked = pickIndexes(options, answer);
      if (!picked.size && CFG.fallback !== 'none') {
        picked = new Set([CFG.fallback === 'random' ? Math.floor(Math.random() * options.length) : 0]);
        src = 'fallback';
      }
      applyQuizAnswer(options, picked);
      recordLog('video', question, answer, src, options, picked);
      stats.quiz += 1;
      stats.lastAction = answer
        ? '已按「' + (SRC_LABEL[src] || src) + '」作答'
        : '无答案，已按兜底策略作答';
      log('弹题作答：', question, '=>', answer || '(兜底)', '[' + (SRC_LABEL[src] || src) + ']');

      setTimeout(() => {
        const clicked = submitQuiz(box);
        stats.lastAction = clicked ? '弹题已提交' : '弹题未找到提交按钮（面板可见原因）';
        // 提交成功后若有「继续学习」按钮，点它恢复播放
        setTimeout(() => { if (clickQuizContinue(box)) stats.lastAction = '弹题已提交，已点继续学习'; }, 800);
      }, 400);

      setTimeout(() => { quizLock = false; }, 5000);
    }, CFG.submitDelay);
  }

  /* ============================================================
   * 九、目录跳转
   * ============================================================ */
  function eachDoc(d, depth, out) {
    if (!d || depth > 6) return out;
    if (out.indexOf(d) === -1) out.push(d);
    const frames = d.querySelectorAll('iframe');
    for (const f of frames) {
      try { eachDoc(f.contentDocument, depth + 1, out); } catch (e) { /* 跨域 */ }
    }
    return out;
  }

  function allDocs() {
    const out = [];
    try { eachDoc(win.top.document, 0, out); } catch (e) { /* 跨域 */ }
    eachDoc(doc, 0, out);
    return out;
  }

  function isCatalogNode(el) {
    if (!isVisible(el)) return false;
    if (el.getAttribute('onclick') || el.getAttribute('data-node')) return true;
    return !!el.querySelector('a, [onclick], span[onclick]');
  }

  function findCurrentNode() {
    for (const d of allDocs()) {
      for (const s of CATALOG_ACTIVE_SELS) {
        const el = d.querySelector(s);
        if (el) return el;
      }
    }
    return null;
  }

  function collectCatalogNodes() {
    for (const d of allDocs()) {
      for (const s of CATALOG_NODE_SELS) {
        const list = Array.from(d.querySelectorAll(s)).filter(isCatalogNode);
        if (list.length > 1) return list;
      }
    }
    return [];
  }

  function clickCatalogNode(el) {
    const inner = el.querySelector('a[onclick], a, [onclick], span[onclick]');
    (inner || el).click();
  }

  /* ============================================================
   * 断点续刷 / 课程链（v3.2 新增）
   * ============================================================ */
  const RESUME_KEY = 'resume_v1';
  const VISITED_KEY = 'visitedCourses_v1';
  let resumeTried = false;
  let chainArmedAt = 0;

  /* 从 URL 里取 chapterId（经典学习页 URL 带这个参数） */
  function chapterIdFromUrl(url) {
    const m = /[?&]chapterId=(\d+)/i.exec(String(url || ''));
    return m ? m[1] : '';
  }

  /* 从一个目录节点上解析 chapterId。三种已知形态：
   *   1) onclick="toOld('courseId','chapterId','clazzId',0)"   ← 新版 mooc2 目录
   *   2) id="cur<chapterId>"                                    ← 新版当前节点标记
   *   3) onclick/href 里带 knowledgeId= 或 chapterId=           ← 其它版本
   * 刻意**不做**"取最长的数字串"这种猜测：courseId 也是长数字，猜错会跳到别的小节。 */
  function chapterIdOfNode(el) {
    if (!el) return '';
    try {
      const oc = (el.getAttribute && el.getAttribute('onclick')) || '';
      if (oc) {
        const m1 = /toOld\(\s*['"]?\d+['"]?\s*,\s*['"]?(\d{6,})['"]?/.exec(oc);
        if (m1) return m1[1];
        const m2 = /(?:knowledgeId|knowledgeid|chapterId|chapterid)\s*[=:]\s*['"]?(\d{6,})/.exec(oc);
        if (m2) return m2[1];
      }
      const id = String(el.id || '');
      const m3 = /^cur(\d{6,})$/.exec(id);
      if (m3) return m3[1];
      const href = (el.getAttribute && el.getAttribute('href')) || '';
      if (href) {
        const m4 = /(?:knowledgeId|chapterId)=(\d{6,})/i.exec(href);
        if (m4) return m4[1];
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  function currentChapterId() {
    let id = chapterIdFromUrl(location.href);
    if (id) return id;
    try { id = chapterIdFromUrl(win.top.location.href); } catch (e) { /* 跨域 */ }
    if (id) return id;
    return chapterIdOfNode(currentCatalogNode());
  }

  function courseIdOfHref(href) {
    const m = /[?&]courseId=(\d+)/i.exec(String(href || ''));
    return m ? m[1] : '';
  }

  /* 每 tick 记录当前小节（一分钟内同节不重复写，减少 GM 存储抖动） */
  function saveResumePoint() {
    if (!CFG.resume || !IS_TOP) return;
    const id = currentChapterId();
    if (!id) return;
    const prev = store.get(RESUME_KEY) || {};
    if (prev.id === id && Date.now() - (prev.at || 0) < 60000) return;
    store.set(RESUME_KEY, { id: id, at: Date.now() });
  }

  /* 页面加载后尝试跳回上次小节。只尝试一次：找不到就放弃，绝不反复跳转
   * （反复跳转正是最容易触发平台风控的行为）。 */
  function tryResume() {
    if (!CFG.resume || resumeTried || !IS_TOP) return;
    const saved = store.get(RESUME_KEY);
    if (!saved || !saved.id) { resumeTried = true; return; }
    const ageH = (Date.now() - (saved.at || 0)) / 3600000;
    const maxH = Number(CFG.resumeMaxAgeHours);
    if (!(ageH >= 0) || ageH > (Number.isFinite(maxH) ? maxH : 12)) { resumeTried = true; return; }
    const cur = currentChapterId();
    if (cur && cur === saved.id) { resumeTried = true; return; }   // 已经在上次那一节
    for (const d of allDocs()) {
      let nodes = [];
      try { nodes = Array.from(d.querySelectorAll('.chapter_item, .posCatalog_select, a')); } catch (e) { continue; }
      for (const n of nodes) {
        if (chapterIdOfNode(n) !== saved.id) continue;
        resumeTried = true;
        try { clickCatalogNode(n); } catch (e) { /* 忽略 */ }
        setAction('断点续刷：跳回上次所在小节（' + saved.id + '）', { force: true });
        log('断点续刷：跳回小节 ', saved.id);
        return;
      }
    }
    resumeTried = true;   // 目录里找不到（换课/换学期），放弃
  }

  /* 记录"进过哪些课"，课程链据此挑下一门 */
  function markVisitedCourse() {
    if (!IS_TOP) return;
    let cid = courseIdOfHref(location.href);
    if (!cid) { try { cid = courseIdOfHref(win.top.location.href); } catch (e) { /* 跨域 */ } }
    if (!cid) return;
    const v = store.get(VISITED_KEY) || {};
    if (v[cid]) return;
    v[cid] = Date.now();
    store.set(VISITED_KEY, v);
  }

  function chainArmed() {
    if (!chainArmedAt) return false;
    const maxMin = Number(CFG.courseChainMaxAgeMin);
    const win = (Number.isFinite(maxMin) ? maxMin : 5) * 60000;
    return Date.now() - chainArmedAt <= win;
  }

  /* 在课程列表页执行：挑一门没进过的课点进去 */
  function tryChainOnListPage() {
    if (!CFG.courseChain || !IS_TOP || !chainArmed()) return;
    const isList = /i\.chaoxing\.com\/base|fyportal\/courselist|mycourse\/index/i.test(location.href);
    if (!isList) return;
    const visited = store.get(VISITED_KEY) || {};
    const cands = [];
    for (const d of allDocs()) {
      try {
        const links = d.querySelectorAll('a[href*="entercourse"], a[href*="courseId="]');
        for (const a of links) {
          const href = a.getAttribute('href') || a.href || '';
          const cid = courseIdOfHref(href);
          if (!cid || visited[cid]) continue;
          if (!isVisible(a)) continue;
          cands.push({ a: a, cid: cid, href: href });
        }
      } catch (e) { /* 跨域 */ }
    }
    chainArmedAt = 0;   // 无论成功与否，只尝试一次
    if (!cands.length) {
      setAction('课程链：没有未开始过的课程，停止', { force: true });
      return;
    }
    const pick = cands[0];
    setAction('课程链：进入下一门课程（courseId=' + pick.cid + '）', { force: true });
    log('课程链：进入 ', pick.cid);
    try { pick.a.click(); } catch (e) {
      try { location.href = pick.href; } catch (e2) { /* 忽略 */ }
    }
  }

  /* ============================================================
   * 空小节跳过（v3.2.1）
   * ============================================================ */
  let emptySince = 0;
  const emptyJumped = new Set();   // 本次会话已因"空"跳过的 chapterId，避免来回跳
  let emptyJumpCount = 0;
  let emptyWindowStart = 0;

  function findCardsDoc() {
    for (const d of allDocs()) {
      try { if (/knowledge\/cards/.test(d.location.href)) return d; } catch (e) { /* 跨域 */ }
    }
    return null;
  }

  function tickEmptySection() {
    if (!CFG.skipEmptySection || !IS_TOP) return;
    const ch = currentChapterId();
    if (!ch) { emptySince = 0; return; }
    if (emptyJumped.has(ch)) return;      // 这一节已经因为空跳过，不再重复

    const cards = findCardsDoc();
    if (!cards) { emptySince = 0; return; }

    let attach = 0, questions = 0, videos = 0;
    try { attach = cards.querySelectorAll('.ans-attach-ct').length; } catch (e) { /* 忽略 */ }
    try { questions = cards.querySelectorAll('.TiMu, .questionLi, .ans-videoquiz, .TiMuNew').length; } catch (e) { /* 忽略 */ }
    try { videos = cards.querySelectorAll('video').length; } catch (e) { /* 忽略 */ }
    let text = '';
    try { text = String((cards.body && cards.body.innerText) || ''); } catch (e) { text = ''; }

    /* 四个条件必须同时成立：只要有一条不满足就当成"还在加载"，不跳。
     * 单看文案或单看元素数量都会把加载中的页面误判成空节。 */
    const isEmpty = attach === 0 && questions === 0 && videos === 0 &&
      /暂无内容|无内容|尚未发布|未开放/.test(text);
    if (!isEmpty) { emptySince = 0; return; }

    if (!emptySince) { emptySince = Date.now(); return; }   // 先观察一段，再决定
    const rawWait = Number(CFG.emptyWaitMs);
    const waitMs = Number.isFinite(rawWait) && rawWait >= 0 ? rawWait : 8000;
    if (Date.now() - emptySince < waitMs) return;

    /* 频率闸门：整章未发布时会有很多空节，无上限会连环跳 —— 那是最像机器人的行为 */
    const rawWin = Number(CFG.emptyWindowMin);
    const winMs = (Number.isFinite(rawWin) && rawWin > 0 ? rawWin : 10) * 60000;
    const rawMax = Number(CFG.emptyMaxJumps);
    const maxJumps = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 5;
    if (!emptyWindowStart || Date.now() - emptyWindowStart > winMs) {
      emptyWindowStart = Date.now();
      emptyJumpCount = 0;
    }
    if (emptyJumpCount >= maxJumps) {
      setAction('连续 ' + emptyJumpCount + ' 个空小节（老师可能整章未发布），已停止自动跳转', { lock: true });
      emptySince = 0;
      return;
    }

    emptySince = 0;
    emptyJumped.add(ch);
    emptyJumpCount++;
    setAction('本节暂无内容（未发布），自动跳到下一节（' + emptyJumpCount + '/' + maxJumps + '）', { force: true });
    log('空小节跳过：', ch);
    goNext();
  }

  function goNext() {
    const nodes = collectCatalogNodes();
    const cur = findCurrentNode();
    if (!nodes.length || !cur) {
      log('未定位到目录节点，跳过自动切换');
      stats.lastAction = '未找到下一任务点';
      return;
    }
    let idx = nodes.indexOf(cur);
    if (idx < 0) idx = nodes.findIndex((n) => n.contains(cur));
    if (idx < 0) {
      log('当前节点不在目录列表中，跳过自动切换');
      stats.lastAction = '未找到下一任务点';
      return;
    }
    const next = nodes[idx + 1];
    if (!next) {
      stats.lastAction = '已是最后一个任务点';
      /* 课程链：本课没有下一节了，标记就绪并回课程列表（是否真的换课见 tryChainOnListPage） */
      if (CFG.courseChain) {
        chainArmedAt = Date.now();
        setAction('本课已到最后一节，课程链就绪，正在回课程列表', { force: true });
        try { win.top.location.href = 'https://i.chaoxing.com/base'; } catch (e) { /* 忽略 */ }
      }
      return;
    }
    const label = (next.textContent || '').replace(/\s+/g, '').slice(0, 14);
    clickCatalogNode(next);
    try { sessionStorage.setItem('cxas_epoch', String(Date.now())); } catch (e) { /* 忽略 */ }
    stats.lastAction = '目录跳转到下一节：' + label;
    log('目录跳转到下一节：', label);
  }

  win.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__cxas) return;
    if (d.__cxas === 'STATS' && IS_TOP) {
      lastChildStatsAt = Date.now();
      Object.assign(stats, d.data || {}, { video: true });
      return;
    }
    if (d.__cxas === 'WORK_STATS' && IS_TOP) {
      // 纯题目页中继：只合并题目相关字段，不动 video（否则面板会说"视频已接管"）
      Object.assign(stats, d.data || {});
      return;
    }
    if (d.__cxas === 'NEXT' && IS_TOP && CFG.autoNext) setTimeout(goNext, 1500);
    if (d.__cxas === 'RELOAD' && IS_TOP) setTimeout(() => location.reload(), 600);
    if (d.__cxas === 'SOLVE_WORK') solveWork();
    if (d.__cxas === 'SUBMIT_WORK') submitWork();
  });

  function broadcast(msg) {
    const walk = (w) => {
      try {
        for (let i = 0; i < w.frames.length; i++) {
          w.frames[i].postMessage(msg, '*');
          walk(w.frames[i]);
        }
      } catch (e) { /* 跨域 */ }
    };
    walk(win);
  }

  /* ============================================================
   * 十、章节测验 / 作业
   * ============================================================ */
  let workLock = false;
  let workSolved = false;

  function isWorkPage() {
    return /\/work\/|mooc-ans\/work|quiz|homework|exam/i.test(location.pathname + location.search) ||
      !!doc.querySelector('.TiMu, .questionLi, .TiMuNew');
  }

  /* ---------------- 真实章节测验 DOM（t11/A1，real-dom.md §3.1）----------------
   * 真实结构：.singleQuesId > .TiMu[data] > .Zy_TItle + ul.Zy_ulTop > li.before-after
   * 选项里**没有 input**（实测 0 个 radio，只有每题 2 个 hidden），
   * 选中状态写在 li[aria-checked] / span.check_answer / hidden input[name=answer{qid}]。
   * 老 mock（有 input 的版本）继续作为兜底路径保留。 */
  const WORK_BLOCK_SELS = '.TiMu, .questionLi, .TiMuNew';
  const WORK_OPTION_SELS = ['li.before-after', '.Zy_ulTop > li', '.Zy_ulTop li'];

  // 真正的题目文档：真实环境题目在最内层 iframe（#frame_content），顶层只有外壳
  function findWorkDoc() {
    const docs = allDocs();
    for (const d of docs) {
      try {
        if (d.querySelector(WORK_BLOCK_SELS)) return d;
      } catch (e) { /* 跨域 */ }
    }
    return null;
  }

  function workOptionElements(block) {
    for (const sel of WORK_OPTION_SELS) {
      let list = [];
      try { list = Array.from(block.querySelectorAll(sel)); } catch (e) { list = []; }
      if (list.length) return list;
    }
    return [];
  }

  // 选项文字：真实结构是 <a class="fl after"><p>选项文字</p></a>
  function workOptionText(el) {
    const node = el.querySelector('.fl.after p, .fl.after, a.fl.after, .after');
    if (node && (node.textContent || '').trim()) {
      return node.textContent.replace(/\s+/g, ' ').trim();
    }
    // 兜底：整行文本扣掉标号/输入控件
    const clone = el.cloneNode(true);
    if (clone.querySelectorAll) {
      clone.querySelectorAll('span.num_option, span.num_option_dx, label, input').forEach((n) => n.remove());
    }
    return (clone.textContent || '').replace(/\s+/g, ' ').trim()
      .replace(/^[A-Ha-h][.、)）:：\s]+/, '');
  }

  // 选项的答案值：span.num_option[data] = A..H / true|false；判断题 fallback 看 aria-label
  function workOptionValue(el) {
    const span = el.querySelector('span.num_option[data], span.num_option_dx[data]');
    if (span) return String(span.getAttribute('data') || '').trim();
    const aria = String(el.getAttribute('aria-label') || '');
    if (/对选择|^对/.test(aria)) return 'true';
    if (/错选择|^错/.test(aria)) return 'false';
    return '';
  }

  /* 已作答三路判断：li[aria-checked=true] / span.check_answer(_dx) / hidden input[name^=answer]。
   * 注意 hidden 有两个前缀相同的字段：answer{qid} 与 answertype{qid}，必须排除后者。 */
  function workAnswerHidden(block) {
    try {
      return block.querySelector('input[name^="answer"]:not([name^="answertype"])');
    } catch (e) { return null; }
  }

  function workOptionSelected(block, opt) {
    if (opt.input && opt.input.checked) return true;
    if (String(opt.el.getAttribute('aria-checked')) === 'true') return true;
    if (opt.el.querySelector('span.check_answer, span.check_answer_dx')) return true;
    const hidden = workAnswerHidden(block);
    if (hidden) {
      const v = String(hidden.value || '').trim();
      if (v && opt.value) return v === opt.value || v.indexOf(opt.value) >= 0;
      if (v && !opt.value) return true;   // 拿不到选项值：至少说明这题写过答案
    }
    return false;
  }

  /* ---------------- 题型识别（t4/t22/t24，real-dom.md §3） ----------------
   * 不能靠 input.type 猜（真实客观题也没有 input），按"题型标签 → 数字码 → 结构"识别。
   * 注意这里和 detectWorkKind（页面类型：测验/作业/考试）是两件独立的事。
   *
   * t24 系统性修复：题型标签匹配**只保留一个严格整体正则 LABEL_RE**，
   * 不再使用任何 includes 式关键词判断（"文本里含有'计算'"≠"这是计算题"）。
   * 语义：整段（去空白后）就是一个题型标签 —— 允许前置题号 / 括号包裹 / 后缀（2分），
   * 但括号里的内容必须**整体**等于题型词，所以「以下（计算机网络）的说法」不会被判成计算题。
   * 可信来源（.newZy_TItle/.colorShallow）与弱来源（.TiMuTitle/.mark_name）
   * 用的是同一套正则；区别只在于"弱来源要不要启用"，而不在于匹配宽严。 */
  const QTYPE_LABEL = {
    single: '单选题', multiple: '多选题', fill: '填空题', judge: '判断题',
    subjective: '简答题', calc: '计算题', unknown: '未知题型',
  };
  const QTYPE_BY_CODE = {
    0: 'single', 1: 'multiple', 2: 'fill', 3: 'judge',
    4: 'subjective', 5: 'subjective', 6: 'subjective', 7: 'calc',
  };
  /* 严格整体标签正则（t24）：整段就是一个题型标签，不是"含有某词"。
   * 允许：前置题号 1. / 1、 / 1)；括号包裹【】()（）；后缀分值（2分）。 */
  const LABEL_RE = /^\s*(?:\d+\s*[.、)）:：]\s*)?[【(（]?\s*(单项选择题?|多项选择题?|单选题?|多选题?|判断题?|是非题|填空题?|简答题?|名词解释题?|论述题?|计算题?|分录题?|翻译题?|连线题?)\s*[】)）]?\s*(?:[（(]\s*\d+(\.\d+)?\s*分\s*[)）])?\s*$/;

  /* 标签词 → 题型：**精确查表**（去尾"题"后相等），不做前缀/包含判断。 */
  const QTYPE_BY_WORD = {
    '单项选择': 'single', '单选': 'single',
    '多项选择': 'multiple', '多选': 'multiple',
    '判断': 'judge', '是非': 'judge',
    '填空': 'fill',
    '简答': 'subjective', '名词解释': 'subjective', '论述': 'subjective',
    '分录': 'subjective', '翻译': 'subjective', '连线': 'subjective',
    '计算': 'calc',
  };

  // 整段是否为题型标签；是则返回题型，否则返回 ''
  function typeFromLabel(text) {
    const s = String(text || '');

    if (!s.replace(/\s+/g, '')) return '';
    const m = s.match(LABEL_RE);
    if (!m) return '';
    const word = String(m[1] || '').replace(/题$/, '');
    return QTYPE_BY_WORD[word] || '';
  }

  function questionTypeText(block) {
    try {
      // 可信来源（research 实证）：章节测验 / 作业考试的题型行
      const trusted = block.querySelector('.newZy_TItle, .colorShallow');
      if (trusted) return typeFromLabel(trusted.textContent);
      // 可疑来源：某些版本可能把题型写在这里，但同文件里它们是题干 → 同一套严格正则
      const weak = block.querySelector('.TiMuTitle, .mark_name');
      if (weak) return typeFromLabel(weak.textContent);
    } catch (e) { /* 忽略 */ }
    return '';
  }

  // 作业/考试的 typename（数字码，源码实证）；与 .TiMu[data] 分开，后者只是最后兜底
  function attrCode(block, name) {
    try {
      const v = block.getAttribute && block.getAttribute(name);
      if (v != null && /^\d+$/.test(String(v).trim())) return String(v).trim();
    } catch (e) { /* 忽略 */ }
    return '';
  }
  function questionTypeWorkCode(block) { return attrCode(block, 'typename'); }
  function questionTypeDataCode(block) { return attrCode(block, 'data'); }

  // 判断题选项词表：对/错、正确/错误、是/否、√/×、✓/✗、True/False，允许 "A对"/"A. 对" 前缀
  function isJudgeOptionText(t) {
    const s = String(t || '')
      .replace(/^[A-Da-d][.、)）:：\s]*/, '')
      .replace(/\s+/g, '');
    return /^(对|错|正确|错误|是|否|√|×|✓|✗|true|false)/i.test(s);
  }

  function detectQuestionType(block) {
    if (!block || !block.querySelector) return { type: 'unknown', source: 'none' };
    // 1) 题型文字（t22/F1：可疑来源已加守卫，题干不会再把题判歪）
    const byText = questionTypeText(block);
    if (byText) return { type: byText, source: 'text' };
    // 2) 作业/考试的 typename 数字码（源码实证，可信）
    const workCode = questionTypeWorkCode(block);
    if (workCode && QTYPE_BY_CODE[workCode]) return { type: QTYPE_BY_CODE[workCode], source: 'typename' };
    // 3) 结构兜底
    let areas = [];
    try { areas = Array.from(block.querySelectorAll('textarea, [contenteditable="true"]')); } catch (e) { areas = []; }
    if (areas.length) return { type: 'subjective', source: 'structure' };
    let opts = [];
    try { opts = workOptionElements(block); } catch (e) { opts = []; }
    if (opts.length) {
      const texts = opts.map((el) => String(el.textContent || '').replace(/\s+/g, ''));
      // 两选项且是"对/错"类表述才判判断题；其它两选项按单选处理（边界用例）
      const judgeLike = opts.length === 2 && texts.every(isJudgeOptionText);
      if (judgeLike) return { type: 'judge', source: 'structure' };
      const multi = opts.some((el) => {
        try {
          if (el.querySelector && el.querySelector('input[type=checkbox]')) return true;
          return String(el.getAttribute && el.getAttribute('role')) === 'checkbox';
        } catch (e) { return false; }
      });
      return { type: multi ? 'multiple' : 'single', source: 'structure' };
    }
    /* 4) 最后兜底：.TiMu[data]（t22/F4）。
     * research 只实证了 data=0/3；data=1/2 是推测，所以只在"文字与结构都判不出"时才用，
     * 绝不和作业页的 typename 同级。 */
    const dataCode = questionTypeDataCode(block);
    if (dataCode && QTYPE_BY_CODE[dataCode]) return { type: QTYPE_BY_CODE[dataCode], source: 'data' };
    return { type: 'unknown', source: 'none' };
  }

  // 该题型是否允许作答（配置开关）
  function typeAllowed(type) {
    if (type === 'single' || type === 'multiple' || type === 'judge') return !!CFG.answerObjective;
    if (type === 'fill') return !!CFG.answerFill;
    if (type === 'subjective') return !!CFG.answerSubjective;
    if (type === 'calc') return !!CFG.answerCalc;
    return false;   // unknown：不猜
  }

  // 无答案兜底：默认随机（fallbackRandom），不再固定第一个（"全选 A" 是机械化特征）
  function fallbackIndex(len) {
    if (!(len > 0)) return 0;
    if (CFG.fallbackRandom) return Math.floor(Math.random() * len);
    return CFG.fallback === 'random' ? Math.floor(Math.random() * len) : 0;
  }

  /* 主观题落点：优先 UEditor（真实富文本的提交值在编辑器实例里，直接写 textarea 无效），
   * UE 不存在/未就绪时降级为 textarea.value + input/change 事件（绝不因 UE 缺失就放弃）。 */
  function setTextValue(el, text) {
    if (!el) return false;
    const val = String(text == null ? '' : text);
    try {
      const w = (el.ownerDocument && el.ownerDocument.defaultView) || win;
      const UE = w.UE;
      const id = el.id || (el.getAttribute && el.getAttribute('name')) || '';
      if (UE && id && typeof UE.getEditor === 'function') {
        const ed = UE.getEditor(id);
        if (ed && typeof ed.setContent === 'function') { ed.setContent(val); return true; }
      }
    } catch (e) { /* 降级 */ }
    try {
      el.value = val;
      const Ev = (el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.Event) || Event;
      el.dispatchEvent(new Ev('input', { bubbles: true }));
      el.dispatchEvent(new Ev('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  function parseWorkQuestions(docRoot) {
    const root = docRoot || doc;
    const blocks = root.querySelectorAll(WORK_BLOCK_SELS);
    return Array.from(blocks).map((block) => {
      const qEl = block.querySelector('.Zy_TItle, .mark_name, .fl.textCon, .TiMuTitle, .title');
      let question = '';
      if (qEl) {
        const clone = qEl.cloneNode(true);
        if (clone.querySelectorAll) clone.querySelectorAll('i.fl, .num_option').forEach((n) => n.remove());
        question = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      } else {
        question = block.textContent.replace(/\s+/g, ' ').trim();
      }
      const options = workOptionElements(block).map((el) => ({
        el,
        input: el.querySelector('input'),
        text: workOptionText(el),
        value: workOptionValue(el),
      })).filter((o) => o.text || o.value);
      const textInputs = Array.from(block.querySelectorAll(
        'textarea[id^="answer"], textarea, input[type=text], input:not([type])'
      )).filter((i) => !i.closest('ul'));
      return { block, question, options, textInputs };
    }).filter((q) => q.options.length || q.textInputs.length);
  }

  /* 落答案：点选 → 校验 → 未生效再点标号；绝不假报已作答（t11/A1）。 */
  function applyWorkAnswer(block, options, picked) {
    let verified = 0;
    options.forEach((o, i) => {
      if (!picked.has(i)) return;
      if (workOptionSelected(block, o)) { verified++; return; }   // 已选中：再点会变取消
      if (o.input) o.input.click();
      else o.el.click();                                          // onclick="addChoice(this)"
      if (!workOptionSelected(block, o)) {
        const num = o.el.querySelector('span.num_option, span.num_option_dx');
        if (num) num.click();
      }
      if (workOptionSelected(block, o)) verified++;
      else warn('选项未选中：', o.text || o.value);
    });
    return verified;
  }

  /* 识别当前题目页属于哪一类。
   * 这个判断决定"敢不敢自动提交"——章节测验可重做取最高分，作业往往只有一次机会，
   * 考试绝对不能被自动提交。判不准时一律当 unknown（只答不交）。 */
  function detectWorkKind() {
    const titleEl = doc.querySelector('.mark_title, .workTitle, .mark_name, h1, .title');
    const title = ((doc.title || '') + ' ' + (titleEl ? titleEl.textContent : '')).replace(/\s+/g, ' ');
    const href = location.href || '';
    if (/\/exam\/|exam-ans|reVersionTestStartNew/i.test(href) || /考试/.test(title)) return 'exam';
    if (/章节测验|测验|quiz/i.test(title)) return 'quiz';
    if (/作业|homework/i.test(title)) return 'homework';
    // 标题没有线索时看 URL：学习通的测验与作业都走 /work/，无法区分 → unknown
    if (/\/work\/|mooc-ans\/work/i.test(href)) return 'work';
    return 'unknown';
  }

  /* t11/A2：真实提交确认层
   *   新版：**顶层文档** `.popDiv.Marking`（常驻 DOM，用 width>0 判可见）→ 点文本以「提交」开头的 a.jb_btn
   *   老版：`#workpop a#popok`
   *   `.popup_confirm` / `.layui-layer-btn0` 在真实环境没有来源，只留作最后兜底。
   * 绝不点「取消」——只认 /^\s*提交/ 的按钮。 */
  let lastConfirmClicked = null;   // 同一个确认按钮只点一次，避免重复提交

  function visibleIn(el) {
    // t28/F4：宽高都要 > 0（只判 width 会把细缝元素当成可见，与文档描述不符）
    try {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  /* 跨 frame 只点一次：确认按钮是同一个 DOM 对象（同源 iframe 共享），
   * 在它上面挂标记即可防止顶层与题目 iframe 各点一次（重复提交）。 */
  function clickOnce(el) {
    if (!el) return false;
    if (el.__cxasClicked || el === lastConfirmClicked) return false;
    el.__cxasClicked = true;
    lastConfirmClicked = el;
    try { el.click(); return true; } catch (e) { el.__cxasClicked = false; return false; }
  }

  function confirmSubmitDialog() {
    const docs = allDocs();
    // 1) 新版：可见的 .popDiv（文本含"确认提交"优先，否则取第一个可见的）
    let pops = [];
    for (const d of docs) {
      try { d.querySelectorAll('.popDiv').forEach((p) => pops.push(p)); } catch (e) { /* 跨域 */ }
    }
    pops = pops.filter(visibleIn);
    if (pops.length) {
      const target = pops.find((p) => /确认提交/.test(p.textContent || '')) || pops[0];
      const btns = Array.from(target.querySelectorAll('a.jb_btn, .jb_btn'));
      const ok = btns.find((b) => /^\s*提交/.test((b.textContent || '').trim()));
      if (ok && clickOnce(ok)) {
        log('已点确认层 .popDiv 的「' + (ok.textContent || '').trim() + '」');
        return true;
      }
      if (ok) return false;   // 已经点过同一个按钮：不再重复点
    }
    // 2) 老版 ananas：#workpop a#popok
    for (const d of docs) {
      try {
        const old = d.querySelector('#workpop a#popok');
        if (old && visibleIn(old) && clickOnce(old)) {
          log('已点老版确认层 #workpop #popok');
          return true;
        }
      } catch (e) { /* 跨域 */ }
    }
    // 3) 页面函数兜底：work iframe 的 window.submitCheckTimes()
    for (const d of docs) {
      try {
        const w = d.defaultView;
        if (w && typeof w.submitCheckTimes === 'function') { w.submitCheckTimes(); log('已调用 submitCheckTimes()'); return true; }
      } catch (e) { /* 跨域 */ }
    }
    // 4) 旧选择器兜底（.popup_confirm 无来源，只做最后尝试，且只认"确定/确认"文案）
    const legacy = ['.popup_confirm .btnOk', '.layui-layer-btn0', '#popok', '.confirmBtn'];
    for (const d of docs) {
      for (const s of legacy) {
        try {
          const b = d.querySelector(s);
          if (b && isVisible(b) && clickOnce(b)) {
            log('已点确认弹窗(兜底):', s);
            return true;
          }
        } catch (e) { /* 跨域 */ }
      }
    }
    // 5) 文案兜底：只认"确定/确认/是"，不认"取消"
    for (const d of docs) {
      try {
        const btn = Array.from(d.querySelectorAll('button, a, .btn, span'))
          .find((el) => isVisible(el) && /^(确定|确认|是)$/.test((el.textContent || '').trim()));
        if (btn && clickOnce(btn)) { log('已点确认弹窗(文案)'); return true; }
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  // 提交成功判据：页面出现「已完成 / 本次成绩 / 最终成绩 / 待批阅」文本（real-video.md §6.1）
  function workResultText() {
    for (const d of allDocs()) {
      try {
        const t = (d.body && d.body.textContent) || '';
        const m = t.match(/(已完成[^。\n]{0,30}|本次成绩[^。\n]{0,16}|最终成绩[^。\n]{0,16}|待批阅)/);
        if (m) return m[0].replace(/\s+/g, '');
      } catch (e) { /* 跨域 */ }
    }
    return '';
  }

  /* 读本次成绩的分数（0-100 或百分制比例）。
   * 这是**唯一能验证答题准确率的真实信号**——面板的"命中率"只表示"有没有答案"，
   * 不代表答对。拿到分数后写进 stats 与作答日志，用于：
   *   1) 让用户看到真实准确率（而不是靠感觉）
   *   2) 为将来的"错题重做"提供判据 */
  function readWorkScore() {
    for (const d of allDocs()) {
      try {
        const t = (d.body && d.body.textContent) || '';
        /* 覆盖常见写法：
         *   「本次成绩 80 分」「最终成绩：85.5」「得分 90」「成绩 92分」
         *   「本次成绩 80/100」                                            */
        let m = t.match(/(?:本次成绩|最终成绩|得分|成绩)[^\d\n]{0,8}(\d{1,3}(?:\.\d)?)\s*(?:分|\/\s*(\d{1,3}))?/);
        if (m) {
          const v = parseFloat(m[1]);
          if (isFinite(v) && v >= 0 && v <= 100) return Math.round(v * 10) / 10;
        }
        // 百分制「已完成」页上的 "80%"
        m = t.match(/(?:成绩|得分)[^\d\n]{0,8}(\d{1,3}(?:\.\d)?)\s*%/);
        if (m) {
          const v = parseFloat(m[1]);
          if (isFinite(v) && v >= 0 && v <= 100) return Math.round(v * 10) / 10;
        }
      } catch (e) { /* 跨域 */ }
    }
    return null;
  }

  /* 真实可用的"下一节"按钮（real-video.md §5.1）：`#prevNextFocusNext` /
   * `.jb_btn.jb_btn_92.fr.fs14.nextChapter`。两者都是**整页跳转**，所以：
   *   1) 只在"确认提交成功 + 仍在题目/批阅页 + 15s 内没发过 NEXT"时才点；
   *   2) 点之前复用 jumpGuard/markJumped + cxas_epoch 防重复；
   *   3) 返回 true 表示"这一跳已经处理"，调用方不要再 postNext（否则双跳）。 */
  function clickRealNext() {
    if (Date.now() - nextPostedAt < 15000) {
      log('已发过 NEXT，跳过「下一节」按钮（防双跳）');
      return false;
    }
    if (Date.now() - lastNextClickAt < 15000) {
      log('刚点过「下一节」，跳过（防重）');
      return true;
    }
    // 已经不在题目/批阅页（例如已回到课程页）：交给目录跳转，不点整页跳转按钮
    if (!findWorkDoc()) return false;
    /* guard key 必须用**顶层 URL**：题目 iframe 与顶层文档的 location 不同，
     * 用 location.href 会让"另一个 frame 已经点过"这件事查不到（t20 实测复现：
     * 顶层再调一次 backToCourse 会重复点，nextClicks 1→2）。 */
    let topHref = '';
    try { topHref = win.top.location.href; } catch (e) { topHref = location.href; }
    const guardKey = 'next|' + (topHref || '');
    if (jumpGuardHit(guardKey)) {
      log('本页已点过「下一节」，跳过（jumpGuard）');
      return true;
    }
    for (const d of allDocs()) {
      try {
        const btn = d.querySelector('#prevNextFocusNext, .jb_btn.jb_btn_92.fr.fs14.nextChapter');
        if (btn && isVisible(btn)) {
          markJumped(guardKey);
          lastNextClickAt = Date.now();
          try { sessionStorage.setItem('cxas_epoch', String(Date.now())); } catch (e) { /* 忽略 */ }
          btn.click();
          stats.lastAction = '已点「下一节」（整页跳转）';
          log(stats.lastAction);
          return true;
        }
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  /* 提交成功后回到课程/下一节（t20/F1：按"有来源 → 无来源"重排）
   * 1) 真实可用的下一节按钮（带防双跳守卫）
   * 2) 文案兜底：返回/返回课程/继续学习/下一节/下一个
   * 3) history.back()
   * 注意：`.backBtn/.returnBtn/.btnBack/#backBtn/.completeBtn/.viewResult .back` 在本轮
   * research 里**找不到任何来源**（real-dom.md §7），已从代码删除；
   * 之前把它们当首选、commit 说明却写"兜底"，是 t12 判不通过的直接原因。 */
  /* 判断某个元素是不是"下一节"整页跳转按钮。
   * 文案兜底必须排除它——否则「下一节」三个字会被文案正则命中，
   * 绕过 clickRealNext 的 jumpGuard/postNext 闸门（t20 实测：postNext 后仍被点，nextClicks 1→2）。 */
  function isRealNextEl(el) {
    try {
      if (!el) return false;
      if (el.id === 'prevNextFocusNext') return true;
      if (el.classList && el.classList.contains('nextChapter')) return true;
      if (el.closest && el.closest('#prevNextFocusNext')) return true;
      return false;
    } catch (e) { return false; }
  }

  function backToCourse() {
    if (clickRealNext()) return true;
    for (const d of allDocs()) {
      try {
        const btn = Array.from(d.querySelectorAll('a, button'))
          .find((el) => isVisible(el) && !isRealNextEl(el) &&
            /^(返回|返回课程|继续学习|下一节|下一个)$/.test((el.textContent || '').trim()));
        if (btn) { btn.click(); stats.lastAction = '已点「' + btn.textContent.trim() + '」'; return true; }
      } catch (e) { /* 跨域 */ }
    }
    try {
      if (win.history && win.history.length > 1) { win.history.back(); stats.lastAction = '已回退到上一页'; return true; }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 提交主流程：点击提交 → 轮询确认层（探测到才点）→ 等成绩文本 → 返回/跳转
  function doSubmit(kind, docRoot) {
    const root = docRoot || findWorkDoc() || doc;
    const btn =
      root.querySelector('a.btnSubmit, .btnSubmit, #submitBtn, .submitBtn, .BtnSubmit') ||
      root.querySelector('.Btn_blue_1') ||                       // 更老的版本
      Array.from(root.querySelectorAll('a, button'))
        .find((b) => /^\s*提交\s*$/.test((b.textContent || '').trim()));
    if (!btn) {
      // 页面函数兜底：work iframe 自己的 btnBlueSubmit()
      try {
        const w = root.defaultView;
        if (w && typeof w.btnBlueSubmit === 'function') {
          w.btnBlueSubmit();
          stats.lastAction = '已调用页面函数 btnBlueSubmit()';
          log(stats.lastAction);
        } else {
          stats.lastAction = '未找到提交按钮（a.btnSubmit/.Btn_blue_1/btnBlueSubmit 均未命中）';
          warn(stats.lastAction);
          return false;
        }
      } catch (e) {
        stats.lastAction = '未找到提交按钮且页面函数调用失败';
        warn(stats.lastAction, e);
        return false;
      }
    } else {
      // 跨 frame 防重复提交：同一个按钮对象上挂标记，另一个 frame 就不会再点一次
      if (btn.__cxasSubmitted) {
        stats.lastAction = '提交按钮已被另一个 frame 点过，跳过重复提交';
        return false;
      }
      btn.__cxasSubmitted = true;
      // 提交按钮常在长页面底部：先滚过去再点，避免视口外点击不生效
      try { btn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
      try { btn.click(); } catch (e) { btn.__cxasSubmitted = false; stats.lastAction = '提交按钮点击失败'; return false; }
      stats.lastAction = '已点提交（' + kind + '），等待确认层…';
      log('已点提交:', kind);
    }

    // 确认层可能延迟出现：每 500ms 探测一次，共 8 次；探测到才点（不再 600/1500/2800 盲点）
    if (CFG.autoConfirmSubmit) {
      let tries = 0;
      const probe = () => {
        tries++;
        if (confirmSubmitDialog()) { stats.lastAction = '已确认提交'; return; }
        if (tries < 8) setTimeout(probe, 500);
        else {
          stats.lastAction = '未探测到确认层（可能版本不同），提交结果未知';
          warn(stats.lastAction);
        }
      };
      setTimeout(probe, 500);
    }

    // 提交后：等成绩文本出现再回课程/跳下一节（真实环境不整页跳转，内层 iframe 自己刷新成批阅页）
    if (CFG.autoNextAfterWork) {
      let waited = 0;
      const waitResult = () => {
        const txt = workResultText();
        if (txt) {
          /* 拿到成绩文本时顺便读分数：这是唯一能验证"答得对不对"的真实信号，
           * 记进 stats 与日志，用户才能知道准确率到底多少。 */
          const score = readWorkScore();
          if (score !== null) {
            stats.lastScore = score;
            stats.lastScoreAt = Date.now();
            recordLog('score', '本次成绩', String(score), 'ai', [], new Set());
            log('本次成绩：' + score + ' 分');
          }
          stats.lastAction = '提交成功：' + txt + (score !== null ? '（' + score + ' 分）' : '');
          if (!backToCourse()) postNext();   // 回不去就让顶层目录跳转兜底
          return;
        }
        waited += 1000;
        if (waited < 20000) { setTimeout(waitResult, 1000); return; }
        stats.lastAction = '提交结果未知（20s 内未见成绩文本），请手动确认';
        warn(stats.lastAction);
      };
      setTimeout(waitResult, Math.max(1500, CFG.workSubmitDelay));
    }
    return true;
  }

  /* ============================================================
   * t6 / 板块③：两遍法（先全量采集，再统一作答）
   * ------------------------------------------------------------
   * 章节测验确认**不分页**（research/real-dom.md §2，三份独立证据），所以"两遍法"=
   *   第一遍：把整页题面/选项/输入控件**只读**采集下来（绝不点任何选项）；
   *   第二遍：按采集顺序统一作答，最后走原有的提交链路。
   * 采集阶段为什么绝对不能点：
   *   ① 字体混淆只在"待作答态"，点开选项可能还原成明文，会污染解码映射；
   *   ② 部分测验附件限制打开次数（每节可能只有一次机会）。
   * 分页的只有考试（exam-ans 域）：见到「不允许整卷预览」就走"边翻边答"，
   * 也不能走两遍法——看不到全部题目，预先采集没有意义。
   * ============================================================ */

  /* 长页面/懒加载处理：题目多的时候学习通会分片渲染，
   * 只有滚动到附近才把后面的题插进 DOM。不滚动就采集，会漏掉后半页。
   *
   * 做法：反复滚到底 → 等一帧 → 数题目块；数量不再增加就停（有上限防死循环）。
   * 结束后回顶部，保持页面状态干净。失败不影响主流程（try/catch 包住）。 */
  async function scrollToLoadAll(docRoot, maxRounds) {
    const root = docRoot || findWorkDoc() || doc;
    const win = root.defaultView || (root === doc ? win : null);
    if (!win || typeof win.scrollTo !== 'function') return 0;
    const countBlocks = () => {
      try { return root.querySelectorAll(WORK_BLOCK_SELS).length; } catch (e) { return 0; }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let last = countBlocks();
    const rounds = Math.max(1, Math.min(12, maxRounds || 8));
    let grew = false;
    for (let i = 0; i < rounds; i++) {
      try {
        const h = (root.body && root.body.scrollHeight) || 0;
        win.scrollTo(0, h);
      } catch (e) { break; }
      await sleep(280);                     // 让懒加载把新内容插进来
      const now = countBlocks();
      if (now > last) { last = now; grew = true; continue; }
      if (now === last) break;              // 不再增长 = 加载完了
    }
    try { win.scrollTo(0, 0); } catch (e) { /* 忽略 */ }
    if (grew) log('滚动加载完成，题目块从', countBlocks(), '增至', last);
    return last;
  }

  /* 作答前把题目滚进视口：一是让「是否可见」这类前端判断通过，
   * 二是真实用户本来就会滚动到题目再点——顺便让行为更像人。 */
  function focusBlock(block) {
    if (!block || typeof block.scrollIntoView !== 'function') return;
    try { block.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
  }

  /* 页面自己声明的题目总数（「共 20 题」「全部 12 道题」之类）。
   * 用途：采集后对比实际拿到多少题——数量对不上说明有分页或懒加载没触发完，
   * 必须让用户看见，而不是静默只答一半。 */
  function expectedQuestionCount() {
    for (const d of allDocs()) {
      try {
        const t = (d.body && d.body.textContent) || '';
        const m = t.match(/(?:共|全部|总计|总)\s*(\d{1,3})\s*(?:道|个)?\s*题/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (isFinite(n) && n > 0 && n <= 500) return n;
        }
      } catch (e) { /* 跨域 */ }
    }
    return null;
  }

  /* 阶段一：全量采集（纯读）。题型直接复用 detectQuestionType，采集阶段不再另判一次，
   * 避免两处口径漂移（t4/t22/t24 的接口约定）。 */
  function collectQuestions(root) {
    const questions = parseWorkQuestions(root);
    const dist = {};
    questions.forEach((q) => {
      const t = detectQuestionType(q.block);
      q.type = t.type;
      q.typeSource = t.source;
      dist[t.type] = (dist[t.type] || 0) + 1;
    });
    const distText = Object.keys(dist).map((k) => QTYPE_LABEL[k] + dist[k]).join(' ');
    return { questions, dist, distText };
  }

  // 统一预解码：把整页题面一次性交给 FONT，而不是逐题触发（解码映射一次覆盖全部题）
  async function prepareCollectStems(questions) {
    try {
      const stems = questions.map((q) => q.question).filter(Boolean);
      if (stems.length && FONT && typeof FONT.prepare === 'function') await FONT.prepare(stems);
    } catch (e) { log('采集阶段预解码失败：', (e && e.message) || e); }
  }

  /* 单题作答：两遍法的第二遍与分页模式的当页作答共用（保证两条路径口径一致）。
   * 返回 'done' | 'skipped'（已作答）| 'skippedType'（题型策略跳过）| 'unverified' | 'fontFail' */
  async function answerOne(q) {
    const type = q.type || 'unknown';
    let answer = null, src = 'none', fontFail = false;
    try {
      const r = await getAnswer(q.question, q.options, type);
      answer = r.answer; src = r.src; fontFail = !!r.fontFail;
    } catch (e) { answer = null; src = 'none'; }

    if (fontFail) {
      recordLog('work', q.question, null, 'none', q.options, new Set());
      return 'fontFail';
    }
    /* t26/L5：采集与作答之间若平台重渲染，采到的 DOM 引用会脱离文档；在游离节点上点/填都是白费。
     * 记 unverified（面板可见、不假报），直接跳过这一题。 */
    if (q.block && q.block.isConnected === false) {
      recordLog('work', q.question, null, 'none', q.options, new Set());
      log('题目块已脱离文档（页面重渲染），跳过：', q.question.slice(0, 24));
      return 'unverified';
    }
    /* 题型策略：不允许作答的题型什么都不点也不填；题目与 hidden 字段保持原样，
     * 页面提交时题号仍然齐全（提交参数完整，不会因空着卡流程）。 */
    if (!typeAllowed(type)) {
      recordLog('work', q.question, null, 'none', q.options, new Set());
      log('按题型策略跳过：', QTYPE_LABEL[type], '（来源 ' + (q.typeSource || '?') + '）', q.question.slice(0, 24));
      return 'skippedType';
    }
    if (type === 'single' || type === 'multiple' || type === 'judge') {
      // 已作答三路判断：真实页面重进时会保留上次选择，再点一次会变成"取消选择"
      if (q.options.some((o) => workOptionSelected(q.block, o))) {
        recordLog('work', q.question, null, 'none', q.options, new Set());
        return 'skipped';
      }
      let picked = pickIndexes(q.options, answer);
      if (!picked.size && CFG.fallback !== 'none') {
        picked = new Set([fallbackIndex(q.options.length)]);
        src = 'fallback';
      }
      /* 作答前把题目滚进视口：长页面里视口外的元素，某些前端会拦点击或被"是否可见"判断挡住。
       * 真人也是先滚到题再点——顺带让行为更像人。 */
      focusBlock(q.block);
      const verified = applyWorkAnswer(q.block, q.options, picked);
      recordLog('work', q.question, answer, src, q.options, picked);
      return verified >= picked.size ? 'done' : 'unverified';
    }
    if (type === 'fill') {
      const blanks = q.textInputs;
      const parts = String(answer || '').split(/[;；|]/).map((s) => s.trim()).filter(Boolean);
      // 分段数与空位数对不上就放弃（research §3.3：宁可不填，也不把答案错位塞进别的空）
      if (!answer || !blanks.length || parts.length !== blanks.length) {
        stats.lastAction = '填空题答案段数与空位数不匹配，已跳过（' +
          (parts.length || 0) + '/' + blanks.length + '）';
        recordLog('work', q.question, answer, src, [], new Set());
        return 'unverified';
      }
      let ok = 0;
      blanks.forEach((inp, i) => { if (setTextValue(inp, parts[i])) ok++; });
      recordLog('work', q.question, answer, src, [], new Set());
      return ok === blanks.length ? 'done' : 'unverified';
    }
    if (type === 'subjective' || type === 'calc') {
      // 走到这里说明 answerSubjective / answerCalc 被打开
      const area = q.textInputs[0];
      if (area && answer) {
        const ok = setTextValue(area, answer);
        recordLog('work', q.question, answer, src, [], new Set());
        return ok ? 'done' : 'unverified';
      }
      recordLog('work', q.question, null, 'none', [], new Set());
      return 'unverified';
    }
    recordLog('work', q.question, null, 'none', [], new Set());
    return 'unverified';
  }

  /* ---------------- 分页兜底（考试域，exam-ans） ---------------- */
  function isPagedExam() {
    for (const d of allDocs()) {
      try {
        const el = d.querySelector('.mark_info');
        if (el && /不允许整卷预览/.test(el.textContent || '')) return true;
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  // 当前页题目签名：用于判断"翻页后题目有没有变化"（防死循环）
  function examPageSignature(root) {
    try {
      return Array.from(root.querySelectorAll(WORK_BLOCK_SELS))
        .map((b) => String(b.textContent || '').replace(/\s+/g, '').slice(0, 40))
        .join('|');
    } catch (e) { return ''; }
  }

  // 翻下一页：优先 .nextDiv 里的「下一题」，其次页面函数 getTheQuestionByStart(start,'0')
  function clickExamNext(root) {
    try {
      const btns = Array.from(root.querySelectorAll('.nextDiv .jb_btn, .nextDiv a, .nextDiv button'));
      const next = btns.find((b) => isVisible(b) && /下一?题|下一页/.test((b.textContent || '').trim()));
      if (next) { next.click(); return true; }
    } catch (e) { /* 忽略 */ }
    try {
      const w = (root.defaultView) || win;
      if (w && typeof w.getTheQuestionByStart === 'function') {
        const li = root.querySelector('.topicNumber_list li[onclick]');
        const m = String((li && li.getAttribute('onclick')) || '').match(/(\d+)/);
        const start = m ? m[1] : '';
        if (start) { w.getTheQuestionByStart(start, '0'); return true; }
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /* 分页模式：**不走两遍法**（看不到全部题），边翻页边采集边作答；
   * 每题单独跑 FONT.prepare；最多 50 页；翻页失败/题目不变都会退出（防死循环）。
   * 考试默认 autoSubmitExam=false，所以这里只答不交。 */
  async function solvePagedExam(root) {
    if (workLock) return;
    workLock = true;
    /* 分页判据只有 .mark_info 的「不允许整卷预览」这一条——research 的实证结论；
     * 多加信号反而可能误判。缺这句时会退回两遍法（只答第一页，考试不自动交，安全）。 */
    const maxPages = Math.max(1, Math.min(200, Number(CFG.examMaxPages) || 50));
    try {
      stats.mode = 'paged';
      stats.collected = 0;
      stats.answered = 0;
      stats.lastAction = '检测到逐题分页考试（不允许整卷预览），改用边翻页边作答';
      log(stats.lastAction);
      if (!IS_TOP) relayWorkStats();
      if (hud && hud.__refresh) hud.__refresh();

      let page = 0;
      let answered = 0;
      let seenCount = 0;
      const distAll = {};
      const seenSig = new Set();
      while (page < maxPages) {
        const sig = examPageSignature(root);
        if (sig && seenSig.has(sig)) {
          stats.lastAction = '分页：题目内容重复（第 ' + (page + 1) + ' 页），退出防死循环';
          warn(stats.lastAction);
          break;
        }
        if (sig) seenSig.add(sig);
        page++;
        const collected = collectQuestions(root);
        const questions = collected.questions;
        if (!questions.length) {
          stats.lastAction = '分页：第 ' + page + ' 页未找到题目，退出';
          warn(stats.lastAction);
          break;
        }
        seenCount += questions.length;
        Object.keys(collected.dist).forEach((k) => { distAll[k] = (distAll[k] || 0) + collected.dist[k]; });
        stats.collected = seenCount;
        stats.qtypes = Object.keys(distAll).map((k) => QTYPE_LABEL[k] + distAll[k]).join(' ');
        await prepareCollectStems(questions);      // 分页：每页单独预解码
        for (const q of questions) {
          const r = await answerOne(q);
          if (r === 'done') answered++;
          stats.answered = answered;
          if (!IS_TOP) relayWorkStats();
          await new Promise((res) => setTimeout(res, 1200 + Math.random() * 2000));
        }
        stats.work = answered;
        stats.lastAction = '分页第 ' + page + ' 页已作答（累计 ' + answered + ' 题）';
        if (hud && hud.__refresh) hud.__refresh();
        if (page >= maxPages) {
          stats.lastAction = '分页：达到最大页数 ' + maxPages + '，停止（已答 ' + answered + ' 题）';
          warn(stats.lastAction);
          break;
        }
        const before = sig;
        if (!clickExamNext(root)) {
          stats.lastAction = '分页：没有「下一题」，结束（已答 ' + answered + ' 题）';
          break;
        }
        await new Promise((res) => setTimeout(res, 1500));
        const after = examPageSignature(root);
        if (after === before) {
          stats.lastAction = '分页：翻页后题目未变化，退出防死循环（已答 ' + answered + ' 题）';
          warn(stats.lastAction);
          break;
        }
      }
      stats.lastAction = stats.lastAction + ' · 分页模式不自动交卷';
    } catch (e) {
      // t26/L1：async 里抛错绝不能把 workLock 留在 true（否则整页永久不再重试，只能刷新）
      setAction('分页作答异常：' + ((e && e.message) || e) + '（请刷新页面重试）', { lock: true });
      warn('分页作答异常', e);
    } finally {
      workLock = false;
      if (!IS_TOP) relayWorkStats();
      if (hud && hud.__refresh) hud.__refresh();
    }
  }

  /* t26/L1：async 主体必须 try/finally —— 调用方（tickWork 与 SOLVE_WORK 消息）都不 await/catch，
   * 内部一旦抛错，workLock 会停在 true、workSolved 已是 true → 该页永久不再重试，只能刷新页面。 */
  async function solveWork(docRoot) {
    if (workLock) return;
    try {
      await solveWorkInner(docRoot);
    } catch (e) {
      setAction('作答异常：' + ((e && e.message) || e) + '（请刷新页面重试）', { lock: true });
      warn('作答异常', e);
    } finally {
      workLock = false;
      if (!IS_TOP) relayWorkStats();
      if (hud && hud.__refresh) hud.__refresh();
    }
  }

  async function solveWorkInner(docRoot) {
    if (workLock) return;
    const root = docRoot || findWorkDoc() || doc;
    /* 跨 frame 互斥：同源 iframe 里拿到的是**同一个 document 对象**，在它上面挂 expando 就能被
     * 所有 frame 看到。否则顶层脚本与题目所在 iframe 的脚本会同时作答（再点一次 = 取消选择）。 */
    if (root.__cxasTaken) { workLock = true; return; }
    root.__cxasTaken = true;
    // t6/C：分页考试看不到全部题目 → 不走两遍法，改"边翻边采集边作答"
    if (isPagedExam()) { workLock = false; return solvePagedExam(root); }
    /* ---------- 阶段一：全量采集（只读，绝不点任何选项） ---------- */
    /* 题目多时学习通分片渲染：不滚动，后半页的题根本不在 DOM 里。
     * 先滚到底把懒加载的内容都触发出来（纯读，不碰选项），再采集。 */
    await scrollToLoadAll(root);
    const collected = collectQuestions(root);
    const questions = collected.questions;
    if (!questions.length) {
      root.__cxasTaken = false;
      stats.lastAction = '未检测到作业题目（已查 ' + root.querySelectorAll(WORK_BLOCK_SELS).length +
        ' 个题目容器，可能是选择器不匹配）';
      warn(stats.lastAction);
      return;
    }
    /* 漏题诊断：页面声明「共 N 题」但只采到 M 题 → 说明还有分页/未加载完的内容。
     * 这种情况必须让用户看见（面板 + 日志），否则只会答前一半还以为是答完了。 */
    const expected = expectedQuestionCount();
    stats.expectedQuestions = expected;
    if (expected && questions.length < expected) {
      stats.lastAction = '⚠ 题目不完整：采集到 ' + questions.length + ' / 页面共 ' + expected +
        ' 题（可能有分页或在下方未加载，建议手动确认）';
      warn(stats.lastAction);
    }
    workLock = true;
    stats.mode = 'two-pass';
    stats.collected = questions.length;
    stats.answered = 0;
    stats.qtypes = collected.distText;
    if (!(expected && questions.length < expected)) {
      stats.lastAction = '已采集 ' + questions.length + ' 题（' +
        (collected.distText || '—') + '），开始统一作答';
    }
    log(stats.lastAction);
    if (!IS_TOP) relayWorkStats();
    if (hud && hud.__refresh) hud.__refresh();
    // 统一预解码全部题面（而不是逐题触发），保证映射覆盖整页
    await prepareCollectStems(questions);
    stats.collectedAt = Date.now();   // 采集完成时间戳：e2e 用它证明"采集期零点击"
    if (!IS_TOP) relayWorkStats();
    if (hud && hud.__refresh) hud.__refresh();

    /* ---------- 阶段二：统一作答 ---------- */
    let done = 0;
    let skipped = 0;
    let skippedType = 0;    // 因题型策略主动不作答（简答/计算/未知）
    let unverified = 0;
    let fontFailCount = 0;
    for (const q of questions) {
      const result = await answerOne(q);
      if (result === 'done') done++;
      else if (result === 'skipped') skipped++;
      else if (result === 'skippedType') skippedType++;
      else if (result === 'unverified') unverified++;
      else if (result === 'fontFail') {
        fontFailCount++;
        break;   // 字体解码失败：整页作答无意义（宁可不答，也不在错字上答）
      }
      stats.answered = done;
      if (!IS_TOP) relayWorkStats();
      if (hud && hud.__refresh) hud.__refresh();
      // 拟人化节奏：每题之间留间隔，避免"零延迟批量提交"
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 2000));
    }
    stats.work = done;
    stats.answered = done;
    stats.qskip = skippedType;   // t22/F5：面板要能区分"没答"与"按策略跳过"
    const kind = detectWorkKind();
    const parts = [];
    if (done) parts.push('已作答 ' + done + ' 题');
    if (skipped) parts.push('已作答跳过 ' + skipped + ' 题');
    if (skippedType) parts.push('按题型策略跳过 ' + skippedType + ' 题');
    if (unverified) parts.push('未成功落点 ' + unverified + ' 题');
    stats.lastAction = fontFailCount
      ? '字体解码失败，作答已中止（已答 ' + done + ' 题）'
      : (parts.join(' · ') || '没有可作答的题目') + '（' + WORK_KIND_LABEL[kind] + '）';
    log('作答完成，共', done, '题；已答跳过', skipped, '；题型策略跳过', skippedType,
      '；未成功', unverified, '；题型分布:', stats.qtypes);

    // 字体解码失败时绝不自作主张提交（交上去就是错的）
    if (fontFailCount) { root.__cxasTaken = false; workLock = false; return; }

    // 按页面类型决定敢不敢自动提交
    let allow = false;
    let why = '';
    // t26/L2：考试硬禁（本分支与 autoSubmitExam 开关无关，改配置也不会放行）
    if (kind === 'exam') {
      allow = false; why = '考试不自动提交';
    } else if (kind === 'quiz') {
      // 章节测验可重做取最高分，风险低，不受安全模式拦截
      allow = !!CFG.autoSubmitQuiz;
      why = allow ? '测验自动提交' : '测验自动提交已关闭';
    } else if (kind === 'homework') {
      allow = !!CFG.autoSubmitWork && !CFG.safeMode;
      why = allow ? '作业自动提交' : (CFG.safeMode ? '安全模式：作业未自动提交' : '作业自动提交已关闭');
    } else {
      // work / unknown：分不清是测验还是作业，保守不提交
      allow = false; why = '无法判定是测验还是作业，已答但不提交';
    }

    stats.lastAction = stats.lastAction + ' · ' + why;
    if (!IS_TOP) relayWorkStats();   // 题目 iframe 里算出的题型分布/进度要回传顶层（t4）
    if (hud && hud.__refresh) hud.__refresh();

    if (allow) {
      setTimeout(() => { doSubmit(kind, root); workLock = false; }, CFG.workSubmitDelay || 3000);
    } else {
      workLock = false;
    }
  }

  const WORK_KIND_LABEL = {
    quiz: '章节测验', homework: '作业', exam: '考试', work: '题目页', unknown: '未知类型',
  };

  function submitWork() {
    doSubmit(detectWorkKind(), findWorkDoc() || doc);
  }

  function tickWork() {
    if (!CFG.solveWork || workLock || workSolved) return;
    // 题目不一定在本 frame：真实环境在最内层 #frame_content 里（t11/A1）
    const wdoc = findWorkDoc();
    if (!wdoc) return;
    // 作息时段外不做自动作答（面板按钮是人工操作，不受此限）
    if (autoHoursPaused('章节测验/作业作答')) return;
    workSolved = true;
    solveWork(wdoc);
  }

  /* ============================================================
   * 十一、题库 / AI 答题引擎
   * ============================================================ */
  function aiReady() {
    return !!(CFG.aiEnabled && CFG.aiApiKey);
  }

  /* 题型提示：把题型明确告诉模型，比让它自己从选项数量猜准确得多。
   * 尤其多选题——不说明的话模型常常只给一个字母。 */
  const AI_TYPE_HINT = {
    single: '【题型：单选题，只有一个正确答案】',
    multiple: '【题型：多选题，可能有多个正确答案，请给全部】',
    judge: '【题型：判断题，答案只有「对」或「错」】',
    fill: '【题型：填空题，多个空按顺序用 | 分隔】',
  };

  function buildAiUserPrompt(question, options, type) {
    const lines = [];
    const hint = AI_TYPE_HINT[type];
    if (hint) lines.push(hint);
    lines.push(String(question || '').trim());
    if (options && options.length) {
      lines.push('');
      options.forEach((o, i) => lines.push(String.fromCharCode(65 + i) + '. ' + (o.text || '')));
    }
    return lines.join('\n');
  }

  function parseAiAnswer(text, options) {
    let t = String(text || '').replace(/[*`#]/g, '').trim();
    if (!t) return '';
    t = t.replace(/^(答案|正确答案|答)\s*[:：]?\s*/, '').trim();
    if (options && options.length) {
      const compact = t.toUpperCase().replace(/[\s,，、;；/和与]/g, '');
      if (/^[A-H]{1,8}$/.test(compact)) {
        const letters = compact.split('').filter((c, i, arr) => arr.indexOf(c) === i);
        if (letters.every((c) => c.charCodeAt(0) - 65 < options.length)) return letters.join('');
      }
      const run = t.toUpperCase().match(/[A-H]{1,8}/);
      if (run) {
        const letters = run[0].split('').filter((c, i, arr) => arr.indexOf(c) === i);
        if (letters.every((c) => c.charCodeAt(0) - 65 < options.length)) return letters.join('');
      }
      if (/^(错|错误|否|×|✗|false|F)/i.test(t)) return '错';
      if (/^(对|正确|是|√|✓|true|T)/i.test(t)) return '对';
    }
    return t;
  }

  /* AI 服务商预设。
   * opencode-go：官方文档确认提供 OpenAI 兼容端点
   *   https://opencode.ai/inference/go/openai/v1/chat/completions
   * 要求：① User-Agent 标识自己 ② 每个会话带 x-opencode-session 头。
   * 注意其条款面向 coding agent，答题流量过大可能被判 abuse，建议用便宜的 flash 模型。 */
  const AI_PRESETS = {
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
      model: 'deepseek-flash',
    },
    'opencode-go': {
      label: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      models: [
        'deepseek-v4.1-flash', 'mimo-v2.6-flash', 'glm-5.3-flash',
        'qwen3.8-flash', 'minimax-m3.1-flash', 'longcat-2.0',
        'deepseek-v4-pro', 'kimi-k3', 'glm-5.3',
      ],
      model: 'deepseek-v4.1-flash',
    },
    custom: {
      label: '自定义',
      baseUrl: '',
      models: [],
      model: '',
    },
  };

  // 会话 ID：OpenCode Go 用它做路由与提示词缓存，固定一个即可
  const AI_SESSION_ID = 'cxas-' + Math.random().toString(36).slice(2, 12);

  function aiEndpoint() {
    const base = String(CFG.aiBaseUrl || '').replace(/\/+$/, '');
    return base + '/chat/completions';
  }

  function askAI(question, options, type, temperature) {
    return new Promise((resolve) => {
      if (!aiReady()) return resolve(null);
      const url = aiEndpoint();
      const body = JSON.stringify({
        model: CFG.aiModel,
        messages: [
          { role: 'system', content: CFG.aiPrompt },
          { role: 'user', content: buildAiUserPrompt(question, options, type) },
        ],
        stream: false,
        temperature: typeof temperature === 'number' ? temperature : 0,
        max_tokens: CFG.aiMaxTokens,
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + CFG.aiApiKey,
      };
      // OpenCode Go 的接入要求：自报身份 + 稳定会话 ID
      if (CFG.aiProvider === 'opencode-go') {
        headers['User-Agent'] = 'xuexitong-assistant/4.0.1 (+userscript)';
        headers['x-opencode-session'] = AI_SESSION_ID;
      }
      const finish = (raw) => {
        if (!raw) return resolve(null);
        const a = parseAiAnswer(raw, options);
        resolve(a || null);
      };
      try {
        if (typeof GM_xmlhttpRequest !== 'function') return resolve(null);
        GM_xmlhttpRequest({
          method: 'POST', url, timeout: CFG.aiTimeout,
          headers,
          data: body,
          onload: (res) => {
            try {
              const obj = JSON.parse(res.responseText);
              if (obj && obj.error) {
                stats.lastAction = 'AI 报错：' + (obj.error.message || JSON.stringify(obj.error)).slice(0, 80);
                return resolve(null);
              }
              const msg = obj.choices && obj.choices[0] && obj.choices[0].message;
              finish(msg && msg.content);
            } catch (e) { resolve(null); }
          },
          onerror: () => { stats.lastAction = 'AI 请求失败（网络/域名未授权）'; resolve(null); },
          ontimeout: () => { stats.lastAction = 'AI 请求超时'; resolve(null); },
        });
      } catch (e) { resolve(null); }
    });
  }

  function cacheAnswer(question, answer) {
    if (!CFG.aiCache || !answer) return;
    const bank = Object.assign({}, store.get('bank') || {});
    if (bank[question]) return;
    bank[question] = String(answer);
    store.set('bank', bank);
  }

  /* 答题优先级：本地题库 → 模糊匹配 → DeepSeek → 远程题库 → 兜底
   * v2 改动：答题前先预解码 font-cxsecret，避免在错字上答题；
   *          解码失败且 skipAnswerIfFontFail 开启时，直接拒绝作答（返回 fontFail） */
  /* 多采样投票：同一题问 N 次（首次 temperature=0，其余 0.3）取多数。
   * 这是提升客观题准确率最有效的手段——单次采样的错误往往是随机的，
   * 多采样后多数派显著更稳。代价是 token 变成 N 倍，所以默认关闭。 */
  async function askAIVote(question, options, type) {
    const n = Math.max(0, Math.min(5, Number(CFG.aiVoteSamples) || 0));
    if (n <= 1) return askAI(question, options, type, 0);

    const got = [];
    for (let i = 0; i < n; i++) {
      // 第一次用 temperature=0 拿最确定的答案，后续加点随机性换取多样性
      const a = await askAI(question, options, type, i === 0 ? 0 : 0.3);
      if (a) got.push(a);
    }
    if (!got.length) return null;
    if (got.length === 1) return got[0];

    // 客观题按"字母集合"投票（顺序无关）；主观题按原文投票
    const tally = Object.create(null);
    for (const a of got) {
      const key = /^[A-H]{1,8}$/.test(a) ? a.split('').sort().join('') : a;
      tally[key] = (tally[key] || 0) + 1;
    }
    let bestKey = null, bestCount = -1;
    for (const k of Object.keys(tally)) {
      if (tally[k] > bestCount) { bestCount = tally[k]; bestKey = k; }
    }
    log('投票结果：', JSON.stringify(tally), '→', bestKey, '(' + bestCount + '/' + got.length + ')');
    return bestKey;
  }

  async function getAnswer(question, options, type) {
    const rawQ = String(question || '').trim();
    const rawOpts = (options || []).map((o) => String(o.text || ''));

    // 预解码：把题面与选项里出现的码位先匹配好（惰性，只处理实际出现的字）
    let prep = { ok: false, reason: '未执行' };
    try {
      prep = await FONT.prepare([rawQ].concat(rawOpts));
    } catch (e) {
      prep = { ok: false, reason: (e && e.message) || String(e) };
    }
    if (!prep.ok && FONT.blocked()) {
      stats.lastAction = '字体解码失败（' + prep.reason + '），已跳过本题';
      warn('跳过答题：字体解码失败 —', prep.reason);
      return { answer: null, src: 'none', fontFail: true };
    }

    const decodedQ = FONT.decode(rawQ);
    const decodedOptions = (options || []).map((o) => Object.assign({}, o, { text: FONT.decode(o.text) }));
    if (decodedQ !== rawQ) log('题面已解码：', rawQ.slice(0, 30), '→', decodedQ.slice(0, 30));

    const q = norm(decodedQ);
    if (!q) return { answer: null, src: 'none' };

    const bank = Object.assign({}, BUILTIN_BANK, store.get('bank') || {});
    if (bank[rawQ]) return { answer: bank[rawQ], src: 'bank' };
    if (bank[decodedQ]) return { answer: bank[decodedQ], src: 'bank' };

    let best = null;
    for (const key of Object.keys(bank)) {
      const k = norm(key);
      if (!k) continue;
      if (k === q) return { answer: bank[key], src: 'bank' };
      if (k.includes(q) || q.includes(k)) {
        if (!best || k.length < norm(best).length) best = key;
      }
    }
    if (best) return { answer: bank[best], src: 'fuzzy' };

    if (aiReady()) {
      let a = await askAIVote(decodedQ, decodedOptions, type);

      /* 解析失败重试：把原样的模型输出拿不到答案时（没答 / 输出废话），
       * 用更强的约束再问一次。比直接走随机兜底强得多。 */
      if (!a && CFG.aiRetryOnParseFail) {
        log('首次未解析出答案，重试一次');
        a = await askAI(decodedQ, decodedOptions, type, 0);
      }
      if (a) { cacheAnswer(decodedQ, a); return { answer: a, src: 'ai' }; }
    }

    if (CFG.answerSource === 'api' && CFG.apiUrl) {
      const a = await queryApi(decodedQ);
      if (a) return { answer: a, src: 'api' };
    }
    return { answer: null, src: 'none' };
  }

  function queryApi(question) {
    return new Promise((resolve) => {
      const url = CFG.apiUrl.replace('{q}', encodeURIComponent(question));
      const done = (data) => {
        try {
          const obj = typeof data === 'string' ? JSON.parse(data) : data;
          const ans = obj.answer || (obj.data && (obj.data.answer || obj.data.ans)) || obj.result || '';
          resolve(String(ans || '').trim() || null);
        } catch (e) { resolve(null); }
      };
      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'GET', url, timeout: 8000,
            onload: (res) => done(res.responseText),
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
          });
        } else {
          fetch(url).then((r) => r.text()).then(done).catch(() => resolve(null));
        }
      } catch (e) { resolve(null); }
    });
  }

  /* ============================================================
   * 十二、答案落点与日志
   * ============================================================ */
  const SRC_LABEL = {
    bank: '本地题库', fuzzy: '题库模糊匹配', ai: 'DeepSeek', api: '远程题库',
    fallback: '兜底策略', none: '无答案',
  };

  function pickIndexes(options, answer) {
    const picked = new Set();
    if (!answer) return picked;
    const raw = String(answer).trim();

    if (/^[A-Ha-h][A-Ha-h\s,，、;；/]*$/.test(raw)) {
      raw.toUpperCase().split('').forEach((ch) => {
        const i = ch.charCodeAt(0) - 65;
        if (i >= 0 && i < options.length) picked.add(i);
      });
      if (picked.size) return picked;
    }
    if (/^(对|正确|是|√|✓|t|true)/i.test(raw)) {
      options.forEach((o, i) => { if (/对|正确|是|√|✓/.test(o.text)) picked.add(i); });
      if (picked.size) return picked;
    }
    if (/^(错|错误|否|×|✗|f|false)/i.test(raw)) {
      options.forEach((o, i) => { if (/错|错误|否|×|✗/.test(o.text)) picked.add(i); });
      if (picked.size) return picked;
    }
    const na = norm(raw);
    options.forEach((o, i) => {
      const no = norm(o.text);
      if (no && (no === na || no.includes(na) || na.includes(no))) picked.add(i);
    });
    return picked;
  }

  /* 旧的通用落答案函数已被 applyQuizAnswer / applyWorkAnswer 取代（t11/A1+A3）：
   * 弹题必须点 input + 校验 checked，测验必须点 li + 校验 aria/hidden，
   * 两条路径的"点哪里"和"怎么算成功"都不一样，混在一起必然一边错。
   * 这里刻意不再保留 applyAnswer，避免以后又被误用回旧逻辑。 */

  const LOG = {
    list() { return store.get('log') || []; },
    add(entry) {
      const list = LOG.list();
      list.push(entry);
      const max = CFG.logMax || 500;
      while (list.length > max) list.shift();
      store.set('log', list);
    },
    stats() {
      const list = LOG.list();
      const hit = list.filter((e) => e.src === 'bank' || e.src === 'fuzzy' || e.src === 'ai' || e.src === 'api').length;
      return { total: list.length, hit };
    },
    clear() { store.set('log', []); },
  };

  function recordLog(where, question, answer, src, options, picked) {
    if (!CFG.logEnabled) return;
    const pickedText = Array.from(picked)
      .map((i) => (options[i] && options[i].text) || '')
      .filter(Boolean).join(' / ');
    LOG.add({
      t: Date.now(), where, q: question, a: answer || '', src,
      picked: pickedText || (src === 'none' ? '未作答' : ''),
    });
  }

  function exportLog() {
    const list = LOG.list();
    if (!list.length) { stats.lastAction = '日志为空，无可导出内容'; return; }
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['时间', '位置', '题目', '答案', '来源', '选中项'].map(esc).join(',')];
    list.forEach((e) => {
      rows.push([
        new Date(e.t).toLocaleString(),
        e.where === 'video' ? '视频弹题' : '作业/测验',
        e.q, e.a, SRC_LABEL[e.src] || e.src, e.picked,
      ].map(esc).join(','));
    });
    const csv = '\ufeff' + rows.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = '学习通作答日志-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    a.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    stats.lastAction = '日志已导出 ' + list.length + ' 条';
    if (hud && hud.__refresh) hud.__refresh();
  }

  function clearLog() {
    LOG.clear();
    stats.lastAction = '日志已清空';
    if (hud && hud.__refresh) hud.__refresh();
  }

  /* 题库导入：.json（对象/数组）与 .txt/.csv（题目|答案 或 Tab 分隔） */
  function importBank(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const bank = Object.assign({}, store.get('bank') || {});
      let added = 0;
      const isJson = /\.json$/i.test(file.name) || /^\s*[\[{]/.test(text);
      if (isJson) {
        try {
          const obj = JSON.parse(text);
          if (Array.isArray(obj)) {
            obj.forEach((it) => {
              const q = it.question || it.q || (Array.isArray(it) ? it[0] : '');
              const a = it.answer || it.a || (Array.isArray(it) ? it[1] : '');
              if (q && a != null) { bank[String(q).trim()] = String(a).trim(); added++; }
            });
          } else if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((k) => { bank[k.trim()] = String(obj[k]).trim(); added++; });
          }
        } catch (e) { log('JSON 题库解析失败', e); }
      } else {
        text.split(/\r?\n/).forEach((line) => {
          if (!line.trim()) return;
          const parts = line.split(/\t|\|/);
          if (parts.length >= 2) {
            const q = parts[0].trim();
            const a = parts.slice(1).join('|').trim();
            if (q && a) { bank[q] = a; added++; }
          }
        });
      }
      store.set('bank', bank);
      stats.lastAction = '题库导入 ' + added + ' 条';
      if (hud && hud.__refresh) hud.__refresh();
    };
    reader.readAsText(file);
  }

  /* ============================================================
   * 十三、悬浮面板
   * ------------------------------------------------------------------
   * DOM 指纹随机化（调研报告 §6.5）：
   *   固定 id/class 是零成本可检测的指纹——平台一句
   *   `document.querySelector('#cxas-hud')` 就知道装了脚本，比任何行为分析都便宜。
   *   所以面板与徽标的 id、内部 class 每次页面加载都用 Math.random 重新生成，
   *   业务逻辑只持有元素引用（hud / debugBadgeEl），不依赖选择器字符串。
   *   内联 cssText 的数值也做 ±小幅扰动（位置/内边距/阴影），
   *   让"按精确 style 值匹配"这类特征失效，同时肉眼几乎看不出差别。
   *   注意：这里刻意不引入任何新的固定字符串特征（也不加 data-* 属性名）。
   * ============================================================ */
  let hud = null;
  let debugBadgeEl = null;
  /* 折叠状态：面板挡住页面内容时用。存进 GM 存储，刷新后保持上次选择。
   * 注意与「隐藏」区分：Alt+Q 是隐藏整个面板，折叠是只留一行标题栏。 */
  let hudCollapsed = !!store.get('hudCollapsed');

  const FINGERPRINT = (() => {
    const CH = 'abcdefghijklmnopqrstuvwxyz';
    // 只用小写字母：既能当合法 id/class，又不会以数字开头导致 querySelector 报错
    const token = (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += CH.charAt(Math.floor(Math.random() * CH.length));
      return s;
    };
    // 数值微扰：每次加载生成一次，面板内部保持一致（避免明显错位）
    const jit = (base, delta) => Math.round((base + (Math.random() * 2 - 1) * delta) * 10) / 10;
    return {
      ids: { hud: token(10), badge: token(10) },
      cls: {
        hud: token(8), title: token(8), body: token(8),
        row: token(8), btn: token(8), file: token(8),
      },
      metric: {
        right: jit(16, 5), bottom: jit(16, 5), width: jit(250, 8),
        padY: jit(10, 2), padX: jit(12, 2), radius: jit(10, 2), alpha: jit(0.94, 0.04),
        shadowY: jit(6, 2), shadowBlur: jit(24, 6), rowGap: jit(6, 1), rowTop: jit(7, 2),
        titleGap: jit(6, 1),
        btnPadY: jit(4, 1), btnPadX: jit(8, 2), btnRadius: jit(6, 1.5), btnFont: jit(12, 0.5),
        badgePadY: jit(4, 1), badgePadX: jit(10, 2), badgeRadius: jit(12, 2),
        badgeOpacity: jit(0.9, 0.06),
      },
    };
  })();

  function btnStyle(bg) {
    const m = FINGERPRINT.metric;
    return 'flex:1;padding:' + m.btnPadY + 'px ' + m.btnPadX + 'px;border:0;border-radius:' +
      m.btnRadius + 'px;cursor:pointer;background:' + (bg || '#3a7afe') + ';color:#fff;font-size:' +
      m.btnFont + 'px;';
  }

  function rowStyle(top) {
    const m = FINGERPRINT.metric;
    return 'display:flex;gap:' + m.rowGap + 'px;margin-top:' + top + 'px;';
  }

  function createHud() {
    if (hud) return;
    const M = FINGERPRINT.metric;
    hud = doc.createElement('div');
    hud.id = FINGERPRINT.ids.hud;
    hud.className = FINGERPRINT.cls.hud;
    hud.style.cssText =
      'position:fixed;right:' + M.right + 'px;bottom:' + M.bottom + 'px;' +
      // z-index 只在高位区间抖动，始终压在页面内容之上
      'z-index:' + (2147483000 + Math.floor(Math.random() * 3000)) + ';width:' + M.width + 'px;' +
      'padding:' + M.padY + 'px ' + M.padX + 'px;border-radius:' + M.radius + 'px;' +
      'background:rgba(17,24,39,' + M.alpha + ');color:#e5e7eb;' +
      'font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif;' +
      'box-shadow:0 ' + M.shadowY + 'px ' + M.shadowBlur + 'px rgba(0,0,0,.35);user-select:none;';

    const title = doc.createElement('div');
    /* 已知残留（t14/F3，本轮不修）：
     * 标题仍是固定文本「学习通助手 v4.0.1」——指纹随机化只挡住了 id/class 选择器层，
     * 平台仍可用 textContent 匹配到面板；而我们自己的 hud/jump/answer e2e 也正是靠这段文案
     * 定位面板。所以标题与版本号必须一起处理：将来改成不含固定名称的文案时，
     * 不含固定名称的文案（或按配置隐藏），并同步改三处 e2e 的定位口径。 */
    title.textContent = '学习通助手 v4.0.1';
    title.className = FINGERPRINT.cls.title;
    title.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:' + M.titleGap + 'px;';

    const body = doc.createElement('div');
    body.className = FINGERPRINT.cls.body;
    body.style.cssText = 'white-space:pre-wrap;';

    const row1 = doc.createElement('div');
    row1.className = FINGERPRINT.cls.row;
    row1.style.cssText = rowStyle(M.rowTop + 1);
    const row2 = doc.createElement('div');
    row2.className = FINGERPRINT.cls.row;
    row2.style.cssText = rowStyle(M.rowTop);
    const row3 = doc.createElement('div');
    row3.className = FINGERPRINT.cls.row;
    row3.style.cssText = rowStyle(M.rowTop);
    const row4 = doc.createElement('div');
    row4.className = FINGERPRINT.cls.row;
    row4.style.cssText = rowStyle(M.rowTop);
    const row5 = doc.createElement('div');
    row5.className = FINGERPRINT.cls.row;
    row5.style.cssText = rowStyle(M.rowTop);

    const mkBtn = (bg) => {
      const b = doc.createElement('button');
      b.className = FINGERPRINT.cls.btn;
      b.style.cssText = btnStyle(bg);
      return b;
    };
    const toggle = mkBtn();
    const speedBtn = mkBtn();
    const solveBtn = mkBtn('#4b5563');
    const submitBtn = mkBtn('#4b5563');
    const importBtn = mkBtn('#4b5563');
    const safeBtn = mkBtn('#4b5563');
    const exportBtn = mkBtn('#4b5563');
    const clearBtn = mkBtn('#4b5563');
    const aiBtn = mkBtn('#4b5563');
    const provBtn = mkBtn('#4b5563');
    const modelBtn = mkBtn('#4b5563');
    const keyBtn = mkBtn('#4b5563');
    const fontBtn = mkBtn('#4b5563');
    const quizBtn = mkBtn('#4b5563');
    const dailyBtn = mkBtn('#4b5563');   // t8：本地日限预设（默认关闭）
    const resetDailyBtn = mkBtn('#4b5563');   // t28/F3：重置今日计数（误判纠正 / 测试用）

    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.txt,.csv';
    fileInput.className = FINGERPRINT.cls.file;
    fileInput.style.display = 'none';
    fileInput.onchange = () => { if (fileInput.files[0]) importBank(fileInput.files[0]); fileInput.value = ''; };

    /* 应用折叠态：折叠后只留标题栏，其余内容 display:none。
     * 标题栏本身可点击切换——这是最省位又最容易发现的交互。 */
    const applyCollapsed = (collapsed) => {
      hudCollapsed = !!collapsed;
      store.set('hudCollapsed', hudCollapsed);
      const hide = hudCollapsed ? 'none' : '';
      [body, row1, row2, row3, row4, row5].forEach((el) => { el.style.display = hide; });
      // fileInput 本来就是 display:none，不用动
      title.style.marginBottom = hudCollapsed ? '0' : (M.titleGap + 'px');
      title.style.cursor = 'pointer';
      title.title = hudCollapsed ? '点击展开面板' : '点击折叠面板';
      refresh();
    };

    /* 折叠时标题变成一行状态摘要，仍需保留「学习通助手」前缀——
     * hud/jump/answer 三处 e2e 靠这个前缀定位面板。 */
    const refresh = () => {
      if (hudCollapsed) {
        const stateText = CFG.enabled ? '运行中' : '已暂停';
        const bits = [stateText];
        if (stats.video) bits.push(stats.progress + '%');
        if (stats.quiz) bits.push('弹题' + stats.quiz);
        if (stats.platformLimit) bits.push('日上限');
        if (stats.face) bits.push('人脸');
        title.textContent = '学习通助手 ▸ ' + bits.join(' · ');
      } else {
        title.textContent = '学习通助手 v4.0.1 ▾';
      }
      toggle.textContent = CFG.enabled ? '暂停' : '启动';
      speedBtn.textContent = CFG.speed + 'x';
      safeBtn.textContent = '安全模式：' + (CFG.safeMode ? '开' : '关');
      safeBtn.style.background = CFG.safeMode ? '#2e7d32' : '#4b5563';
      aiBtn.textContent = 'AI：' + (aiReady() ? '开' : (CFG.aiEnabled ? '待配Key' : '关'));
      aiBtn.style.background = aiReady() ? '#2e7d32' : '#4b5563';
      const preset = AI_PRESETS[CFG.aiProvider] || AI_PRESETS.deepseek;
      provBtn.textContent = preset.label;
      provBtn.style.background = CFG.aiProvider === 'opencode-go' ? '#1d4ed8' : '#4b5563';
      modelBtn.textContent = CFG.aiModel || '(未设)';
      fontBtn.textContent = '字体解码：' + (CFG.fontDecode ? (stats.fontMapped ? '就绪' : '待触发') : '关');
      fontBtn.style.background = CFG.fontDecode && stats.fontMapped ? '#2e7d32' : '#4b5563';
      quizBtn.textContent = '测验提交：' + (CFG.autoSubmitQuiz ? '自动' : '手动');
      quizBtn.style.background = CFG.autoSubmitQuiz ? '#2e7d32' : '#4b5563';
      const dlim = DAILY.limitOf();
      dailyBtn.textContent = '日限：' + (dlim ? dlim : '关');
      dailyBtn.style.background = dlim ? '#b45309' : '#4b5563';
      resetDailyBtn.textContent = '重置日计数';

      const bankSize = Object.keys(Object.assign({}, BUILTIN_BANK, store.get('bank') || {})).length;
      const ls = LOG.stats();
      const rate = ls.total ? Math.round((ls.hit / ls.total) * 100) + '%' : '-';
      const kind = detectWorkKind();
      const quizSubmit = CFG.autoSubmitQuiz ? '自动交' : '不交';
      const workSubmit = (CFG.autoSubmitWork && !CFG.safeMode) ? '自动交' : '不交';
      body.innerHTML = '';
      const lines = [
        '状态：' + (CFG.enabled ? '运行中' : '已暂停'),
        '安全模式：' + (CFG.safeMode ? '开（作业/考试不自动交）' : '关'),
        '视频：' + (stats.video ? '已接管' : '未检测到'),
        '进度：' + stats.progress + '%（' + (CFG.requireEnded ? '需播完' : '达 ' + CFG.nextAtPercent + '%') + ' 才跳）',
        '文档/PPT：' + (stats.doc || (CFG.docTask ? '待触发' : '关')),
        '人脸核验：' + (stats.face || '未触发'),
        '音频：' + (stats.audio || (CFG.audioTask ? '待触发' : '关')),
        '抖动自检：' + (stats.flap || ('开（60 秒内 >' + CFG.flapMaxPerMin + ' 次切换即熔断）')),
        '本页任务点：' + (stats.diag || '—'),
        '倍速：' + (stats.speed || CFG.speed) + 'x（上限 ' + CFG.maxSpeed + 'x）',
        // 拟人化三行：总开关 / 随机暂停（可单独关）/ 作息时段，三者状态都要一眼可见
        '拟人化：' + (CFG.humanize ? '开' : '关') + ' ｜ 随机暂停：' + (
          !CFG.humanize || !CFG.humanizePause
            ? '关'
            : String(stats.humanize || '开（未触发）').replace(/^运行中$/, '开')
        ),
        '拟人化暂停：' + (CFG.humanize && CFG.humanizePause ? (stats.humanizeUsage || '—') : '未启用'),
        '作息时段：' + activeHoursLabel(),
        '字体：' + stats.fontStatus,
        'AI 答题：' + (aiReady() ? preset.label + ' / ' + CFG.aiModel : (CFG.aiEnabled ? '待配置 Key' : '已关闭')),
        '弹题已作答：' + stats.quiz + ' 次',
        '本页类型：' + WORK_KIND_LABEL[kind] + '（测验' + quizSubmit + ' / 作业' + workSubmit + '）',
        '题型：' + (stats.qtypes || '—'),
        // t6 两遍法：先采集、后作答，两阶段进度分开显示
        '采集：' + (stats.collected ? '已采集 ' + stats.collected + ' 题（' + (stats.qtypes || '—') + '）' : '—'),
        '作答进度：' + stats.answered + ' / ' + stats.collected + ' 题' +
          (stats.mode === 'paged' ? '（分页模式：边翻边答）' : ''),
        '测验已作答：' + stats.work + ' 题' + (stats.qskip ? '（策略跳过 ' + stats.qskip + '）' : ''),
        // t8：平台日上限是硬信号；本地计数只是可选的自我约束（默认关闭）
        '平台日上限：' + (stats.platformLimit ? '已触发（今日任务点已满，已停自动跳转）' : '未触发'),
        '本地日限：' + (DAILY.limitOf()
          ? stats.dailyCount + ' / ' + DAILY.limitOf() + '（无平台依据，自我约束）'
          : '关闭（无平台依据）'),
        '平台记录：' + (stats.completionState || '—'),
        '题库：' + bankSize + ' 条',
        '命中率：' + rate + '（' + ls.hit + '/' + ls.total + '，仅表示"有答案"）',
        // 真实准确率只有提交后的成绩能证明；命中率 ≠ 答对率
        '上次得分：' + (stats.lastScore !== null
          ? stats.lastScore + ' 分' + (stats.lastScore < 60 ? '（偏低：可换更强模型或开 aiVoteSamples）' : '')
          : '—（提交测验后显示）'),
        '最近动作：' + stats.lastAction,
      ];
      lines.forEach((t) => {
        const p = doc.createElement('div');
        p.textContent = t;
        body.appendChild(p);
      });
    };

    toggle.onclick = () => { CFG.enabled = !CFG.enabled; saveCfg(); refresh(); };
    speedBtn.onclick = () => {
      const list = (CFG.speedList || [1, 1.5, 2]).filter((s) => s <= CFG.maxSpeed);
      const cur = list.indexOf(CFG.speed);
      CFG.speed = list[(cur + 1) % list.length];
      saveCfg(); refresh();
    };
    solveBtn.textContent = '作答本页';
    submitBtn.textContent = '提交本页';
    importBtn.textContent = '导入题库';
    solveBtn.onclick = () => broadcast({ __cxas: 'SOLVE_WORK' });
    submitBtn.onclick = () => {
      if (CFG.safeMode && !win.confirm('安全模式已开启：确认要提交本页的作业/测验吗？此操作不可撤销。')) {
        stats.lastAction = '已取消提交';
        return;
      }
      broadcast({ __cxas: 'SUBMIT_WORK' });
    };
    importBtn.onclick = () => fileInput.click();
    safeBtn.onclick = () => { CFG.safeMode = !CFG.safeMode; saveCfg(); refresh(); };
    // t28/F3：清空 cxas_daily（面板可见结果，误判/测试都能自己修）
    resetDailyBtn.onclick = () => {
      DAILY.reset();
      dailyCountedSections.clear();
      preCompletedSections.clear();
      stats.dailyCount = 0;
      stats.lastAction = '今日计数已重置（cxas_daily 已清空）';
      log(stats.lastAction);
      refresh();
    };
    // t8/B：本地日限预设按钮。UI 必须写明「无平台依据」，别让用户以为是平台规则
    dailyBtn.onclick = () => {
      const presets = [0, 8, 12, 20];
      const cur = presets.indexOf(DAILY.limitOf());
      CFG.dailyTaskLimit = presets[(cur + 1) % presets.length];
      saveCfg();
      stats.dailyCount = DAILY.state().count;
      stats.lastAction = CFG.dailyTaskLimit
        ? '本地日限设为 ' + CFG.dailyTaskLimit + ' 个/天（无平台依据，基于公文与社区经验的保守值：8-12 保守 / 20 温和）'
        : '本地日限已关闭（默认；真正的安全阀是平台日上限识别）';
      refresh();
    };
    quizBtn.onclick = () => {
      CFG.autoSubmitQuiz = !CFG.autoSubmitQuiz;
      saveCfg();
      stats.lastAction = '章节测验自动提交：' + (CFG.autoSubmitQuiz ? '开' : '关');
      refresh();
    };
    exportBtn.textContent = '导出日志';
    clearBtn.textContent = '清空日志';
    exportBtn.onclick = exportLog;
    clearBtn.onclick = () => {
      if (win.confirm('确认清空已记录的作答日志？')) clearLog();
    };
    aiBtn.onclick = () => { CFG.aiEnabled = !CFG.aiEnabled; saveCfg(); refresh(); };

    // 服务商切换：点一下换下一个预设，同时套用它的 baseUrl 与默认模型
    provBtn.onclick = () => {
      const order = ['deepseek', 'opencode-go', 'custom'];
      const cur = order.indexOf(CFG.aiProvider);
      const next = order[(cur + 1) % order.length];
      CFG.aiProvider = next;
      const p = AI_PRESETS[next];
      if (next !== 'custom') {
        CFG.aiBaseUrl = p.baseUrl;
        CFG.aiModel = p.model;
      }
      saveCfg();
      stats.lastAction = 'AI 服务商：' + p.label + (next === 'custom' ? '（请手动设 baseURL）' : '');
      refresh();
    };

    keyBtn.textContent = '设置Key';
    modelBtn.onclick = () => {
      const p = AI_PRESETS[CFG.aiProvider] || AI_PRESETS.deepseek;
      if (!p.models.length) {
        const v = win.prompt('输入模型 ID：', CFG.aiModel || '');
        if (v === null) return;
        CFG.aiModel = String(v).trim();
      } else {
        const cur = p.models.indexOf(CFG.aiModel);
        CFG.aiModel = p.models[(cur + 1) % p.models.length];
      }
      saveCfg();
      stats.lastAction = 'AI 模型：' + CFG.aiModel;
      refresh();
    };
    keyBtn.onclick = () => {
      const p = AI_PRESETS[CFG.aiProvider] || AI_PRESETS.deepseek;
      const v = win.prompt(
        '粘贴 ' + p.label + ' 的 API Key（留空则清除）：\n' +
        '当前接口：' + (CFG.aiBaseUrl || '(未设置)') + '\n' +
        '当前模型：' + (CFG.aiModel || '(未设置)'),
        CFG.aiApiKey || '');
      if (v === null) return;
      CFG.aiApiKey = String(v).trim();
      saveCfg();
      stats.lastAction = CFG.aiApiKey ? 'API Key 已保存' : 'API Key 已清除';
      refresh();
    };
    fontBtn.onclick = () => {
      CFG.fontDecode = !CFG.fontDecode;
      saveCfg();
      if (CFG.fontDecode) {
        FONT.ensureReady().then(() => refresh()).catch(() => refresh());
      }
      refresh();
    };

    row1.appendChild(toggle);
    row1.appendChild(speedBtn);
    row2.appendChild(solveBtn);
    row2.appendChild(submitBtn);
    row2.appendChild(importBtn);
    row3.appendChild(safeBtn);
    row3.appendChild(quizBtn);
    row3.appendChild(fontBtn);
    row3.appendChild(dailyBtn);
    row4.appendChild(resetDailyBtn);
    row4.appendChild(exportBtn);
    row4.appendChild(clearBtn);
    row5.appendChild(aiBtn);
    row5.appendChild(provBtn);
    row5.appendChild(modelBtn);
    row5.appendChild(keyBtn);
    hud.appendChild(title);
    hud.appendChild(body);
    hud.appendChild(row1);
    hud.appendChild(row2);
    hud.appendChild(row3);
    hud.appendChild(row4);
    hud.appendChild(row5);
    hud.appendChild(fileInput);

    const attach = () => {
      if (doc.body) doc.body.appendChild(hud);
      else setTimeout(attach, 200);
    };
    attach();

    /* 折叠交互：点标题栏切换。双击标题栏 = 完全不显示？不做——会和 Alt+Q 语义打架。
     * Alt+W 作为键盘等价操作，方便面板被折叠后仍能快速展开。 */
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      applyCollapsed(!hudCollapsed);
    });
    win.addEventListener('keydown', (e) => {
      if (e.altKey && String(e.key).toLowerCase() === 'w') {
        applyCollapsed(!hudCollapsed);
      }
    });

    applyCollapsed(hudCollapsed);   // 恢复上次的折叠状态
    hud.__refresh = refresh;
    hud.__applyCollapsed = applyCollapsed;
    hud.__isCollapsed = () => hudCollapsed;
  }

  function createDebugBadge() {
    if (!CFG.debugBadge) return;
    // 用内部引用判重，不再按固定 id 查 DOM（固定 id 本身就是指纹）
    if (debugBadgeEl) return;
    const M = FINGERPRINT.metric;
    const b = doc.createElement('div');
    b.id = FINGERPRINT.ids.badge;
    b.className = FINGERPRINT.cls.hud;
    b.textContent = '学习通助手已注入 · ' + location.host + (IS_TOP ? ' (顶层)' : ' (子框架)');
    b.style.cssText =
      'position:fixed;left:' + M.right + 'px;top:' + M.padY + 'px;' +
      'z-index:' + (2147483000 + Math.floor(Math.random() * 3000)) + ';' +
      'padding:' + M.badgePadY + 'px ' + M.badgePadX + 'px;border-radius:' + M.badgeRadius + 'px;' +
      'background:rgba(46,125,50,.92);color:#fff;' +
      'font:12px/1.4 -apple-system,"Microsoft YaHei",sans-serif;' +
      'box-shadow:0 ' + M.shadowY + 'px 8px rgba(0,0,0,.3);pointer-events:none;opacity:' + M.badgeOpacity + ';';
    debugBadgeEl = b;
    const attach = () => { if (doc.body) doc.body.appendChild(b); else setTimeout(attach, 200); };
    attach();
    setTimeout(removeDebugBadge, 20000);
  }

  function removeDebugBadge() {
    if (!debugBadgeEl) return;
    try { debugBadgeEl.remove(); } catch (e) { /* 忽略 */ }
    debugBadgeEl = null;
  }

  win.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'q') {
      CFG.enabled = !CFG.enabled; saveCfg();
      if (hud && hud.__refresh) hud.__refresh();
    }
  });

  /* ============================================================
   * 十四、启动
   * ============================================================ */
  try { patchVisibility(); } catch (e) { log('可见性补丁失败：', e); }
  try { createDebugBadge(); } catch (e) { /* 忽略 */ }

  // 单端心跳
  if (CFG.singleSession) {
    SESSION.beat();
    setInterval(SESSION.beat, CFG.sessionBeatMs || 2000);
    win.addEventListener('pagehide', SESSION.cleanup);
    win.addEventListener('beforeunload', SESSION.cleanup);
  }

  // 字体解码预热：检测到题目页时后台预热基准池（真正的码位匹配在 getAnswer 里惰性进行）
  let fontWarm = false;
  function warmFont() {
    if (fontWarm || !CFG.fontDecode) return;
    const hasQuestion = !!doc.querySelector('.TiMu, .questionLi, .TiMuNew, .ans-videoquiz');
    if (!hasQuestion) return;
    fontWarm = true;
    FONT.ensureReady().then(() => {
      const h = FONT.health();
      if (!h.ok) warn('字体解码预热异常：', h.reason);
      else log('字体基准池就绪：', h.mapped, '已解码 /', h.missed, '未匹配');
      if (hud && hud.__refresh) hud.__refresh();
    }).catch((e) => { warn('字体解码预热失败：', (e && e.message) || e); });
  }

  /* ============================================================
   * 非视频任务点：文档 / PPT / 音频（v3.1 新增）
   * ============================================================ */
  /* 新版任务点容器：`.ans-attach-ct` 内含 `.ans-job-icon`；
   * 视频任务点额外带 `ans-job-video`，其余类型靠"滚动阅读 / 播放"才会被平台记录。
   * 依据：research/real-video.md（容器 = `.ans-attach-ct:has(.ans-job-icon)`，源码实证）
   *       + 本项目实测（未完成态 class = `ans-job-icon-clear`）。
   * 这里只做**无副作用**的推进：滚动阅读。不伪造接口、不提交任何东西。 */
  let docTickAt = 0;
  let docScrollCount = 0;

  function tickDoc() {
    if (!CFG.docTask) { stats.doc = ''; return; }
    /* 总开关门禁：暂停或抖动熔断后不得再驱动任务点（测试队友发现的原 bug）。 */
    if (!CFG.enabled) return;
    if (!IS_TOP) return;   // 只在顶层驱动，避免父子框架重复滚动同一个容器
    /* 注意 0 是合法值（=不节流，测试要用），不能用 || 1200 —— 0 会被当成 falsy 吃掉。 */
    const rawGap = Number(CFG.docScrollIntervalMs);
    const gap = (Number.isFinite(rawGap) && rawGap >= 0) ? rawGap : 1200;
    if (Date.now() - docTickAt < gap) return;
    docTickAt = Date.now();

    for (const d of allDocs()) {
      let boxes = [];
      try { boxes = Array.from(d.querySelectorAll('.ans-attach-ct')); } catch (e) { continue; }
      for (const box of boxes) {
        let icon = null;
        try { icon = box.querySelector('.ans-job-icon'); } catch (e) { icon = null; }
        if (!icon) continue;                                    // 不是任务点容器
        if (box.querySelector('.ans-job-video')) continue;      // 视频任务点交给 tickVideo
        if (!icon.classList.contains('ans-job-icon-clear')) continue;  // 已完成

        /* 可滚动目标：优先 iframe 里的正文文档（文档/PPT 都在 iframe 里渲染），
         * 其次容器自身（有些类型是内嵌滚动区）。 */
        let frameDoc = null;
        const fr = box.querySelector('iframe');
        if (fr) { try { frameDoc = fr.contentDocument; } catch (e) { frameDoc = null; } }
        const scroller = frameDoc
          ? (frameDoc.scrollingElement || frameDoc.documentElement || frameDoc.body)
          : (box.scrollHeight > box.clientHeight + 20 ? box : null);
        if (!scroller) continue;

        const view = scroller.clientHeight || 600;
        const step = Math.max(120, Math.round(view * (Number(CFG.docScrollRatio) || 0.9)));
        const total = scroller.scrollHeight || 0;
        let before = 0;
        try { before = scroller.scrollTop || 0; } catch (e) { before = 0; }
        const atBottom = total > 0 && before + view >= total - 8;

        if (atBottom) {
          /* 到底了仍标记未完成：可能是需要"翻页"的 PPT / 需要点"下一页"的文档。
           * 只尝试常见的下一页按钮，找不到就停在这里报状态，不硬刷。 */
          const nextBtn = box.querySelector('.nextBtn, .next, [class*="nextPage"], .pageNext');
          if (nextBtn) {
            try { nextBtn.click(); } catch (e) { /* 忽略 */ }
            stats.doc = '文档任务点：已到底，翻下一页（第 ' + (docScrollCount + 1) + ' 次）';
          } else {
            stats.doc = '文档任务点：已滚到底（等待平台记录，未完成）';
          }
          setAction(stats.doc);
          docScrollCount++;
          return;
        }

        try { scroller.scrollTop = before + step; } catch (e) { continue; }
        docScrollCount++;
        const after = (scroller.scrollTop || before) + view;
        const pct = total > 0 ? Math.min(99, Math.round((after / total) * 100)) : 100;
        stats.doc = '文档任务点：滚动 ' + pct + '%（第 ' + docScrollCount + ' 次）';
        setAction(stats.doc);
        return;   // 一轮只推一个容器，避免同一 tick 内大幅跳动
      }
    }
    if (!stats.doc) stats.doc = '';
  }

  /* ============================================================
   * 人脸核验（v3.1 新增）
   * ============================================================ */
  /* 超星要求人脸核验时会盖一层遮罩。这里**只检测、只暂停**：
   * 模拟/绕过人脸既违规也是本项目明确不做的（见 README 合规声明与 research/risk-and-tech.md §579）。
   * 探测便宜的写法：只扫 class/id 里带 face 的节点 + 少量已知选择器，不做全文扫描。 */
  const FACE_SELS = ['#fcqrimg', '.chapterVideoFaceMaskDiv', '.faceMask', '#faceMask', '.face-verify'];
  const FACE_TEXT_RE = /人脸识别|请进行人脸|人脸核验|人脸验证|人脸采集/;
  let faceWasActive = false;

  function faceGuardActive() {
    for (const d of allDocs()) {
      try {
        for (const s of FACE_SELS) {
          const el = d.querySelector(s);
          if (el && visibleIn(el)) return true;
        }
        const cands = d.querySelectorAll('[class*="face"],[id*="face"],[class*="Face"],[id*="Face"]');
        for (const el of cands) {
          const t = String(el.textContent || '');
          if (t.length > 80) continue;                 // 大容器里可能混入整页文案，跳过
          if (!FACE_TEXT_RE.test(t)) continue;
          if (visibleIn(el)) return true;
        }
      } catch (e) { /* 跨域 */ }
    }
    return false;
  }

  function mainTick() {
    try {
      /* 人脸核验优先于一切自动推进：命中就暂停视频并停掉各 tick，
       * 不然会出现"人不在、视频继续播、任务点被判无效"的最坏结果。 */
      const face = !!CFG.pauseOnFace && faceGuardActive();
      stats.face = face ? '需人工核验（已暂停自动推进）' : '';
      if (face) {
        if (!faceWasActive) { faceWasActive = true; warn('检测到人脸识别提示：已暂停自动推进，等待人工完成'); }
        const v = pickLocalVisibleVideo();
        if (v && !v.paused) { try { v.pause(); } catch (e) { /* 忽略 */ } }
        setAction('检测到人脸识别，已暂停自动推进（人工完成后自动恢复）', { lock: true });
      } else {
        if (faceWasActive) { faceWasActive = false; setAction('人脸核验已完成，恢复自动推进', { force: true }); }
        tryResume();          // v3.2：刷新后跳回上次小节（只尝试一次）
        tickVideo();
        tickQuiz();
        tickWork();
        tickDoc();
        tickAudio();         // v4.0：音频任务点（限频播放）
        tickDiag();          // v4.0：任务点/题目识别诊断
        saveResumePoint();    // v3.2：记录当前小节
        markVisitedCourse();  // v3.2：记录"进过哪些课"，供课程链挑下一门
        tryChainOnListPage(); // v3.2：课程链在列表页执行的另一半
        tickEmptySection();   // v3.2.1：空小节（暂无内容）自动跳过，带频率上限
      }
      tickDaily();   // t8：平台日上限探测 + 本地计数（只在平台完成标记出现时 +1）
      warmFont();
    } catch (e) { warn('主循环异常：', e); }
    if (IS_TOP) {
      if (!hud && (isCourseHost() || stats.video || doc.querySelector('.posCatalog, #mainid, .ans-videoquiz, .TiMu'))) {
        try { createHud(); removeDebugBadge(); log('已创建悬浮面板'); } catch (e) { log('面板创建失败：', e); }
      }
      if (hud && hud.__refresh) hud.__refresh();
    }
  }

  setInterval(mainTick, 1000);
  mainTick();

  /* 调试钩子：默认不挂到 window 上。
   * 挂全局变量本身是一个零成本可检测的指纹（见调研报告 §6.5），
   * 只在用户显式开启 verbose/debugBadge 时才暴露，供自查与自动化测试使用。 */
  if (CFG.verbose || CFG.debugBadge) {
    try {
      win.__CXAS_DEBUG = {
        version: '4.0.1',
        cfg: CFG,
        stats,
        font: FONT,
        session: SESSION,
        norm,
        parseAiAnswer,
        pickIndexes,
        getAnswer,
        detectWorkKind,
        doSubmit,
        confirmSubmitDialog,
        // t20：返回/下一节与防双跳的可测接口
        backToCourse,
        clickRealNext,
        postNext,
        nextState: () => ({ postedAt: nextPostedAt, clickedAt: lastNextClickAt }),
        // 板块①（拟人化 + 指纹随机化）的可测接口：
        // 面板 id/class 每次加载都不同，测试不能靠选择器，只能从调试钩子拿当前值
        fingerprint: FINGERPRINT,
        hud: () => hud,
        debugBadge: () => debugBadgeEl,
        parseActiveHours,
        inActiveHours,
        activeHoursLabel,
        tickVideo,          // 供测试直接驱动单个 tick（不跑弹题/作业钩子，避免时序干扰）
        tickDoc,            // v3.1：非视频任务点（文档/PPT/音频）推进
        faceGuardActive,    // v3.1：人脸核验探测（只检测不绕过）
        chapterIdOfNode,    // v3.2：目录节点 → chapterId 解析
        chapterIdFromUrl,   // v3.2：URL → chapterId
        courseIdOfHref,     // v3.2：链接 → courseId
        saveResumePoint,    // v3.2：记录断点
        tryResume,          // v3.2：断点续刷
        tryChainOnListPage, // v3.2：课程链
        tickEmptySection,   // v3.2.1：空小节跳过
        noteFlapEvent,      // v4.0：抖动计数（供测试直接驱动）
        tickAudio,          // v4.0：音频任务点
        tickDiag,           // v4.0：任务点/题目识别诊断
        flapState: () => ({ tripped: flapTripped, count: flapTimes.length }),
        // t11：真实 DOM 适配的可测接口（弹题/测验/iframe/ended 锁定）
        video: () => videoEl,
        endedState: () => ({ flag: endedFlag, key: endedKey, src: endedSrc, dur: endedDur }),
        findWorkDoc,
        parseWorkQuestions,
        scrollToLoadAll,         // 长页面/懒加载：滚动触发分片渲染后再采集
        collectQuestions,
        expectedQuestionCount,   // 漏题诊断：页面声明「共 N 题」与实际采集数对比
        detectQuestionType,      // t4：题型识别
        // t8：平台日上限 / 本地日限 / 完成标记 的可测接口
        DAILY,
        // t28：重播计数可观测（断言"硬跳出口可达"）+ 重置入口
        completionAttempts: () => Array.from(completionAttempts.entries()),
        waitForCompletionMark,
        completionRetriesUsed,
        resetCompletionAttempts,
        resetDaily: () => { DAILY.reset(); dailyCountedSections.clear(); preCompletedSections.clear(); },
        dailyState: () => DAILY.state(),
        platformDailyLimitHit,
        sectionCompleted,
        currentSectionKey,
        completionMarkerFamilyPresent,
        tickDaily,
        typeAllowed,
        QTYPE_LABEL,
        QTYPE_BY_CODE,
        setTextValue,
        fallbackIndex,
        applyWorkAnswer,
        workOptionSelected,
        workResultText,
        readWorkScore,
        askAIVote,
        buildAiUserPrompt,
        parseQuiz,
        applyQuizAnswer,
        submitQuiz,
        clickQuizContinue,
        humanize: {
          get pauseUntil() { return humanPauseUntil; },
          get pausedByMe() { return humanPausedByMe; },
          get pausing() { return humanPauseUntil > 0 && humanPausedByMe; },
          get resumeFailed() { return resumeFailed; },
          // 台账与闸门也暴露出来：占比/间隔/恢复校验这类"时序闸门"在真浏览器里很难稳定复现
          get ledger() { return Object.assign({}, HM_LEDGER); },
          canStart: canStartHumanPause,
          budgetAllows: humanPauseBudgetAllows,
          planned: humanPauseDurationSec,
          usage: humanizeUsageText,
          start: startHumanPause,
          clear: clearHumanPause,
        },
      };
      log('调试钩子已暴露：window.__CXAS_DEBUG');
    } catch (e) { /* 忽略 */ }
  }

  let moTimer = null;
  const mo = new MutationObserver(() => {
    if (moTimer) return;
    moTimer = setTimeout(() => { moTimer = null; mainTick(); }, 500);
  });
  try { mo.observe(doc, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }

  log('脚本已加载', IS_TOP ? '(顶层)' : '(子框架)');
})();

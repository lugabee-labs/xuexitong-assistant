# 真实学习通 DOM 与交互调研（v2.3 实现依据）

> 目标：为四项改进提供**可核对**的 DOM 事实，而不是猜测。
> 每条结论都标了三件事：**来源**、**可信度**、**对实现的具体建议**。
> 可信度分级：
> - **源码实证**：在别人开源项目的 JS/TS 源码里读到该选择器或逻辑，可直接抄。
> - **页面实证**：真实页面抓包/单元测试样本里能看到该结构（本项目已下载，见附录 A）。
> - **实测记录**：作者基于真实账号跑通并写进文档（有战绩/次数），但没给 DOM dump。
> - **文档自述**：README/issue 里的一句话，未交叉验证。
> - **推测**：由结构类推，**不要直接写进代码**。
>
> 调研时间：2026-10-30。所有抓取物已落盘在 `research/gh/`（见附录 A），可复查。

---

## 0. 结论速览（先看这张表）

| 问题 | 结论 | 证据强度 |
|---|---|---|
| 章节测验是否分页 | **不分页**。一页渲染全部 `.TiMu`，靠 `.newTestType` 标题分组 | 源码实证 + 实测记录（174 节）|
| 分页出现在哪 | **考试**（`exam-ans` 域）。且考试有两条路：整卷预览 / 逐题分页 | 源码实证 |
| 翻页按钮 | 考试：`.nextDiv .jb_btn`（文本「下一题」）或页面函数 `getTheQuestionByStart(start,'0')` | 源码实证 |
| 主客观题怎么分 | 读**题型文字**（`.newZy_TItle` 的【单选题】…）映射成类型码；作业用 `.questionLi[typename]` | 源码实证（两套独立实现）|
| 章节测验选项有 `<input>` 吗 | **没有**（新版）。选项是 `li[onclick="addChoice(this)"]`，答案写进隐藏 `input[name="answer{qid}"]` | 页面实证 |
| 弹题选项有 `<input>` 吗 | **有**。`li.ans-videoquiz-opt > label > span.tkRadio > input[type=radio]` | 源码实证 + 实测记录 |
| 弹题提交按钮 | `a#videoquiz-submit`（不是 `.ans-videoquiz-submit`）；继续 `a#videoquiz-continue` | 源码实证 + 实测记录 |
| 提交确认弹窗 | 新版：**顶层文档** `.popDiv.Marking` → 点文本以「提交」开头的 `a.jb_btn`；老版：`#workpop` + `a#popok` | 实测记录（174 节）+ 源码实证 |
| `.popup_confirm` | **未找到可靠来源**。本项目 v2.x 里这个选择器大概率是臆造 | — |
| 判分反馈 | 本页显示「已完成 · 第N次作答 · 本次成绩X分」，提交按钮消失 | 实测记录 + 源码实证 |
| 能否拿到「答对几题」 | 能**间接**拿：总成绩 ÷ (100/题量)；批阅页有 `.fr.dui`（对）`.fr.cuo`（错）可数 | 源码实证（旧版结构）/ 实测 |
| 提交后是否跳转 | 章节测验**不整页跳转**，内层 iframe 自己 reload 成批阅页 | 源码实证 + 实测记录 |

---

## 1. 页面骨架：iframe 链与三套题目容器（先搞清在哪个文档里找）

**【实测记录 + 源码实证】** 学习通一节视频的 DOM 是三层 iframe 套娃（同源 `mooc1.chaoxing.com`，可跨层访问）：

```
顶层文档 (studentstudy)
└─ iframe#iframe                       → knowledge/cards 知识卡片页
   ├─ iframe.ans-insertvideo-online     → 视频播放器（内含 <video>，弹题也在这层）
   └─ iframe[src*='ananas/modules/work'] → 作业/测验模块加载器
      └─ iframe#frame_content           → 真正的测验页（.TiMu / .questionLi）
```

- 来源：`sansssssss1/auto-online-course-agent-skill` → `knowledge/chaoxing.md` §2「播放页结构」
  <https://github.com/sansssssss1/auto-online-course-agent-skill/blob/main/knowledge/chaoxing.md>
- 交叉印证（源码实证）：`unraous/uxuescript` → `injected/chaoxing/selectors.js`
  `quiz.frameContentId: "#frame_content"`、`taskPoint.containerSelector: ".ans-attach-ct:has(.ans-job-icon)"`、
  `urls.quiz: "/ananas/modules/work/"`、`urls.video: "/ananas/modules/video/"`。
- 交叉印证（源码实证）：`pang-qin/chaoxing-toolkit` → `学习通脚本.js`，按 iframe src 正则分发：
  `/ananas/modules/work/index.html` 是作业/测验，`/ananas/modules/audio/index.html` 音频，`/ananas/modules/pdf/index.html` 文档；
  测验页在 `/ananas/modules/work` 里**再套一层 iframe**（脚本里 `iframe.contentWindow.document.querySelector("iframe")`）。

**对实现的建议（重要）**
1. 题目**不一定在当前 `document`**。必须按「当前文档 → 递归同源 iframe（深度≥3）」找题目容器，而不是只 `document.querySelector('.TiMu')`。
2. **提交确认弹窗在顶层文档**，题目在最内层 iframe —— 这两者不在同一个 document 里。
   实测记录的原话：「最内层 `a.btnSubmit` → **顶层文档**确认层 `.popDiv.Marking`」。
3. 判断"这是不是测验页"最稳的不是 URL，而是「文档里存在 `.TiMu` 或 `.questionLi`」。

---

## 2. 【问题 1】章节测验到底分不分页？——**不分页**

### 2.1 事实

**（a）章节测验整页渲染全部题目。**
- 源码实证：`unraous/uxuescript` → `injected/chaoxing/course/chapter/tasks/quiz.js`
  整个处理流程是：`wait.iframeDoc(#frame_content)` → `answerPage(quizDoc, SELECTORS.quiz)` →
  `answerPage()` 内部 `parseFolio(root, selectors)` 一次 `root.querySelectorAll(selectors.question)` 拿到**全部**题目，
  再统一回填 → `a.btnSubmit` 提交。**全程没有任何翻页动作**。
- 源码实证：`pang-qin/chaoxing-toolkit` → `学习通脚本.js` 的 `work(iframeWindow)`：
  `const Timu = iframeWindow.document.querySelectorAll(".TiMu");` → `for` 循环逐题答完 → `btnBlueSubmit()`。
- 实测记录：`sansssssss1/...` → `knowledge/chaoxing.md` §15（四门课 **174 节**全部提交成功）
  与 `docs/field-notes.md` 2026-09-23/24：流程是「打开 → 出图读题 → 点选项 → 提交」，同样**没有翻页**。

**（b）题目之间靠标题分组，不是靠分页。**
真实页面样本（附录 A-1，`webpage.html`）里在判断题组前面有：

```html
<h3 class="newTestType">二. 判断题（共3题）</h3>
```

源码实证：uxuescript 用 `.type_tit` 作为分区标题（`SELECTORS.quiz.folio.section`）。
两份证据的类名不同（`newTestType` vs `type_tit`），说明这个分组标题类名**版本间会变**，只建议用来做"题型分组提示"，不要当硬依赖。

**（c）真正分页的是「考试」，而且考试有两种呈现。**
源码实证：`unraous/uxuescript` → `injected/chaoxing/exam.js`：

```js
if (window.location.pathname.endsWith("/mooc2/exam/preview")) {
  // 整卷预览：一页全题 → answerPage(document, SELECTORS.examPreview)
} else if (document.querySelector(".mark_info")?.textContent.includes("不允许整卷预览")) {
  await answerPaged();   // ← 逐题分页，走两遍法
} else {
  page.topreview();      // 先切到"整卷预览"
}
```

**分页（逐题）模式的特征**（源码实证，uxuescript → `injected/chaoxing/exam/paged.js`）：

| 特征 | 值 |
|---|---|
| 答题卡条目 | `.topicNumber_list li[data-asq]`（`data-asq` = 页面内部题 id）|
| 跳题入口 | 页面全局函数 `getTheQuestionByStart(start, '0')`，`start` 从答题卡 `onclick` 里正则抽出 |
| 当前题容器 | `.questionLi.singleQuesId`，`data` 属性 = 题 id |
| 判定"当前题与进度一致" | `node.getAttribute("data") === run.entries[run.index].id` |
| 暂存/交卷 | 页面全局函数 `window.submitForm(save: boolean, submit: boolean, callback)` |
| 限制回看/顺序的隐藏字段 | `forbidAnsweredAgain`、`forbidGroupAnswerBack`、`singleQuesLimitTime`、`groupLimitTimeType`、`limitTimeType`、`allowAnswerBack === '0'` |
| 进度持久化 | `sessionStorage['uxs:exam:folio:' + testPaperId + ':' + testUserRelationId]` |
| 翻页后如何续跑 | 翻页是**整页导航**（`window.location.href` 变化），导航后脚本重新注入、读 sessionStorage 继续 |

**翻页按钮（另一套实现）**：源码实证 `pang-qin/chaoxing-toolkit` → `学习通脚本.js`：
```js
const nextButton = $('.nextDiv .jb_btn:contains("下一题")');
nextButton ? nextButton.click() : (…已完成…);
```
即考试翻页按钮是 **`.nextDiv` 里的 `.jb_btn`，文案「下一题」**。

**考试题容器与选项的旧版结构**（源码实证，`CodFrm/cxmooc-tools` → `src/mooc/chaoxing/topic.ts` + `question.ts`）：
- 题号：`document.querySelector(".current")`，题型标题在 `current.parentElement.previousElementSibling.innerText`
- 题容器：`.leftContent.TiMu`；题干 `.Cy_TItle.clearfix .clearfix`
- 选项文字：`.Cy_ulTop.w-top li div.clearfix a`；选项控件：`.Cy_ulBottom.clearfix.w-buttom li input`
- 填空：`.Cy_ulTk .XztiHover1`，空位内的 `input.inp` 或 `textarea`（UEditor）
（`.Cy_*` 是考试页专用类名，和章节测验的 `.Zy_*` 不是一套，别混用。）

### 2.2 对实现的具体建议（板块 3「两遍法」怎么落地）

1. **不要给章节测验写翻页逻辑**。写了也永远命中不到，反而会引入"误点别的 a.jb_btn"的风险。
2. **两遍法在章节测验里的真实落点是「先采集、后作答」**，不是为了翻页，而是因为：
   - 字体混淆只在**待作答态**存在，提交后页面才给明文（实测记录 §12）：先采集题面（含解密/出图）再动手，才有统一文本可查题库；
   - **部分测验附件限制打开次数**（实测记录 §15.6：「此附件仅支持打开 N 次…不能再次打开」），
     所以必须"读完全部题 → 再点选项 → 一次提交"，中途刷新/重进可能直接把这次机会废掉。
3. **如果要做考试**：照 uxuescript 的 `phase: collect → answer` 状态机 + sessionStorage 续跑写，
   并且**先判断能不能两遍**（`allowAnswerBack` / `forbidAnsweredAgain` 等隐藏字段），不能就退化成单遍或只暂存不交卷。
4. 翻页/跳题一律**点页面自己的入口**（`getTheQuestionByStart` 或 `.nextDiv .jb_btn`），不要拼 URL——
   实测记录明确写了 `enc` 参数每次轮换、拼直链必报「enc校验失败」。

---

## 3. 【问题 2】简答题 / 填空题的真实 DOM，以及怎么区分主客观题

### 3.1 章节测验的新版结构（**页面实证**，这是最硬的一条）

样本：`research/gh/ux/sample_webpage.html`（来自 uxuescript 仓库 `src-tauri/tests/assets/course-page/webpage.html.gz`，
真实抓包，5 道题，含 `font-cxsecret` 混淆）。结构精确如下（`data` 值取自样本）：

```html
<div class="singleQuesId" data="404303512">              <!-- 每题外层，data = 题目 id -->
  <div class="TiMu newTiMu" data="0">                    <!-- data = 题型码：0 单选，3 判断 -->
    <div class="Zy_TItle clearfix">
      <i class="fl" role="option">1</i>                  <!-- 题号 -->
      <div class="clearfix font-cxsecret fontLabel">     <!-- 题干（含混淆字体）-->
        <span class="newZy_TItle">【单选题】</span>       <!-- 题型文字 -->
        <p>…题干…</p>
      </div>
    </div>
    <div class="clearfix">
      <ul class="Zy_ulTop w-top fl">
        <li class="font-cxsecret before-after" onclick="addChoice(this);"
            qid="404303512" qtype="0" role="radio" aria-label="A 选项文字选择">
          <label class="fl before">
            <span class="num_option choice404303512" name="answer404303512" data="A">A</span>
          </label>
          <a class="fl after"><p>选项文字</p></a>
          <div class="clear"></div>
        </li>
        …
      </ul>
      <input type="hidden" name="answer404303512"     id="answer404303512"     value="">   <!-- 答案落点 -->
      <input type="hidden" id="answertype404303512"   name="answertype404303512" value="0"> <!-- 题型：0 单选 -->
    </div>
  </div>
</div>
```

判断题额外包一层 `.Py_tk`，选项文本是「对 / 错」，`aria-label` 是「对选择 / 错选择」，`span[data]` 是 `true/false`：

```html
<div class="Py_tk">
  <ul class="Zy_ulTop w-top fl">
    <li … qtype="3" role="radio" aria-label="对选择">
      <label><span class="num_option …" data="true">A</span></label>
      <a class="fl after">对</a>
    </li>
    <li … qtype="3" role="radio" aria-label="错选择">… data="false" … >错</a></li>
  </ul>
</div>
```

**要点（和本项目 v2.x 的假设相反）：选项里没有 `<input>`。**
- 页面实证：整个样本 `input[type=radio]` / `input[type=checkbox]` 数量为 **0**；只有每题两个 `type="hidden"` 的 `answer{qid}` / `answertype{qid}`。
- 选中的落点是隐藏字段：点 `li`（`onclick="addChoice(this)"`）后，页面把选项值写进 `input[name='answer{qid}']`。
- 实测记录（174 节）原话：「选项 `li onclick="addChoice(this)"` → 答案写入 hidden `input[name='answer{qid}']`（value=字母）；**校验读 hidden input**」。
- 交叉印证（源码实证，ocsjs 打包版 `kukuqi666/chaoxing-script-ai` → `超星学习通.js`）：
  `zj` 页面按 `aria-checked === "true"` 判断"已选中"再点，不依赖 input。

### 3.2 主客观题怎么区分（两套独立源码实现，结论一致：**看题型文字**）

**方案 A（uxuescript，`injected/chaoxing/questions/extract.js`，源码实证）**：
```js
export const classifyQuestion = (titleText) => {
  if (titleText.includes("多选")) return MultipleChoice;
  if (titleText.includes("判断")) return Judgment;
  if (titleText.includes("单选")) return SingleChoice;
  if (titleText.includes("填空")) return Completion;
  if (titleText.includes("分录")) return Completion;
  if (titleText.includes("简答")) return ShortAnswer;
  if (titleText.includes("论述")) return ShortAnswer;
  if (titleText.includes("计算")) return ShortAnswer;
  if (titleText.includes("翻译")) return Translation;
  if (titleText.includes("连线")) return Matching;
  return Other;   // Other = 不支持，跳过、不猜
};
```
题型文字取自 `selectors.kind`：章节测验是 `.newZy_TItle`，作业/考试是 `.colorShallow`，
并且用 `/[\u4e00-\u9fff]+/` 抽出第一段中文（把「【单选题】」变成「单选题」）。

**方案 B（ocsjs 打包版，源码实证）——中文题型 → 数字码的完整表**：
```js
"单选题": "0", "A1型题": "0",
"多选题": "1", "X型题": "1",
"填空题": "2",
"判断题": "3",
"简答题": "4",
"名词解释": "5",
"论述题": "6",
"计算题": "7"
// type = map[questionTypeText.replace("【","").replace("】","")] || "999"
```
同一份代码里，三种页面的取值方式不同（**这条非常有用，直接决定选择器**）：

| 页面 | 类型判定 | 题干 | 选项容器 | 选项文字 |
|---|---|---|---|---|
| 章节测验 `zj` | `.newZy_TItle` 文本 | `.fontLabel` | `[class*="before-after"]`（即每个 `li`）| `.fl.after` |
| 作业 `zy` | **容器属性 `.questionLi[typename]`** | `h3` | `.answerBg` | `.answer_p` |
| 考试 `ks` | `.colorShallow` 文本第 2–4 字 | `h3` | `.answerBg` | `.answer_p` |

**方案 C（补充信号，页面实证）**：每题容器 `.TiMu` 自己的 `data` 属性就是题型码，样本里
`data="0"` = 单选、`data="3"` = 判断，与方案 B 的表**完全对齐**；
提示块 `span.newZy_TItle` 同时给出中文题型。
→ 建议：**优先中文题型文字 → 数字码（可读性最好）；`.TiMu[data]` 作为兜底；两者矛盾时按中文文字走**。
（`data="1"`=多选、`data="2"`=填空 在样本里没出现，属**推测**，不要单靠它下判断。）

### 3.3 主观题（填空 / 简答）的输入控件

| 场景 | 控件与选择器 | 来源 | 强度 |
|---|---|---|---|
| 章节测验 填空 | 多空 `textarea`（或 `input`），选择器 `textarea[id^="answer"], textarea`；空位容器 `.blankItemDiv` | uxuescript `selectors.js` `quiz.textInputs` / `quiz.blanks` | 源码实证 |
| 章节测验 填空/简答 | `question.element.querySelectorAll("textarea")` → `UE.getEditor(textarea.name).setContent(答案)`；取不到编辑器则 `textarea.value = ""` | ocsjs 打包版 `超星学习通.js`（`type==="2"` 与 `"4"/"6"` 两个分支）| 源码实证 |
| 简答/论述 | 题目内**第一个** `textarea`；写入仍走 UEditor | uxuescript `questions/fill.js` `fillShort` + `questions/editor.js` | 源码实证 |
| UEditor 富文本 | `textarea` 只是壳，真正的编辑器实例是 `UE.getEditor(textarea.id 或 textarea.name)`，`editor.isReady` 才能写；`editor.setContent(text)` | uxuescript `editor.js`（`page.UE.getEditor(textarea.id)`）/ ocsjs（用 `textarea.name`）/ cxmooc（用 `textarea.name`）| 源码实证（三处一致，id/name 两说）|
| 简答编辑器 iframe | `iframe[id^="ueditor_"]` | uxuescript `selectors.js` `quiz.ueditorIframe` | 源码实证 |
| 作业 填空 | 空位 `.stem_answer .Answer`；输入 `.stem_answer textarea, .stem_answer input[type='text']` | uxuescript `selectors.js` `workExam.blanks` / `textInputs` | 源码实证 |
| 旧版 填空 | 容器 `.Zy_ulTk`，每个空 `.XztiHover1`，输入 `input.inp`，没有 input 时是 UEditor `textarea` | cxmooc `question.ts` `cxFillQuestion.Fill` | 源码实证 |
| 新版填空疑似改版 | 用户报告：「超星把 `<input>` 换成了 UEditor contenteditable iframe 且嵌套在多层 iframe」 | ocsjs issue #328 <https://github.com/ocsjs/ocsjs/issues/328> | 文档自述（用户猜测口吻，未验证）|

**对实现的具体建议（板块 2 可直接抄）**
1. **区分主客观先看题型文字**，用 3.2 的映射；认不出的一律 `unknown` → **只采集不填、不提交**（uxuescript 就是这样：`Other` 直接跳过，甚至在提交前 `assert(skipped.length === 0)` 直接拒绝提交）。
2. **客观题**：`block.querySelectorAll('li.before-after')`（兜底 `.Zy_ulTop > li`）；点 `li`；
   校验读 `input[name='answer{qid}']` 非空。**不要要求 `li` 里有 `input`**——这是当前 v2.x 最大的坑（见 §7）。
3. **判断题**：可以按 `li[aria-label]` 是否含「对选择/错选择」识别（ocsjs 就这么干），
   也可以按 `span[data]` 的 `true/false`；两者都在样本里成立。写入后隐藏字段会变 `"true"/"false"`。
4. **填空题**：先数空位（`.blankItemDiv` 或题目内 `textarea/input` 数量），
   **答案分段数 ≠ 空位数就放弃这道题**（uxuescript `fillCompletion` 里是硬 assert：「需要 N 个非空答案，收到 M 项，拒绝填写」）。
5. **简答题**：填 `textarea`，优先 `UE.getEditor(textarea.id || textarea.name).setContent(text)`，
   失败再退回 `textarea.value = text` + `dispatchEvent(input/change)`。
6. **主观题不参与"答对/答错"统计**：平台判分前不知道对错，实测记录里也是把"需人工处理的题号"列出来交给用户。
7. 多空填空的"空位序号"：旧版用 `第X空：` 文本前缀标识（pang-qin / cxmooc 都这么解析），
   新版建议**按 DOM 顺序**对应，别去解析中文。

---

## 4. 【问题 3】视频弹题（`.ans-videoquiz`）的真实层级

**实测记录（最细，且与源码吻合）**：`sansssssss1/...` → `knowledge/chaoxing.md` §11.3：

```
.x-container.ans-timelineobjects                       (z-index 101，播放器时间轴层)
└─ .ans-videoquiz#videoquiz-*                          (弹题浮层)
   └─ .tkTopic                    ← 新版题面直接写在这里
      └─ .tkTopic_con.tkScroll
         ├─ li.ans-videoquiz-opt > label > span.tkRadio > input[type=radio][name='ans-videoquiz-opt']
         │                                                (多选题为 input[type=checkbox])
         └─ a#videoquiz-submit / a#videoquiz-submitting / a#videoquiz-continue
```

**源码实证（uxuescript `selectors.js` + `course/chapter/tasks/interactive.js`）**：
```js
video: {
  quizClass: ".ans-videoquiz",
  quizItemClass: ".tkItem",            // 旧版：一个浮层里可能有多道子题
  quizTitleClass: ".tkItem_title",
  quizOptionClass: ".ans-videoquiz-opt",
  quizSubmitId: "#videoquiz-submit",
  quizContinueId: "#videoquiz-continue",
}
```
`interactive.js` 里的行为证据：
- 点选项：`optionNode.querySelector("label")?.click();`（点 label，不点 li）
- 重置：`for (const input of quizRoot.querySelectorAll("input")) input.checked = false;`
  → **说明弹题选项必然有 `input`**
- 提交后：`#videoquiz-submit`.click()，然后等 `#videoquiz-continue` 可见就点它

**关键细节（实测记录，和源码互相印证）**：
- **必须点 `input[type=radio]`（或点 `label`），点 `li` 无效**：
  「点 `li` 无效（自定义 UI 不转发，提交空答案必判错——曾有 3 次误判为"平台答案键与教材相反"，实为选项没选上）」。
  → 落地写法：点 `input.click()` → 立刻校验 `input.checked === true` → 不成立就点 `label`。
- **提交按钮的 id 有两个易混**：真实是 `a#videoquiz-submit`；
  本项目 v2.x 用的 `.ans-videoquiz-submit` **未找到可靠来源**（有一个第三方脚本按文案「提交」兜底找按钮，
  见 chaolucky18/xuexitongScript issue #39，但那是对着未知结构硬找文本，不算结构证据）。
- **答错要重答**：判「回答错误」后浮层会滞留（`.tkTopic` 不消失）、`a#videoquiz-submit` 仍可点、
  视频可能自动续播 → 只探测"有没有弹题"会把"答错滞留"误判成"已处理"，必须单独识别「回答错误」文案并重答。
- **弹题的题面是明文**（不做字体混淆），可以直接读文本，不用出图。
- **弹题答不上，那一节的视频很可能白播**（实测：答上的节计数 1→0，没答的节播完仍是 1）。
- 旧版兼容：`tkItem` / `tkItem_title`（uxuescript）——新版题面在 `.tkTopic` 里，
  旧模块用 `.tkItem_title` 会取不到题（field-notes 里踩过：两个模块互相让位，结果两个都不答）。

**对实现的具体建议**
1. 容器探测：`.ans-timelineobjects .ans-videoquiz`（兜底 `.ans-videoquiz`）；**可见**才处理
   （浮层会滞留 DOM，必须看 `getBoundingClientRect().width > 0` + `display !== 'none'`）。
2. 选项：`li.ans-videoquiz-opt input[type=radio], li.ans-videoquiz-opt input[type=checkbox]`，
   **点 input → 校验 checked**；点 label 作兜底；**永远别点 li**。
3. 提交：`a#videoquiz-submit`（兜底：`.ans-videoquiz` 内文案为「提交/确定」的可见按钮）。
4. 提交后：若出现 `a#videoquiz-continue` 或文案「继续学习」，点它恢复播放。
5. 识别「回答错误」→ 重答（同一 input 重选 → 校验 → 再点 submit）。
6. 多选题：input 是 checkbox，可多选；别按"单选"处理。

---

## 5. 【问题 4】提交确认弹窗（各版本）

| 版本/来源 | 提交按钮 | 确认层 | 确认按钮 | 强度 |
|---|---|---|---|---|
| 新版章节测验（实测 174 节 + 9/9 次） | 最内层 `a.btnSubmit` | **顶层文档** `.popDiv.Marking`（`#popcontent` 文本「确认提交？」）| 文本**以「提交」开头**的 `a.jb_btn`（勿点「取消」）| 实测记录 |
| ananas 作业/测验（uxuescript） | `a.btnSubmit` | `#workpop` | `a#popok` | 源码实证 |
| 更老的作业页（cxmooc-tools） | `.Btn_blue_1` | `#tipContent`（含「未做完」则中止）| `.bluebtn`（等 `#validate` 验证码消失后再点）| 源码实证 |
| 页面级函数（ocsjs / pang-qin） | `iframeWindow.btnBlueSubmit()` | 页面自己弹 | `iframeWindow.submitCheckTimes()` | 源码实证 |
| 仅暂存不交 | `iframeWindow.noSubmit()` | — | — | 源码实证 |

- `.popup_confirm` / `.popup_confirm .btnOk`：**未找到可靠来源**。本项目 v2.x 与测试 mock（`tests/mock/work.html`）
  里都有它，但那是本项目自己造的，**不能当证据**。
- `.layui-layer` / `.layui-layer-btn0`：**未找到"提交确认"场景的证据**。
  唯一出现是在 pang-qin 的「微信扫码验证弹窗」通用探测列表里（探测弹窗是否存在，不点它），
  **不足以证明提交确认用 layui**。→ 只建议作为最后兜底，且必须配合"文本里含『确认提交』"。
- 实测记录还给了两条硬约束：
  1. **两步之间不要调 `closeDeleteWindow()`**——它会把确认层一起关掉，提交静默失败（页面仍停在作答态）。
     「当前章节还有任务点未完成」的提示要在**点提交之前**关。
  2. 成功判据不是"点了确认"，而是**出现「已完成 · 第N次作答 · 本次成绩X分」且 `a.btnSubmit` 消失**。
- 可见性：`.popDiv` 家族**常驻 DOM 且 `display:block`**，所以判断"弹窗出现了吗"要用
  `getBoundingClientRect().width > 0`（uxuescript 另外用 `getComputedStyle(modal).display !== 'none'` + "曾经打开过"的状态位）。

**对实现的具体建议（按顺序试，命中即停）**
```js
// 1) 新版：顶层文档
const pop = [...top.document.querySelectorAll('.popDiv')]
  .find(el => el.getBoundingClientRect().width > 0 && /确认提交/.test(el.textContent));
if (pop) {
  const ok = [...pop.querySelectorAll('a.jb_btn')]
    .find(a => /^\s*提交/.test(a.textContent));      // 「提交」/「提交答案」，不要匹配「取消」
  ok?.click();
}
// 2) 老版 ananas
top.document.querySelector('#workpop a#popok')?.click();
// 3) 页面函数兜底（work iframe 的 window 上）
win.submitCheckTimes?.();
```
- 点提交后**等 2~3 秒**再找确认层（实测 2.5s 稳定；v2.x 现在是 600/1500/2800 三次盲点，可保留但应改为"探测到才点"）。
- 只点一次确认：连着点容易把"提交中"变成重复提交或掉登录。

---

## 6. 【问题 5】判分反馈：能不能拿到"答对几题"

### 6.1 提交后本页就能看到成绩（**推荐主用**）

- 实测记录（174 节 + 课程② 9/9）：成功判据文本是
  **「已完成 · 第N次作答 · 本次成绩X分」**（另一种写法「最终成绩X分」），并且 `a.btnSubmit` 消失/不可见。
- 源码实证（cxmooc-tools `topic.ts` `CxCourseTopic.Submit`）：提交后**内层 `#frame_content` 会 load 到
  `selectWorkQuestionYiPiYue`（已批阅）页面**，脚本在那里 `CollectAnswer()` 抓正解。
- 分值口径（实测）：**每题分值 = 100 / 题量**（5 题 → 每题 20；3 题错 1 → 66.6）。
  → 「答对题数」可以近似为 `round(成绩 / (100 / 题量))`，但这只在"部分分题型不出现"时准确。

### 6.2 逐题对错（要精确就得读批阅页，旧版结构）

源码实证（cxmooc-tools `question.ts` 的 `isCorrect()` / `Correct()`；pang-qin 同款解析）：

| 含义 | 选择器 |
|---|---|
| 我的答案/正确答案区块 | `.Py_answer.clearfix`（判断题也可能在 `.Py_tk` 里） |
| 答对图标 | `.fr.dui` |
| 答错图标 | `.fr.cuo` |
| 半对（多选部分分） | `.fr.bandui` |
| 正解文字 | 区块内 `span` 的 innerText（含「正确答案：」/「我的答案：」前缀，需要剥） |
| 每题得分 | `.Cy_TItle.clearfix .font18.fb`（考试）/ 同位置的 `.font18.fb`；`!= "0.0"` 视为得分 |
| 填空每空答案 | `.Py_tk span.font14`（无则 `.Py_answer.clearfix .font14`），前缀「第X空：」 |
| 判断题正解 | `.Py_answer` 里 `√`/`×`，配合 `.fr.dui`/`.fr.cuo` 反推（答对→我的=正解；答错→反过来） |

**强度说明**：这套类名来自 2021–2022 年的页面（cxmooc）与 pang-qin 的解析代码，**属旧版结构**；
新版（`.singleQuesId` / `newTiMu`）的批阅页在本轮没抓到样本 → **未验证，必须运行时探测**（见下）。

### 6.3 重做入口（"两遍法/错题重做"的前提，别假设一定有）

- 实测记录（关键）：重做可用性**因课程而异**：
  - 课程②型：结果页**明文列出每题正解** + 「重做(剩余 N 次)」按钮 → 可以按正解修正到满分；
  - **课程③型：结果页无明文正解、无重做按钮（HTML 无 redo 标记）**，retest 接口返回「作答状态或作答次数已变化」
    → 重做通道死路，交完即定；
  - 及格线可能是 0（页面 JS `passingStandard="0"`）→ 低分也照样点亮任务点。
- 源码实证（uxuescript `selectors.js`）：`reeditBtnClass: "a.jb_btn_bg[onclick*='reediter']"`
  —— 说明**存在** `onclick` 里带 `reediter` 的重做按钮（这是"重做"最靠谱的选择器）。
- 另外**0 分提交可能不点亮任务点**（实测：唯一判断题答错 → 0 分 → 未点亮，平台要求重做）。

**对实现的具体建议**
1. 提交后**先探测**：`a.btnSubmit` 是否消失 + 页面文本是否含「已完成」/「成绩」→ 判断是否真的交上去了。
2. 再探测**有没有**重做：`a.jb_btn_bg[onclick*='reediter']` 或文本 `/重做/`；
   有 → 允许"错题重做"；没有 → **明确记日志"该课程不支持重做"，直接推进**（不要无限重试，也不要把"没重做"当成失败）。
3. 「答对几题」优先用 6.1 的成绩估算；要精确就解析 6.2，但**所有选择器都要包在 try/空判断里**，解析失败就退回成绩估算。
4. 不要把"答题覆盖率"当"正确率"——DaRin1403 issue #1 就是为这个报的 bug（日志显示 3/3「已作答」但页面实际未选）。

---

## 7. 【问题 6】提交成功后的页面行为

- **章节测验：不整页跳转。** 内层 `#frame_content` 自己 reload 成批阅页（`selectWorkQuestionYiPiYue`），
  顶层学习页原地不动。源码实证（cxmooc `topic.ts` 监听 `#frame_content` 的 load）+ 实测记录（成绩文本出现在同一页）。
- **任务点完成标记**：任务点容器加 `ans-job-finished`（uxuescript `taskPoint.finishedClass`）；
  章节树行内 `.icon_Completed`（实测记录 §2）。
- **"返回"按钮：未找到可靠来源。** v2.x 里的 `.backBtn/.returnBtn/.btnBack/#backBtn/.completeBtn`
  在本轮所有源码里**都没有出现过**，属臆造，建议删掉或降级为最后的文案兜底。
- **下一节按钮**（有源码实证）：
  - 顶层 `#prevNextFocusNext`（cxmooc-tools / ocsjs / 实测记录 §2 都提到），点击是**整页跳转**；
  - 新版 `.jb_btn.jb_btn_92.fr.fs14.nextChapter`（ocsjs 打包版源码实证）。
- **未做完就提交**：老版会 `alert` / 在 `#tipContent` 里提示「未做完」，cxmooc 的处理是直接放弃并告警。
  → 建议：点确认后若页面出现「未做完/未完成」，当作提交失败，记录并停止（不要死循环重试）。
- **提交卡「提交中」+ 掉登录**：实测记录里出现过，处置是整页刷新 → 重登 → 回学习页。
  → 建议：提交后 20s 内既没成绩、按钮也没消失，就判定"提交结果未知"，**不要重复点提交**。

---

## 8. 与本项目 v2.x 现有实现的差异清单（板块 2/3 的改造入口）

> 下面每条都指向 `xuexitong-assistant.user.js` 现有行号（只读取，未修改）。

| # | 现状 | 真实情况 | 影响 |
|---|---|---|---|
| 1 | `parseWorkQuestions()` 用 `el.querySelector('input')` 过滤选项（L1451-1456） | 新版章节测验选项里**没有 input**，答案在 `input[name='answer{qid}']` | **整页题目会被全部过滤掉**，表现为"未检测到作业题目" |
| 2 | `.Zy_ulTop li, ul li` 取选项 | 应优先 `li.before-after`（ocsjs）/ `.Zy_ulTop > li`（uxuescript） | 容易混进非选项的 li（题号列表、导航） |
| 3 | 没有"题型"概念，靠 `input.type` 猜单选/多选 | 题型在 `.newZy_TItle`（中文）/ `.TiMu[data]`（数字）/ `.questionLi[typename]` | 无法区分主客观，简答题会被当客观题处理 |
| 4 | `confirmSubmitDialog()` 里 `.popup_confirm .btnOk` 等（L1481） | `.popup_confirm` **无来源**；真实是顶层 `.popDiv.Marking` + `a.jb_btn`（文本以「提交」开头）、老版 `#workpop a#popok` | 自动提交会卡在确认层，任务点永远不点亮 |
| 5 | `doSubmit()` 找 `.btnSubmit, #submitBtn, .submitBtn, .BtnSubmit`（L1514） | `a.btnSubmit` 对；老版是 `.Btn_blue_1`；另有页面函数 `btnBlueSubmit()/submitCheckTimes()` | 老版页面找不到提交按钮 |
| 6 | `backToCourse()` 找 `.backBtn/.returnBtn/...`（L1498） | **这些类名无来源**；真实可用的只有 `#prevNextFocusNext` / `.jb_btn.jb_btn_92.fr.fs14.nextChapter` | 提交后可能乱点页面元素 |
| 7 | 弹题 `SUBMIT_SELECTORS = '.ans-videoquiz-submit, ...'`（L1244） | 真实是 `a#videoquiz-submit` | 弹题永远提交不了，视频卡住 |
| 8 | 弹题 `OPT_SELECTORS` 已含 `.ans-videoquiz-opt`（L1243） | ✅ 正确；但**点 li 无效**，需点 `input`/`label` 并校验 `checked` | 选项看着点了、实际没选上 → 必判错 |
| 9 | 题目只在 `doc` 里找（L1443/1447） | 题目在最内层 `#frame_content` iframe，确认层在**顶层** | 找不到题/找不到确认按钮 |

---

## 9. 直接可抄的选择器集（建议实现顺序：主选 → 兜底）

```js
// —— 容器 ——
QUIZ_DOC_CHAIN   = ['#frame_content', 'iframe']              // 递归同源 iframe 深度>=3
QUIZ_BLOCK       = '.TiMu, .questionLi'                      // 作业/考试：.questionLi(.singleQuesId)
QUIZ_WRAP        = '.singleQuesId'                           // 每题外层（data=qid）
TYPE_TEXT        = '.newZy_TItle'                            // 章节测验题型文字【单选题】
TYPE_TEXT_WORK   = '.colorShallow'                           // 作业/考试题型+分值
TYPE_ATTR        = '.TiMu[data]'                             // 0/1/2/3 数字题型码
TYPE_ATTR_WORK   = '.questionLi[typename]'                    // 作业题型（源码实证）
STEM             = '.fontLabel'                              // 章节测验题干（含 font-cxsecret）
STEM_WORK        = 'h3'                                      // 作业/考试题干
NUMBER           = '.Zy_TItle > i.fl'                        // 题号

// —— 客观题 ——
OPTION           = 'li.before-after'                         // 兜底 '.Zy_ulTop > li'
OPTION_TEXT      = '.fl.after'                               // 兜底 'a.fl.after' / '.after'
OPTION_LABEL     = 'span.num_option, span.num_option_dx'     // data=A..H / true|false
OPTION_SELECTED  = '[aria-checked="true"], span.check_answer, span.check_answer_dx'
ANSWER_HIDDEN    = 'input[name^="answer"]'                   // 读它判断"是否已作答"
ARIA_JUDGE       = 'li[aria-label*="对选择"], li[aria-label*="错选择"]'

// —— 主观题 ——
TEXT_INPUTS      = 'textarea[id^="answer"], textarea, input[type="text"]'
BLANKS           = '.blankItemDiv, .stem_answer .Answer'      // 兜底：题目内 textarea/input 数量
UEDITOR_IFRAME   = 'iframe[id^="ueditor_"]'

// —— 提交 ——
SUBMIT_QUIZ      = 'a.btnSubmit'                              // 兜底 '.Btn_blue_1'
POP_TOP          = '.popDiv'                                  // 顶层文档；用 width>0 判可见
POP_OK           = 'a.jb_btn'                                 // 文本以「提交」开头
POP_OLD          = '#workpop a#popok'
PAGE_FN          = ['btnBlueSubmit', 'submitCheckTimes', 'noSubmit'] // work iframe 的 window 上

// —— 弹题 ——
VQUIZ            = '.ans-videoquiz, .ans-videoquiz-box'
VQUIZ_OPT        = 'li.ans-videoquiz-opt'
VQUIZ_INPUT      = 'li.ans-videoquiz-opt input[type="radio"], li.ans-videoquiz-opt input[type="checkbox"]'
VQUIZ_SUBMIT     = '#videoquiz-submit'
VQUIZ_CONTINUE   = '#videoquiz-continue'
VQUIZ_TOPIC      = '.tkTopic'                                 // 新版题面
VQUIZ_ITEM_TITLE = '.tkItem_title'                            // 旧版题面（可能取不到）

// —— 结果页 ——
RESULT_TEXT      = /已完成|本次成绩|最终成绩|待批阅/
REDO_BTN         = "a.jb_btn_bg[onclick*='reediter']"          // 兜底：文本含「重做」
MARK_CORRECT     = '.fr.dui'
MARK_WRONG       = '.fr.cuo'
MARK_HALF        = '.fr.bandui'
MARK_AREA        = '.Py_answer, .Py_tk'
NEXT_SECTION     = '#prevNextFocusNext, .jb_btn.jb_btn_92.fr.fs14.nextChapter'
```

---

## 10. 没查到 / 查到但不可信的（**实现时不要依赖**）

| 项 | 状态 |
|---|---|
| `.popup_confirm` 及 `.popup_confirm .btnOk` | **未找到任何来源**（本仓自造，`tests/mock/work.html` 也是自造） |
| `.layui-layer-btn0` 用于提交确认 | 未找到证据（只在"检测微信验证弹窗"的探测列表里出现过） |
| 章节测验有"下一页/下一题"按钮 | **未找到证据**；三份独立实现都按整页处理。若真遇到分页版，先按 `answerPaged` 的考试思路探测，不要预设 |
| 章节测验的"答题卡"（`.topicNumber_list`） | 只在**考试**里见到；章节测验样本里没有 |
| 提交后的"返回"按钮类名 | 未找到来源 |
| 新版批阅页的逐题对错类名 | 用的是 2021–2022 年的旧结构，新版未验证 |
| 简答题在**新版**章节测验里的确切 DOM（是否有 `.blankItemDiv`） | 未抓到样本；只能按 `textarea` + UEditor 兜底 |
| `.TiMu[data]` 的 1（多选）/2（填空）取值 | 样本只有 0/3，其余是**推测** |
| 弹题提交按钮的**可见文案** | 只有 id 证据；文案建议走 `#videoquiz-submit`，别只按文案找 |
| 考试交卷后的跳转 | 未调研（本轮优先章节测验） |

---

## 附录 A：本轮落盘的可复查证据

| 文件 | 内容 | 来源 |
|---|---|---|
| `research/gh/ux/sample_webpage.html` | **真实章节测验页面抓包**（5 题：2 单选 + 3 判断，含 `font-cxsecret`、隐藏答案字段） | uxuescript `src-tauri/tests/assets/course-page/webpage.html.gz` 解压 |
| `research/gh/ux/selectors.js` | 章节测验/作业/考试/弹题的全套选择器 | uxuescript `injected/chaoxing/selectors.js` |
| `research/gh/ux/questions__extract.js` | 题型文字 → 处理类别的映射 | 同上 `questions/extract.js` |
| `research/gh/ux/questions__fill.js` | 点 `span.num_option[data]`、清空 `.check_answer`、填空/简答填充 | 同上 `questions/fill.js` |
| `research/gh/ux/questions__editor.js` | UEditor 写入（`UE.getEditor(textarea.id)`） | 同上 `questions/editor.js` |
| `research/gh/ux/questions__folio.js` | 整卷解析、`.blankItemDiv` 空位数 | 同上 `questions/folio.js` |
| `research/gh/ux/course__chapter__tasks__quiz.js` | 章节测验整页作答 + `a.btnSubmit` + `#workpop/#popok` | 同上 `course/chapter/tasks/quiz.js` |
| `research/gh/ux/course__chapter__tasks__interactive.js` | 弹题处理（`.tkItem`、`#videoquiz-submit`、点 label、有 input） | 同上 `course/chapter/tasks/interactive.js` |
| `research/gh/ux/exam.js` / `exam__paged.js` | 考试整卷预览 vs 逐题分页（两遍法状态机） | 同上 `exam.js` / `exam/paged.js` |
| `research/gh/sans/knowledge__chaoxing.md` | 实测知识库（§2 iframe 链、§5 测验提交、§11.3 弹题、§15 174 节全流程） | sansssssss1/auto-online-course-agent-skill |
| `research/gh/sans/docs__field-notes.md` | 原始实测记录（提交两步、成绩判据、重做口径） | 同上 |
| `research/gh/other/kukuqi_cx.js` | ocsjs 4.x 打包版：题型码表、`zj/zy/ks` 三套解析、`btnBlueSubmit`/`submitCheckTimes` | kukuqi666/chaoxing-script-ai `超星学习通.js` |
| `research/gh/other/pangqin.user.js` | 章节测验整页遍历、考试 `.nextDiv .jb_btn`、批阅页 `.fr.dui/.fr.cuo` 解析 | pang-qin/chaoxing-toolkit `学习通脚本.js` |
| `research/gh/cxmooc/question.ts` / `topic.ts` | 旧版结构（`label>input`、`.Zy_ulTk`、`.Btn_blue_1`→`.bluebtn`、`selectWorkQuestionYiPiYue`） | CodFrm/cxmooc-tools |
| `research/gh/other/DaRin1403.user.js` | 弹题选择器清单、`clickButtonByText` 兜底 | DaRin1403/xuexitong-autostudy |

引用链接：
- uxuescript：<https://github.com/unraous/uxuescript>
- 实测知识库：<https://github.com/sansssssss1/auto-online-course-agent-skill>（174 节实战 PR：<https://github.com/sansssssss1/auto-online-course-agent-skill/pull/3>）
- cxmooc-tools：<https://github.com/CodFrm/cxmooc-tools>
- ocsjs 打包版：<https://github.com/kukuqi666/chaoxing-script-ai>
- chaoxing-toolkit：<https://github.com/pang-qin/chaoxing-toolkit>
- 相关 issue：<https://github.com/ocsjs/ocsjs/issues/328>（新版填空 UEditor）、<https://github.com/Samueli924/chaoxing/issues/627>（协议层成绩/错题数）、<https://github.com/DaRin1403/xuexitong-autostudy/issues/1>（"正确率"名不副实）

## 附录 B：给实现者的 5 条硬约束（违反会直接踩坑）

1. **章节测验没有 input**：选项是 `li[onclick="addChoice(this)"]`，答案写进 `input[name='answer{qid}']`。
   点 li → 读隐藏字段校验；**不要**因为 `li.querySelector('input')` 为空就跳过题目。
2. **确认层在顶层文档**（`.popDiv.Marking`），题目在最内层 iframe；两者要分别取。
   确认按钮只认「提交」开头的 `a.jb_btn`，别误点「取消」。
3. **提交两步之间不要调 `closeDeleteWindow()`**，否则确认层被一起关掉、提交静默失败（页面还停在作答态）。
4. **弹题必须点 input 并校验 `checked`**，点 li 无效；答错滞留要重答，否则那一节视频白播。
5. **别假设有「重做」**：部分课程结果页无正解、无重做，交完即定；提交后先探测再决定，别死循环。

# 真实学习通视频页：iframe 结构与播放器行为

> 目的：验证我们的 `tests/jump.e2e.test.js` / `tests/answer.e2e.test.js` 假设是否成立，
> 并判断板块 1「拟人化随机暂停」在真实播放器上是否可行。
>
> 可信度分级（同 `research/real-dom.md`）：
> - **源码实证**：第三方开源项目源码里读到该选择器/调用，可直接抄；
> - **页面实证**：真实页面抓包或项目自带测试样本；
> - **实测记录**：作者在真实账号上跑通并写进文档（有次数/战绩）；
> - **文档自述**：README/issue 一句话，未交叉验证；
> - **分析**：我基于前四类的推理，**标注了推理链**，实现前需实测确认。
>
> 调研时间 2026-10-30。抓取物在 `research/gh/video/`（本轮新增）与 `research/gh/`（上一轮）。
> 本文件只做调研，未修改 `xuexitong-assistant.user.js`。

---

## 0. 结论速览

| 问题 | 结论 | 强度 |
|---|---|---|
| 视频在哪个 frame | 顶层 `studentstudy` → `#iframe`(cards) → `iframe.ans-insertvideo-online`(视频) → 内层 `<video>`；测验在 `ananas/modules/work` → `#frame_content` | 实测记录 + 源码实证 |
| 目录在哪个 frame | 旧版：**顶层文档**（`.posCatalog_select`）；新版目录页：`#frame_content-zj` iframe 内 | 实测记录 + 源码实证 |
| 弹题在哪个 frame | 和 `<video>` 同一个 frame（视频播放器 iframe 内） | 源码实证 |
| 是否同源 | 学习通的页面 frame **全部同源** `mooc1.chaoxing.com`（实测）；视频文件本身在 CDN 域，但 `<video>` 元素在同源 frame 里 | 实测记录 |
| 播放器 | **video.js**（`.vjs-*` + 全局 `videojs()` + `#video_html5_api`），外层套学习通自研 `ans.VideoJs`（带 `timelineObjects` / `studyControl` 插件） | 源码实证 ×3 |
| `ended` 可靠吗 | 事件本身可靠（被当作完成信号用）；但 `ended` ≠ 平台已记录（"假完成"），且 ended 后播放器可能自动重播 | 源码实证 + 实测记录 |
| `playbackRate` 能设吗 | 能设（直接设 `video.playbackRate`）；但锁速课程里会被平台按 1x 钳住，控件 `.vjs-playback-rate` 带 `vjs-hidden` | 源码实证 + 实测记录 |
| 上报节奏 | `isdrag=3` 开始 → `isdrag=2` 每 **60s** → `isdrag=4` 结束（**isPassed 的开关**）；服务端异步复核真实时间间隔 | 源码实证（含原生参数名 `reportTimeInterval=60`）|
| 失焦暂停 | **分版本**：旧版播放器无焦点会主动暂停（play 后 3ms–2.5s 或 5–8s 周期）；新版无焦点暂停行为 | 实测记录（两段，互相区分）|
| 脚本能否重新 play | 能。第三方项目直接在 `<video>` 上 `play()` 恢复；但 ended 后不能再 play（会重播） | 源码实证 |
| 切章节 | 旧版 `#prevNextFocusNext` → **整页跳转**；新版点目录 → **内容 iframe 重载**；新版还有 `.jb_btn.jb_btn_92.fr.fs14.nextChapter` | 实测记录 + 源码实证 |
| sessionStorage 跨 frame | 同源框架同一 tab 共享 → `cxas_epoch` 方案成立；跨域 frame / 新标签不共享 | 规范 + 实测（全同源）|
| 任务点变绿 | 旧版任务点容器加 `ans-job-finished`；新版章节树行内 `.icon_Completed`；未完成有 `.orangeNew`、「N个待完成任务点」计数 | 源码实证 + 实测记录 |

---

## 1. 【问题 1】iframe 层级：视频、目录、弹题各在哪一层

### 1.1 真实链路

**【实测记录】** `sansssssss1/auto-online-course-agent-skill` → `knowledge/chaoxing.md` §2：

```
顶层文档（studentstudy 学习页）
├─ #iframe                          → knowledge/cards 知识卡片页
│   ├─ iframe.ans-insertvideo-online → 视频播放器（内含 <video>）
│   └─ iframe[src*='work']           → 作业模块加载器
│       └─ iframe#frame_content      → 真实测验页（.TiMu / .questionLi）
```

原话：「**【实测】iframe 链**（全部同源 mooc1.chaoxing.com，可跨层访问）」。

**【源码实证】** `unraous/uxuescript` → `injected/chaoxing/selectors.js`：
```js
taskPoint: {
  finishedClass: "ans-job-finished",
  containerSelector: ".ans-attach-ct:has(.ans-job-icon)",   // 任务点容器
  attachmentSelector: ".ans-attach-ct:has(iframe)",
  iframeTag: "iframe",
},
frames: { blankUrl: "about:blank", chapterFrameId: "#iframe" },
urls: { video: "/ananas/modules/video/", audio: "...", pdf: "...", quiz: "/ananas/modules/work/" },
```
`course/chapter/tasks.js` 的 `classifyTask(taskDoc)` 就是**按 iframe 的 URL** 分派任务类型：
`/ananas/modules/video/` → Video，`/ananas/modules/work/` → Quiz。

**【源码实证】** `chaolucky18/xuexitongScript` issue #39 里的脚本（作者自写、非权威，但取帧方式与上面一致）：
```js
$("iframe").eq(0).contents().find("iframe.ans-insertvideo-online")
video#video_html5_api
```

**【实测记录】** `knowledge` §11.10：新版任务点 iframe 是
`iframe.ans-attach-online.ans-insertvideo-online`（`ananas/modules/video/index.html`）。

### 1.2 目录（`.posCatalog`）在哪

这里有**两代布局**，别混：

| 布局 | 目录位置 | 节点结构 | 来源 |
|---|---|---|---|
| 旧版学习页 | **顶层文档** | `.posCatalog_select` → `span.posCatalog_name` | 源码实证（uxuescript `courseTree`，查询的是 `document`）|
| 新版目录页 `mooc2-ans/mycourse/stu` | iframe `#frame_content-zj` 内 | `.chapter_item#cur{chapterId}`（onclick=`toOld(...)`，小节名在 `title` 属性）| 实测记录（knowledge §11.1）|
| 新版目录页（任务/章节页签） | `studentcourse` iframe 内 | `.posCatalog_select#cur{chapterId}` > `.posCatalog_name`（onclick=`getTeacherAjax`）| 实测记录（knowledge §2 增补）|

**【源码实证】** `chaolucky18` 脚本里的取目录方式（顶层）：
```js
$('#coursetree').children("ul").children("li") … .find(".posCatalog_select:not(.firstLayer)") … .find(".posCatalog_name")[0]
```

### 1.3 弹题在哪

**【源码实证】** uxuescript `course/chapter/tasks/interactive.js`：
`handleVideo(taskDoc)` 拿到**视频 iframe 的 document**，然后在里面找 `SELECTORS.video.quizClass = ".ans-videoquiz"`，
并在 `timeline`（`.ans-timelineobjects`）里等它出现。→ **弹题与 `<video>` 同 frame**。

**【实测记录】** knowledge §11.3 给的是同一层级：
`.x-container.ans-timelineobjects > .ans-videoquiz#videoquiz-* > .tkTopic`。

### 1.4 同源/跨域

- **页面 frame 全部同源**（knowledge §2 实测原话）。这也是第三方脚本能直接 `iframeWindow.videojs(...)`、
  `parent.document.querySelector("#frame_content")` 的原因（pang-qin / cxmooc 都这么写）。
- **视频文件本身**不在页面域：播放地址由 `playlines` 下发（cxmooc 源码里按 `playlines[].label` 选「公网1」等线路，
  源码实证），实际是 CDN 地址；但那不影响 DOM 访问——`<video>` **元素**仍在同源 frame 里。
- 唯一需要 try/catch 的地方：遍历 iframe 时可能遇到 `about:blank`、广告/统计 iframe、或浏览器扩展注入的 frame。
  uxuescript 的 `frames.blankUrl: "about:blank"` 就是提醒要跳过空白帧。

### 1.5 对实现的建议

1. 找 video 必须**在每个 frame 里各找一次**，而不是只在顶层找。我们的脚本 `@match *://*.chaoxing.com/*` +
   `@run-at document-start`，理论上**会被注入进每个同源 frame**，所以"每个 frame 各自找 video"是成立的
   （我们的 `pickLocalVisibleVideo()` 就是只在 `doc` 里找，L909-920）。
2. 但**顶层必须能拿到子 frame 的状态**：现有 `relayStats()`（L958-970，子 frame `postMessage` 给 top）是正确方向。
3. 找目录要**先顶层再递归**：现有 `allDocs()`（L1337-1352，深度 ≤6）已覆盖两种布局；
   但 `catalogKey()`（L972-998）**只查 `win.top.document`**——新版目录在 iframe 里时会取空（见 §9-②）。

---

## 2. 【问题 2】播放器类型、`ended` 可靠性、`playbackRate`

### 2.1 是 video.js，外面套了学习通自己的 `ans.VideoJs`

**【源码实证 · 三处独立】**

1. `pang-qin/chaoxing-toolkit` → `学习通脚本.js` L1807-1808：
```js
await waitElementLoaded(iframeWindow, "#video_html5_api");
const player = iframeWindow.videojs("video_html5_api");
const playerButton = iframeWindow.document.querySelector(".vjs-big-play-button");
```
   后续用的是 **video.js 的 player API**：`player.paused()`、`player.currentTime()`、`player.duration()`、
   `player.on("ended", …)`、`player.pause = function(){}`（L1882-1891）。
   → 视频 iframe 里有全局 `videojs()` 函数，player 用元素 id `video_html5_api` 取。

2. `CodFrm/cxmooc-tools` → `src/mooc/chaoxing/video.ts`：
```ts
protected queryVideo(): HTMLVideoElement {
  return this.context.document.getElementById("video_html5_api");
}
let paramHook = new Hook("params2VideoOpt", (Application.GlobalContext).ans.VideoJs.prototype);
ret.plugins.timelineObjects.url = self.param.rootPath + "/richvideo/initdatawithviewer";
delete ret.plugins.studyControl;
let errorHook = new Hook("afterRender", (Application.GlobalContext).ans.videojs.ErrorDisplay.prototype);
window.frameElement.setAttribute("fastforward", "");
window.frameElement.setAttribute("switchwindow", "");
```
   → 学习通把 video.js 封装成 `window.ans.VideoJs`，并挂了自己的插件：
   `plugins.timelineObjects`（弹题/批注时间轴数据）、**`plugins.studyControl`（学习行为控制）**；
   另外通过 **`window.frameElement` 的 `fastforward` / `switchwindow` 属性** 控制"是否允许快进/切窗"。

3. `unraous/uxuescript` → `selectors.js` + `media.js` + `course/chapter/tasks/video.js`：
   `.vjs-big-play-button`、`.vjs-playback-rate`、`video { tag: "video" }`，且 `muteVideo()` / `applySpeed()` 直接操作 `HTMLVideoElement`。

**【实测记录】** knowledge §11.2（锁速课程）：
> 外层 `div.vjs-playback-rate.vjs-menu-button.vjs-menu-button-popup.vjs-control.vjs-button` 带 **`vjs-hidden`**（display:none）；
> 内层 `button[title="播放速度"]` 的 `aria-disabled` 仍为 false —— **锁的是控件可见性，不是 disabled**；
> `.vjs-playback-rate-value` 只显示「倍速」无数字；`video.playbackRate` 恒为 1。

→ 结论：**播放器 = video.js（技术栈）+ 学习通自研封装 `ans.VideoJs`（业务层）**。
业务层可以拦截/覆盖 video.js 行为（`studyControl` 插件、iframe 属性开关），
所以"直接操作 `<video>` 元素"通常能绕过 UI，但绕不过服务端（见 §3）。

### 2.2 `ended` 事件可靠吗

- **可靠（事件会触发）**：cxmooc 把 `video.addEventListener("ended")` 当作任务完成信号（源码实证，项目在用）；
  uxuescript 也靠 `videoEl.ended` 判断是否收尾（`handleInteractiveQuiz` 里的 `while (!lastQuizSubmitted && !videoEl.ended)`）。
- **但有两个已知坑**：
  1. **`ended` ≠ 平台已记录**。实测记录 knowledge §3：
     「`video.ended` ≠ 任务点已记录：出现过 ended 但完成心跳未发的"假完成"——每个任务点完成后必须核对平台侧完成标记」。
  2. **`ended` 后播放器可能自动从头重播**（同 §3：「ended 后播放器可能自动从头重播 → ended 后尽快点『下一节』」）。
- 第三方怎么防重播：cxmooc 用一个 `this.end` 标志 + `pause` 监听里
  `if (currentTime <= duration - 5) { if (!this.end) this.video.play(); }`（源码实证）。
  我们的 `endedFlag`（L941-945）+ `playing` 事件里"回到 90% 以下就清标记"是同一思路，但见 §9-⑦ 的风险说明。

### 2.3 `playbackRate` 能否直接设

- **能**：cxmooc `this.video.playbackRate = speed;`（源码实证）；
  uxuescript `applySpeed()` 更进一步，设完用 `Object.defineProperty` 把 setter 换成空函数**锁死**倍速：
```js
videoEl.playbackRate = targetRate;
Object.defineProperty(videoEl, "playbackRate", {
  get: () => targetRate, set: () => {}, configurable: true,
});
```
- **但"能设"≠"客户端有效果/服务端认"**：
  - 锁速课程里 `video.playbackRate` 恒 1（实测 §11.2）；视频播放倍速可能是**播放器用别的方式实现**的
    （例如改 `playbackRate` 后又被 `studyControl` 重置），也可能是服务端把"有效观看时长"按 1x 折算。
  - 服务端钳制 1.0–2.0（实测 §3「服务端倍速钳制 1.0~2.0」）。
- **建议**：保留"设 → 下一拍校验 → 失败就按 1x 接受"的策略（我们 L1098-1102 就是每 tick 校验），
  不要学 uxuescript 直接 `defineProperty` 锁死——锁死后我们自己也没法回退，遇到锁速课程会更难排查。

---

## 3. 【问题 3】进度上报：`multimedia/log` 的节奏与 `isdrag`

### 3.1 三阶段 `isdrag` + 60 秒心跳

**【源码实证】** `tzg-nz/ChaoxingAuto` → `chaoxing.py` L752-754（注释 + 实现）：
```
# 12、刷完一个视频：isdrag=3 起始上报 -> isdrag=2 每60秒进度上报 -> isdrag=4 结束上报（isPassed 的开关在这里）
# 服务端有异步复核，会按心跳的真实时间间隔核对观看时长，快进/秒刷的 isPassed=true 过几分钟会被回滚，
# 所以这里必须按 1 倍速真实时间挂机，节奏与原生播放器 reportTimeInterval=60 一致
```
实现（L768-790）：
```python
self.__send_log(attachment, defaults, dtoken, played_from, 3)          # 开始
...
if playing - last_reported >= report_interval:                        # report_interval = 60
    self.__send_log(attachment, defaults, dtoken, playing, 2)         # 进度
...
resp = self.__send_log(attachment, defaults, dtoken, duration, 4)     # 结束，读 isPassed
```
→ **`reportTimeInterval=60` 是原生播放器的上报间隔参数名**（作者从页面参数里读到的），60 秒一次进度上报。

**【源码实证】** `Samueli924/chaoxing` → `api/base.py`：`video_progress_log(..., _isdrag: int = 3, ...)`，
结尾调用 `_isdrag=4`（L887），与上面一致。

**【源码实证】** `CodFrm/cxmooc-tools` → `video.ts` 的"秒过"按钮直接构造 `isdrag=4` 的上报：
```js
get(this.param.reportUrl + '/' + this.param.dtoken + '?clipTime=0_' + this.param.duration + … + '&isdrag=4&enc=' + enc, …)
```
→ 又一次印证：**`isdrag=4` 就是"结束/判定通过"的那一拍**。

### 3.2 上报字段与 `enc` 签名

**【源码实证 · 三处完全一致】** `enc = md5('[clazzId][userid][jobid][objectId][playingTime*1000][d_yHJ!$pdA~5][duration*1000][clipTime]')`
（tzg `__make_enc`；Samueli `get_enc`；cxmooc `sendTimePack`）。`clipTime` 形如 `0_{duration}`。

其它关键参数（tzg L708-728）：`clazzId`、`playingTime`（秒）、`duration`、`clipTime`、`objectId`、
`otherInfo`、`courseId`、`jobid`、`userid`、`isdrag`、`view=pc`、`enc`、`rt=0.9`、`dtype=Video`、
`attDuration`、`attDurationEnc`、`videoFaceCaptureEnc`、`courseEngineInfo=false`。

**【实测记录】** knowledge §3 也给了同一路径：`GET /mooc-ans/multimedia/log/a/{cpi}/{dtoken}`，
且「请求带 enc 校验参数（md5 拼接串 + 固定 salt）」——与上面源码的 salt 一致。

→ **对我们的意义**：这块**不要碰**。我们脚本顶部注释（L32）已经写了"绝不自己伪造 multimedia/log 心跳"，
这条结论支持该决策：伪造的 enc 一旦算错，反而是"硬异常证据"。

### 3.3 脚本插暂停会不会产生"异常心跳间隔"

**分两层看：**

1. **上报时机由播放器按 `playingTime` 推进触发**（源码实证：tzg 复刻原生 60s 节奏时，触发条件是"进度差 ≥60"，
   注释写明「触发条件用【进度差】而不是真实时间差」）。→ 播放暂停时 `playingTime` 不涨，
   **下一拍只是被推迟，不会出现"间隔为 0"或"间隔翻倍"的畸形请求**，请求本身是干净的。
2. **但服务端核对的是"真实时间间隔 vs 观看时长增量"**（tzg 注释原话：「服务端有异步复核，会按心跳的真实时间间隔核对观看时长」）。
   → 如果你暂停 15 秒，墙钟走了 75 秒、`playingTime` 只走了 60 秒，
   这个比值对服务端就是"**有效观看率 80%**"。

**分析（推理链，需实测确认）**：
- 人是会暂停的，偶发暂停不会导致判负；
- 但如果**每个 60s 周期都插入一次 3–15s 暂停**，有效观看率会稳定掉到 80–95%，
  叠加平台"观看时长需 ≥ 总时长 90%"的口径（knowledge §11.1），**可能直接导致该节不判通过**；
- 因此拟人化暂停的**频率**必须低（见 §8 的判断），而且**不要**在临近 90%/99% 的关键区间插暂停。

### 3.4 一个直接关系到我们完播判定的发现

**【源码实证】** `isdrag=4` 是 isPassed 的开关（tzg 注释 + cxmooc 的秒过实现都指向它）。

→ 我们默认 `nextAtPercent = 90%` 就切下一节（README/`_draft-part1.md` 记载，v2.0 已改"完播优先"），
**在 90% 切走意味着播放器不会走到 `ended`，也就不会发 `isdrag=4`**，
这一节很可能**被判"未完成"**（或只按已上报的进度打折）。
这与实测记录里"ended 但完成心跳未发 → 假完成"是同一类风险的两面。

**建议**：把"跳转"绑定在「`ended` 已触发 + 平台完成标记出现」，
而不是「`currentTime/duration ≥ 0.9`」。若必须提前跳，至少要等**最后一次进度上报成功**之后再跳。

---

## 4. 【问题 4】失焦 / 切后台：到底监听什么

### 4.1 平台行为**分版本**，必须运行时判断

**【实测记录】** knowledge §8.5（2026-09-17，旧版播放器）：
> 页面无键盘焦点（`document.hasFocus()===false`）时播放器**主动暂停**（play 后 3ms~2.5s 即 pause，或 5~8 秒周期），
> 且保活脚本的 setInterval 被浏览器重度节流 → 纯定时器方案失效。
> **事件驱动恢复**：video 挂 `pause` 监听 → 立即重播（1.5 秒限流；ended/弹题让行）——事件监听不受节流影响，实测 ~0.2x 恢复到 2.0x。

**【实测记录】** knowledge §11.6（新版播放器，同一作者的后续实测）：
> 新版播放器**无焦点暂停行为**：`hasFocus()===false` 且 `visibilityState==='visible'` 时 1x 持续播放（旧版 §8.5 的协议不适用）；
> 但完成口径要求页面可见 → 面板仍需保持可见。

→ **两段实测明确互相区分**：旧版靠焦点（focus/blur）暂停，新版不看焦点。
代码不能只按一种行为假设。

### 4.2 第三方是怎么对付的（可抄的清单）

**【源码实证】** `unraous/uxuescript` → `injected/chaoxing/focus.js`（全文 66 行，本轮已抓）：
```js
const blockedEvents = ["blur","focusout","mouseleave","mouseout","pagehide","visibilitychange"];
// 1) 清掉 DOM0 内联监听 window.onblur / document.onvisibilitychange ...
// 2) window/document 捕获阶段 stopImmediatePropagation + stopPropagation
// 3) 劫持 EventTarget.prototype.addEventListener：这些事件类型直接不注册
// 4) 伪造 document.hidden=false、visibilityState="visible"、document.hasFocus=()=>true
```
这套做法**同时覆盖了焦点事件和可见性事件**，比只改 `visibilityState` 更彻底。

**【源码实证】** `pang-qin/chaoxing-toolkit` 反过来的证据：它在视频 iframe 里
`simulateMouseMovement()`（随机 3–8 秒动一次鼠标）、`page.mousemove` 之类的小动作——
说明作者认为"有鼠标活动"对保活/风控有用（属经验做法，非结构证据）。

### 4.3 我们现在只补了一半

我们 `patchVisibility()`（L808-818）：
```js
Object.defineProperty(doc,'hidden',{get:()=>false});
Object.defineProperty(doc,'visibilityState',{get:()=>'visible'});
Object.defineProperty(doc,'webkitHidden',{get:()=>false});
['visibilitychange','webkitvisibilitychange','pagehide'].forEach(ev => doc.addEventListener(ev, swallow, true));
```
**缺口**：没有拦 `blur` / `focusout` / `mouseleave` / `mouseout`，也没有伪造 `document.hasFocus`。
→ 若账号落在"旧版播放器"（§8.5 行为），用户切到别的窗口时播放器会主动暂停；
我们的 `autoPlay` 会在下一 tick（约 500ms–1s）把它 `play()` 回来，**能兜住但有延迟**，
而且频繁"暂停→恢复"会在上报侧留下抖动（见 §3.3）。

### 4.4 后台标签的"停摆"是另一种病

**【实测记录】** knowledge §11.7（重大）：
> 同一 IAB 会话内切换标签 → 视频标签退后台停摆：`t` 卡 0、paused 抖动，但 `readyState=4`、`error=null`、
> `visibilityState` 仍 `'visible'`——三件套全正常，**唯一可靠健康判据 = `t` 是否推进**（`hasFocus()` 不可用）。

→ 这种停摆**不是 pause 状态**，`play()` 也救不回来（渲染/解码被节流）。
脚本能做的只有：检测到"t 不推进且未 ended"时告警/尝试 `pause()→play()`，或让用户切回该标签。

### 4.5 `pause` 后能否被脚本重新 `play()`

- **能**（源码实证 + 我们自己的 mock 验证）：
  cxmooc 在 `pause` 事件里直接 `this.video.play()`（L201-207）；
  uxuescript 用 `videoEl.play()`（`video.js` 的 `.vjs-big-play-button` 只是 UI 入口）。
- 注意 video.js 层：`player.play()` 与 `video.play()` 都能起播；video.js 会监听 tech 元素事件同步状态。
  我们 `clickPlayButton()`（L948-952）先点 `.vjs-big-play-button` 是合理兜底。
- **唯一不能 play 的情况**：`ended === true`（会从头重播）。我们 L1108 `const endedNow = videoEl.ended || endedFlag;`
  已经防了这个坑（注释里也写了"真实踩过的坑"）。

---

## 5. 【问题 5】切章节：整页刷新 / iframe 内跳转 / SPA

### 5.1 三种真实入口，行为不同

| 入口 | 行为 | 来源 |
|---|---|---|
| `#prevNextFocusNext` / `#prevNextFocusPrev`（顶层） | **整页跳转**（"点击后整页跳转 → 保活脚本需重新注入"）| 实测记录（knowledge §2）|
| 点目录节点（旧版 `.posCatalog_name`） | 内容在 `#iframe` 里重新加载，顶层不刷新 | 源码实证（uxuescript `handleChapter`：`wait.iframeDoc(() => tab.click(), "#iframe")`）|
| 点目录节点（新版 `.chapter_item` / `toOld(...)`） | 同上（iframe 换载）；新版"下一节"是**页内翻页** | 实测记录（knowledge §11.1）|
| `.jb_btn.jb_btn_92.fr.fs14.nextChapter`（新版下一节按钮） | 点击切换 | 源码实证（ocsjs 打包版 `超星学习通.js` L5278）|

佐证（源码实证）：pang-qin 用轮询比对 **`iframe.contentWindow.location.href` 是否变化** 来判断"换节了"：
```js
const cardsIframe = _self.document.querySelector("#iframe");
if (iframeCom != _self1.location.href) { iframeCom = _self1.location.href; cxModel.askStore.reset(); startWork(); }
```
ocsjs 则监听 `iframe.addEventListener("load", …)` 重新扫描任务点。

→ 结论：**新版主要是"iframe 换载"，旧版的"下一节"按钮是整页跳转**。两种都要能处理。

### 5.2 `sessionStorage` 跨 frame 是否共享

- **规范层面**：`sessionStorage` 按 **tab（top-level browsing context）** 隔离，**同源的嵌套 frame 共享同一份**。
- **实测层面**：学习通页面 frame 全部同源（knowledge §2），所以共享成立。
- **因此**：我们的 `cxas_epoch`（L850 读 / L1404 写）与 `cxas_jump_guard`（L1008-1017）**在真实环境可用**，
  除非：① frame 里是 `about:blank`/`srcdoc` 且继承异常；② 页面跨到 `chaoxing.cn` 与 `chaoxing.com` 两个域
  （我们 `@match` 同时匹配两者，但 storage 按 origin 分开，会导致 epoch 不通）。
- **整页跳转后**：`sessionStorage` **保留**（同 tab 同 origin），所以旧版 `#prevNextFocusNext` 整页跳转后，
  `cxas_jump_guard` 依然能防重复跳转——这一点比 `localStorage` 更安全（不会跨标签串味）。

### 5.3 建议

1. `goNext()`（L1385-1407）点击后写 epoch 是对的；建议**再加一条**：跳转后 3s 内若 `location.href` 变（整页跳转），
   把 `navPendingUntil` 延长到 reload 完成，避免新页面一进来就被判定"没有视频"。
2. 多 frame 情况下，epoch 的**读取方**是每个 frame 自己（`checkEpoch` L1026-1043，每 tick 调），
   不需要额外广播——这点设计是对的，**但前提是 frame 同源**；若某天视频换成跨域域名，`sessionStorage` 访问会抛异常（已有 try/catch）。

---

## 6. 【问题 6】任务点"变绿"：用什么判断这一节真的完成了

| 判据 | 选择器/文本 | 适用 | 来源 |
|---|---|---|---|
| 任务点容器完成类 | `.ans-job-finished`（容器 = `.ans-attach-ct:has(.ans-job-icon)`） | 卡片内的单个任务点 | 源码实证（uxuescript `taskPoint`）|
| 目录行完成图标 | `.icon_Completed`（行内） | 新版章节树（**权威、实时**）| 实测记录（knowledge §2/§11.1）|
| 目录行**未完成**标记 | `:has(.orangeNew)` | 旧版目录 | 源码实证（uxuescript `courseTree.unfinishedSelector`）|
| 待完成任务点计数 | 行文本「N个待完成任务点」 | 只反映**视频**任务点；测验做完不会让它减少 | 实测记录（knowledge §15.7）|
| 顶层提示弹窗 | `jobFinishTip`（任务点未完成）、`jobCountDiv`（每日上限）、`popDeleShowHide`、`Marking popDiv` | 平台自己的状态提示 | 实测记录（knowledge §8）|
| 平台总数 | 「已完成任务点 X/Y」 | 验收用（测验+视频各占一半）| 实测记录（knowledge §15.7）|

**【实测记录】** 关键警告（knowledge §3）：「`video.ended` ≠ 任务点已记录……每个任务点完成后必须核对平台侧完成标记（播放器 `icon_Completed` / 目录 ✓），缺了就重播」。

→ **建议**：完播判定不要以 `ended` 为终点，改用
`ended`（或 ≥95%+最后一次上报成功）→ 等 `.ans-job-finished` / `.icon_Completed` 出现（带超时）→ 再跳。
超时则重播，而不是硬跳。

---

## 7. 我们的 jump/answer 浏览器测试与真实环境的差距清单

| # | 测试现状（mock） | 真实环境 | 影响 | 补测建议 |
|---|---|---|---|---|
| 1 | **全部在顶层文档**，无 iframe（`tests/mock/course.html`、`work.html` 都是单文档）| 三层 iframe：`#iframe` → `ans-insertvideo-online` / `work` → `#frame_content` | "脚本在所有 frame 各自运行 + 通过 postMessage 汇总"这条主链路**完全没被验证过** | 给 mock 加一层 iframe：`course.html` 内嵌 `video-frame.html`，断言子 frame 注入、`relayStats` 到顶层面板、`NEXT` 消息触发顶层 `goNext` |
| 2 | `<video id="v">` 原生元素，`src` 直链 | video.js 封装 + `ans.VideoJs` + `studyControl` 插件；元素 id 是 `video_html5_api` | 选择器可能抓不到（我们查的是 `doc.querySelectorAll('video')`，**这个恰好仍成立**）；但"点播放按钮"依赖 `.vjs-big-play-button` | mock 里给 video 套一个 `.vjs-big-play-button` 遮罩，验证"点按钮起播"分支 |
| 3 | 换节 = 同文档 `v.src=...; v.load()` | iframe 重载 / 整页跳转 → **脚本上下文重建** | 我们状态机（`videoEl`、`endedFlag`、`humanPauseUntil`）在真实换节时是"重新开始"，而不是 mock 里的"同一个实例继续" | 加"整页 reload 型换节"用例：断言重载后 `cxas_jump_guard` 生效、不会重复跳同一节 |
| 4 | 完全没有上报（mock 无 `multimedia/log`）| 60s 心跳 + `isdrag=3/2/4` + 服务端异步复核 | **"完播判定是否真的算完成"这条最重要的验收链没测**（也没法在 mock 里测）| 只能靠真实账号抽测；mock 侧至少加"ended 后 15s 内不得跳转"的时序断言（对应 `thresholdDelay`）|
| 5 | 弹题 `.ans-videoquiz` 在**顶层**，按钮是 `<button class="ans-videoquiz-submit">` | 弹题在**视频 iframe 内**，结构是 `.tkTopic` + `li.ans-videoquiz-opt input` + **`a#videoquiz-submit`** | `answer` 测试通过 ≠ 真实能答：mock 的 `.ans-videoquiz-submit` **无可靠来源**（真实 id 是 `#videoquiz-submit`，详见 `real-dom.md` §3）| mock 改成 `a#videoquiz-submit` + 加 `.tkTopic` 包裹；再补一个"答错滞留 → 重答"用例 |
| 6 | 测验页 `/work.html` 单文档，选项是真实 `input[type=radio]`，提交按钮 `.btnSubmit`，确认框 `.popup_confirm` | 若在真实环境：`.singleQuesId` + 无 input + 隐藏 `answer{qid}` + 顶层 `.popDiv.Marking` | `answer` 测试里的"提交确认弹窗被自动点掉"是**假通过**（`.popup_confirm` 无来源）| mock 改为 `.popDiv.Marking` + `a.jb_btn`，并断言"点错『取消』会失败" |
| 7 | 提交后 `location.href` 变成 `/course.html` | 真实：**不整页跳转**，内层 iframe 自己 reload 成批阅页 | `check('提交后自动回到课程页')` 这条断言在真实环境**永不成立** | 改成"提交后仍在原页 + 出现成绩文本"的断言 |
| 8 | 无锁速、无防拖拽 | 锁速课程 `playbackRate` 恒 1；`#tipDiv .toolTipBox1` 提示不可拖拽 | 我们 `maxSpeed` 逻辑、`seeking` 断言都没在"被锁"的场景下验证 | mock 加一个"每 tick 把 playbackRate 重置为 1"的播放器桩，验证我们不会死循环重设 |
| 9 | mock 视频 2 秒 | 真实单节 20–60 分钟 | 拟人化暂停、心跳、导航防重（30s/8s 窗口）在 mock 里几乎不触发 | 加"时间加速"桩：把 `duration` 伪造为 600s、`currentTime` 按 60x 推进（用 defineProperty 模拟），验证时间相关分支 |
| 10 | `sessionStorage` 只在顶层用 | 跨 frame 共享（同源） | epoch 方案**逻辑上成立但从未被 iframe 场景验证** | 在用例 #1 的 iframe mock 里断言：子 frame 能读到顶层写的 `cxas_epoch` |

---

## 8. 板块 1「拟人化随机暂停」在真实播放器上是否可行

### 8.1 结论

**可行，但只在满足 4 个前置条件时才算"安全可行"**；否则会从"拟人化"变成"降低通过率"。

### 8.2 有利证据

1. **`pause()`/`play()` 对 `<video>` 元素可靠**（源码实证 ×2 + 我们自己的 mock 验证）：
   第三方项目直接在元素上 `pause/play` 就能控制真实播放器，video.js 会同步自己的 UI 状态。
2. **新版播放器不因失焦自动暂停**（实测 §11.6）→ 我们的暂停不会被平台抢走/干扰。
3. **暂停不产生畸形上报**（分析，依据 §3.3 第 1 条）：播放器按"进度差"触发上报，暂停只是推迟下一拍。
4. 视频播完 `ended` 后我们**不会**再 play（L1105-1108 已处理），所以拟人化暂停不会把已完播的视频重播。

### 8.3 风险（按严重度）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **① 有效观看率下降**（最严重）| 墙钟时间 = 播放时间 + 暂停时间；服务端按真实时间核对（§3.1）→ 暂停越多，`playingTime/墙钟` 越低。若每 60s 停 3–15s，有效观看率掉到 80–95%，叠加"≥90%"口径可能不判通过 | 限制频率：例如**每 3–5 分钟最多一次**、每次 3–15 秒；单节暂停总时长占比 <5% |
| ② 90% 跳转 + 暂停叠加 | 我们默认 90% 跳（`nextAtPercent`），本来就可能拿不到 `isdrag=4`；再叠加暂停更容易"差一点" | 改成"播到 ended 再跳"，或至少"最后一次上报成功后跳"（§3.4）|
| ③ 旧版播放器的失焦暂停 | 用户切窗口 → 平台自己 pause，我们的拟人化暂停窗口与它撞车，恢复逻辑会打架 | 补 `blur`/`focusout` 拦截 + 伪造 `hasFocus`（uxuescript 同款，§4.2）；并保证 `humanPausedByMe` 只认自己的暂停（我们已有，L858/L882）|
| ④ 后台标签停摆 | 切到别的标签 → `t` 不推进（§4.4），此时 `paused` 可能为 false，`play()` 无效 | 检测"t 连续 3 tick 不推进"→ 告警 + `pause()→play()` 重试；不要反复 seek |

### 8.4 判定

- **推荐保留**，但把参数收紧为：`humanizePauseMin/Max` 默认 **3–15s 不变**，
  但**增加一条硬约束**：`暂停总时长 / 已播时长 ≤ 5%`，超过则本次不再触发暂停（当前代码没有这个闸门）。
- **必须同时做**（否则不如不做）：
  1. 只在"真实播放中的 `<video>`"上暂停（我们 `pickLocalVisibleVideo` 已满足）；
  2. 暂停结束恢复后**校验 `currentTime` 真的推进**，否则退化为点 `.vjs-big-play-button`；
  3. 暂停期间不触发跳转判定、不把"进度不动"当成"卡住"（现有 `navPendingUntil`/`nearEndSince` 逻辑需要复核是否会误判）；
  4. 弹题出现时立刻让位（我们 L1116-1117 已有）。

---

## 9. 如果视频在 iframe 里，现有代码哪些地方会失效

> 逐条对照 `xuexitong-assistant.user.js`（只读，未修改）。

| # | 位置 | 现状 | 真实环境下的问题 | 建议 |
|---|---|---|---|---|
| ① | 全局注入（`@match` + `@run-at document-start`）| 每个匹配 frame 都会注入 | ✅ **这条没问题**：`*://*.chaoxing.com/*` 覆盖同源 iframe，子 frame 会各自跑一份 | 保持；但要在面板上区分"顶层/子框架"（已有徽标逻辑）|
| ② | `catalogKey()` L972-998 | 只在 `win.top.document` 找目录节点 | **新版目录在 `#frame_content-zj` iframe 内时取空** → `videoKeyOf()` 退化成 `|src|dur`，换节后可能误判"还是同一个视频"，导致 `jumpGuard` 误拦或旧状态不清 | 改为遍历 `allDocs()`（已有函数）而不是只用 top |
| ③ | `pickLocalVisibleVideo()` L909-920 | 只在**本 frame** 的 `doc` 找 `video` | ✅ 设计正确（子 frame 各自找）；但**顶层**永远找不到 video，依赖 `relayStats` 汇总——若子 frame 注入失败（跨域/沙箱/管理器限制），顶层面板会一直显示"未检测到视频" | 加一条诊断：顶层在 `videoMissLogged` 时打印**递归** iframe src 列表（现在 L1062 只打印 `doc` 的直接子 iframe）|
| ④ | `patchVisibility()` L808-818 | 只屏蔽 `visibilitychange/webkitvisibilitychange/pagehide`，伪造 `hidden/visibilityState` | **旧版播放器监听 `blur`/`focusout`**（§4.1），切窗口会被平台暂停；我们只能靠下一 tick `play()` 补救 | 补 `blur/focusout/mouseleave/mouseout` 捕获阶段拦截 + `document.hasFocus=()=>true`；**注意别拦 `ended`/`pause`** |
| ⑤ | `goNext()` L1385-1407 | 点目录节点 → 写 `cxas_epoch` → 依赖 sessionStorage | ✅ 同源下成立；**整页跳转型**（`#prevNextFocusNext`）时页面重载，`videoEl`/`endedFlag` 全丢，靠 `cxas_jump_guard` 防重入 | 跳转后若检测到 `location.href` 变化，把 `navPendingUntil` 延长（避免新页一进来就判"无视频"）|
| ⑥ | `checkEpoch()` L1026-1043 | 每 tick 读 `sessionStorage.cxas_epoch` | ✅ 同源共享可用；跨域 frame 会抛异常（已 try/catch，但**不会重试**）| 保持；可加"连续 N 次读不到就退回 postMessage 广播"（`broadcast()` L1423 已存在）|
| ⑦ | `endedFlag` + `playing` 复位 L941-945 | `playing` 时若 `currentTime < 0.9*duration` 就清 `endedFlag` | **真实播放器 ended 后可能自动从头重播**（§2.2）→ 重播瞬间触发 `playing` 且 `currentTime≈0` → 我们把 `endedFlag` 清掉，于是在 `thresholdDelay`（默认 15s）窗口内"播完"这个事实被抹掉，**跳转要再等一整节时长**（不是死循环，但会让"完播→跳转"延迟一个视频长度） | `ended` 后**锁定**标记（只在 `emptied`/`loadstart` 清）；或改成"ended 后不再依赖 15s 延迟，直接等完成标记出现就跳"|
| ⑧ | `doSubmit()` / 测验提交（L1513-1540）| 用 `doc` 找 `.btnSubmit`、点确认 | 真实确认层在**顶层**文档，且题目在最内层 iframe → 若脚本跑在 work 的**内层** frame，`doc` 里没有 `.popDiv.Marking` | 提交前取 `win.top.document` 找 `.popDiv.Marking`（详见 `real-dom.md` §5）|
| ⑨ | `postNext()` L954-956 / `broadcast()` L1423-1433 | `win.top.postMessage` + 遍历 `w.frames` | ✅ 结构正确；但 `broadcast` 用 `w.frames` 递归，跨域会抛（已 catch）| 保持 |
| ⑩ | `reloadPage()` L1021-1024 | 先 `win.top.location.reload()`，失败再 postMessage | 在 iframe 里调用 `top.location.reload()` **同源可用**；跨域会抛 SecurityError（已 catch）| 保持 |

**不会失效的部分（可以放心）**：
- `doc.querySelectorAll('video')` —— 真实元素仍是 `<video>`（id `video_html5_api` 只是 id，不影响选择器）。
- `.vjs-big-play-button` —— 三处源码/实测都确认存在。
- `.ans-videoquiz` —— 确认是真实弹题容器。
- `sessionStorage` 跨 frame —— 同源下成立。
- `postMessage` 汇总 —— 方向正确。

---

## 10. 没查到 / 查到但不能依赖的

| 项 | 状态 |
|---|---|
| `isdrag=1` 的含义（推测是"拖拽"） | **未找到可靠来源**，不要在代码里依赖该值 |
| `plugins.studyControl` 的具体行为（是否=禁止拖拽/切窗） | 只知道它存在且被第三方 `delete` 掉（源码实证）；**具体规则未公开**，别假设 |
| `window.frameElement` 的 `fastforward`/`switchwindow` 属性语义 | 只知道第三方会 `setAttribute("")` 来放开（源码实证）；**是"空值=允许"还是"存在=允许"未验证** |
| 新版播放器的失焦行为是否对所有课程一致 | 只有两段实测（旧版会暂停 / 新版不暂停），**不能推广到所有账号** |
| 视频 CDN 是否可能跨域到非 chaoxing 域 | 未验证；若发生，`iframe.contentDocument` 会拿不到（我们的 try/catch 只会静默失败）|
| 真实 `reportTimeInterval` 参数的位置 | 只有 tzg 注释转述"与原生播放器 reportTimeInterval=60 一致"，**没有抓到页面参数原文** |
| 上报失败/验证码触发后的重试节奏 | 见 `knowledge` §7/§8，属协议层；浏览器路线只做"暂停+人工" |

---

## 附录：本轮新增抓取物

| 文件 | 内容 | 来源 |
|---|---|---|
| `research/gh/video/ux_video.js` | 视频任务点处理（找 `.vjs-big-play-button` + `<video>`，静音/倍速/弹题并行）| uxuescript `course/chapter/tasks/video.js` |
| `research/gh/video/ux_focus.js` | **焦点/可见性拦截清单**（blur/focusout/mouseleave/mouseout/pagehide/visibilitychange + hasFocus 伪造）| uxuescript `injected/chaoxing/focus.js` |
| `research/gh/video/ux_chapters.js` / `course__chapter.js` | 目录节点识别、完成标记判定、点节点后等 `#iframe` 加载 | uxuescript `course/chapters.js`、`course/chapter.js` |
| `research/gh/video/course__chapter__tasks__media.js` | `muteVideo()` / `applySpeed()`（defineProperty 锁倍速）| uxuescript `course/chapter/tasks/media.js` |
| `research/gh/video/tzg_chaoxing.py` | **纯协议上报实现**：isdrag=3/2/4、60s 节奏、enc 签名、服务端复核注释 | tzg-nz/ChaoxingAuto `chaoxing.py` |
| `research/gh/video/samuel_base.py` | 上报实现与 `_isdrag` 默认值（3→4）| Samueli924/chaoxing `api/base.py` |
| `research/gh/cxmooc/video.ts`（上一轮）| **播放器封装证据**：`ans.VideoJs`、`plugins.studyControl`、`#video_html5_api`、`frameElement.fastforward/switchwindow`、isdrag=4 秒过 | CodFrm/cxmooc-tools |
| `research/gh/other/pangqin.user.js`（上一轮）| `videojs("video_html5_api")` 的 player API 用法、`#iframe` 变化检测 | pang-qin/chaoxing-toolkit |

引用：
- uxuescript <https://github.com/unraous/uxuescript>
- 实测知识库 <https://github.com/sansssssss1/auto-online-course-agent-skill>（`knowledge/chaoxing.md` §2/§3/§8.5/§11.2/§11.6/§11.7）
- cxmooc-tools <https://github.com/CodFrm/cxmooc-tools>
- chaoxing-toolkit <https://github.com/pang-qin/chaoxing-toolkit>
- tzg-nz/ChaoxingAuto <https://github.com/tzg-nz/ChaoxingAuto>
- Samueli924/chaoxing <https://github.com/Samueli924/chaoxing>

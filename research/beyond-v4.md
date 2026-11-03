# beyond-v4：同赛道还能学什么、哪些必须不碰（2026-11-03）

> **前置阅读（本文不重复）**：`research/projects.md`（34 项目横评，数据截止 2026-10-28）、`research/risk-and-tech.md`（风控机制 + 五条技术路线矩阵）、`research/real-dom.md`（旧版测验 DOM / 选择器集）、`research/daily-limit.md`（日上限与分天）。
> 本文只补这些文档**没有回答**的：新泛雅 `mooc-ans` 下的章节测验/作业、音频任务点、并发与续跑，以及架构选型的代价。
> **证据分级**：A=官方/可复核一手（学校公文、官方客户端逐行移植源码）；B=项目作者一手自述或单仓库实测；C=社区说法；D=本文推测。拿不到证据一律写「未证实」，不猜。
> 采集方式：只读 GitHub README / docs / 公开 issue / release notes + web 搜索，**未下载、未执行、未安装任何第三方脚本，未访问学习通站点**。

---

## 0. 三分钟结论

| 问题 | 结论 | 最强证据（详见章节） |
|---|---|---|
| Q1 有现成实现的缺口 | ①一页多任务点 + tab 枚举 ②任务点状态用 `aria-label` 复核 ③音频「回读标记」而非「播完即算」 ④`work` 两种页面靠 `a.btnSubmit` 区分 ⑤文档慢翻的可验证口径 | §1.1–1.5 |
| Q2 必须不碰 | 绕人脸、秒刷/直接 complete、伪造接口与心跳、多端并发、拖拽补时长、批量秒交、考试自动交卷 | §2（失效证据日期集中在 2026-09 之后） |
| Q3 更稳的架构 | 没有「整体更稳」的替代。唯一有**实证收益**的是「独立进程 + CDP 接管用户真实浏览器」，且先只读；纯协议是性价比最差的一条 | §3；Mortal004 PR #10、dsh-chaoxing |

---

## 1. 我们缺的能力里，哪些有现成实现可借鉴（Q1）

本轮最大收获是一个**几乎同构的项目**：[`LeuJasYoh/dsh-chaoxing`](https://github.com/LeuJasYoh/dsh-chaoxing)（DSH 插件，Edge CDP 9222，至 2026-10-25 已实现观察/滚动/任务点复核，**刻意不提供提交**）。它的 `docs/学习通事实.md`（[commit 固定直链](https://raw.githubusercontent.com/LeuJasYoh/dsh-chaoxing/02044bc515b188769119c78dc71801db619ab8d3/docs/%E5%AD%A6%E4%B9%A0%E9%80%9A%E4%BA%8B%E5%AE%9E.md)；注意该文档已不在 `main`，读取时以这个 commit 为准）是逐条标注来源的真实页面实测集，下面 §1.1/1.3/1.4/1.5/1.7 多来自它（**B 级：单一仓库一手实测**）。

### 1.1 新泛雅 `mooc-ans` 的 frame 链，与「一页多任务点」

事实（B）：四层，且**外壳常常是空的**。

| 层 | 路径 | 关键点 |
|---|---|---|
| 主 frame | `/mycourse/studentstudy?chapterId=…&courseId=…` | 切 tab 的站点函数、确认框都在这一层 |
| 知识卡片 | `/mooc-ans/knowledge/cards?clazzid=…&knowledgeid=…&num=N` | **任务点图标在这里**；`num` 就是 tab 序号 |
| 模块外壳 | `/ananas/modules/{video,audio,work,pdf,insertbbs}/index.html` | innerText 长度 **0**，是空壳 |
| 模块内容 | `/mooc-ans/work/doHomeWorkNew`、`/mooc-ans/work/selectWorkQuestionYiPiYue`、`/mooc-ans/bbscircle/chapter` | 真正的题目/帖子在这里 |

- 坑 1：`find(modules/work) ?? find(doHomeWorkNew)` 的 `??` **永远不执行后备分支**——外壳一定存在，只是空（实测 471 字符 vs 0 字符）。
- 坑 2（对我们最关键）：**一个 tab 可以有多个任务点**。实测 `Video 3` = 视频(已完成) + 章节测验(未完成)；`Listening` = 音频(未完成) + 听力练习(未完成)；`Discussion` = 0 个。
- 切 tab 的正确做法：调站点函数 `changeDisplayContent(idx, total, chapterId, courseId, clazzid, '')`，**合成点击 `.chapter_item` 无效**；判据必须是 `#cardId === 目标 cardid`，不是「某个模块 frame 能读」（实测 ~500ms 切好、~1500ms 出现 `doHomeWorkNew`；只等「模块就绪」会读到上一个 tab 的陈旧数据，曾把测验识别成视频）。
- 侧栏 `.chapter_item` 末尾的徽章是**加载时快照**，可能滞后；权威进度是章节头「已完成任务点 X/Y」。

**对我们的判断**：`grep -E 'prev_tab|cardId|changeDisplayContent|knowledge/cards'` 在 `xuexitong-assistant.user.js` **0 命中**——我们只有 `#prevNextFocusNext` 的「下一节整页跳转」。也就是说，同一页里的第二个任务点只能靠「用户手动切过」或「平台自动切」才被发现。**这是 v4 最明确的功能缺口**，且实现路径已被上游走通，不需要逆向。

### 1.2 章节测验 / 作业：`work` 下是两种页面，提交是两步

事实（B，且与 `real-dom.md` 附录 A 的 2021–22 旧结构互证）：

| 页面 | 含义 | 判据 |
|---|---|---|
| `/mooc-ans/work/doHomeWorkNew` | 待作答 | **有 `a.btnSubmit`**，题在 `.TiMu` 里 |
| `/mooc-ans/work/selectWorkQuestionYiPiYue` | **已批阅的回顾视图** | 有「本次成绩100分」「我的答案：A」，**没有提交按钮** |

→ 只认第一种，会把「已得满分」报成「模块加载失败」。反过来，**用「有没有 `a.btnSubmit`」区分比标题/URL 可靠**：我们现在的 `detectWorkKind()` 靠标题文案 + `/work/` 路径，而测验与作业**都走 `/work/`**（`user.js` L2941-2942 自己写了这一点），因此大量落到 `unknown` → 保守不交。改成按钮判据后，`unknown` 比例能实质下降。

提交路径（B）：点 `a.btnSubmit` → 确认框弹在**主 frame**，不是 work frame：`.maskDiv#workpop` + `a#popok.jb_btn`。**用「文字含提交的按钮」匹配会命中表单底部那个提交按钮**，结果确认框一直开着、提交没发生，而代码看起来「成功」。
⚠️ 两套来源冲突，须并列兜底：`real-dom.md` 主选 `.popDiv.Marking + a.jb_btn`（2021–22 旧结构），事实集主选 `#workpop #popok`（新版实测）。建议两个都试，并用**可见性**（`display!=='none' && width>2 && height>2`）作前置——事实集实测学生页常驻一堆 `display:none` 的 `.maskDiv`，用「存在性」判断会把没弹出的东西当成弹了。

### 1.3 任务点状态：`aria-label` 应作为并行信号（这条最值钱，也最容易被改错）

- 我们的现状：`user.js` L410-421 —— `if (!ic.classList.contains('ans-job-icon-clear')) return true;`（无 `clear` 类 ⇒ 已完成）。
- 事实集（B）记录作者**两次按 class 判断翻车**：马原章节测验被判成未完成 → 重做已满分的测验；医学英语视频被判成已完成 → 整章视频被跳过。**但其映射方向与我们相反**（他按「有 `clear` = 已完成」），所以**不能据此断言我们的映射也错**——这句话必须写死，否则会带着错误结论去改代码。
- 仍然成立的结论：`[class*=ans-job-icon]` 上的 `aria-label="任务点已完成 / 任务点未完成"` 是**显式语义**，class 只是约定；两者不一致时必须以 `aria-label` 为准并打日志。反过来也不行：PDF 实测里**测试前 `aria` 是 `null`**（见 1.5），完成态靠 `ans-job-finished` 表达 → 说明 aria 不是永远存在，只能「有则优先」。
- 配套硬约束（与 `projects.md` §六.3「无人给正确率基准」同源）：**回归样本必须同时含一个「已完成」和一个「未完成」**，否则「验证通过」只是巧合。这条可以直接落到 `tests/mock/cards.html` 上。

### 1.4 音频任务点：播放器是原生 `<audio>`，播完 ≠ 完成

事实（B）：

| 项 | 结论 |
|---|---|
| 模块 | `/ananas/modules/audio/index_new.html`，**原生 `<audio>`，没有 videojs**（视频是 `/ananas/modules/video/index.html` + videojs） |
| 统一读法 | `document.querySelector('video, audio')` 对两者都成立 |
| **播完不等于完成** | 实测：音频播到 **97.6%** 正常结束，播放器状态正常，但任务点 `aria-label` **仍是「任务点未完成」** |

现成实现（B，仓库 pushed 2026-10-26）：[uxuescript v2.4.0 release notes](https://github.com/unraous/uxuescript/blob/main/.github/release-notes/v2.4.0.md) 新增「独立音频任务」——自动启动播放、沿用静音与倍速、**尝试跳转至结束前一秒**、然后「等待平台任务完成标记」；同时自承「音频跳转能否完成任务以课程实际状态为准」。也就是说：**上游自己也只敢说「等标记」，不敢说「跳完就算完」**。

另一条直接相关的证据（B，2026-11-02）：[Samueli924/chaoxing#649](https://github.com/Samueli924/chaoxing/issues/649) 实测「秒过」（`_playingTime=duration, _isdrag=4`）会让服务端返回 `isPassed: true`，但**课程音视频累计观看时长接近 0**；更糟的是脚本此后会跳过 `has_finished=True` 的章节与 `isPassed=True` 的附件，**导致这些时长事后补不回来**。同 issue 还指出：章节阅读时长（`looktime`）需要访问 `/mooc-ans/knowledge/cards` 才会累计。

→ 对我们的判断：现有 `audioTask` 只做到「自动播放 + `stats.audio` 展示」，**没有回读完成标记**。v4 应补成与视频 `waitForCompletion` 同构的三段：播完 → 回读 `aria-label`/`ans-job-finished` → 未完成则重播一次 → 仍不行则明确告警并跳过。**不要把「seek 到末尾」当完成**：那正是 #649 描述的「任务点全绿但时长不够」的成因。

### 1.5 文档 / PPT：可验证的完成口径（我们已有滚动，缺的是口径）

实测（B，2026-10-20，两次真实未完成 PDF）：[dsh-chaoxing: pdf-scroll-completion](https://github.com/LeuJasYoh/dsh-chaoxing/blob/main/docs/research/pdf-scroll-completion.md)

- 前置：外壳 `ans-attach-ct`、无 `ans-job-finished`、`aria=null`、`unfinishCount 1`。
- 动作：慢翻 **300px/步、每步停 1s，且每步补发 `scroll` 事件**（页面隐藏时原生 scroll 事件不触发，补发是必要的）；21 步约 23.6s。
- 结果：到底后父 frame 收到 `{"data":{"isFinished":1}}` → **外壳约 15s 变 `ans-job-finished`；章节目录行约再晚 4s（19s）才更新**。
- 结论要点：外壳状态与目录行是**两条时间线**。不能把「目录行没变」当动作失败，也不能把「外壳已完成」当「章节已完成」，要分别报告并允许延迟重读。
- 未验证：单步直接跳到底部是否也能完成；旧经验提示大步快跳可能不被接受，故慢翻继续作默认。

### 1.6 多课程并发 vs 断点续跑

- **并发**：事实集实测结论是「学习通禁止同账号并行，任何时刻只能一个任务在跑」（B）。平台/学校侧只有**「多终端不同地点同时登录」**的明文（A，见 `risk-and-tech.md` §2 第 7 条）。**「同一浏览器多标签并行」是否被判定为多端 → 未证实**，但收益只是墙钟时间，代价是「清空进度/挂科」，不划算。
- **续跑**：市面实现不少（yatori「断点续刷」、SuperAutoStudy「断点续学」、我们自己的 `resume_v1`）。真正值得抄的不是续跑本身，而是**范围爆炸防护**：[Samueli924/chaoxing#642](https://github.com/Samueli924/chaoxing/pull/642) 记录 `course_list` 填错时**静默回落到全部课程**——本意 1 门 100 个任务点，实际跑了 13 门 965 个任务点；作者改为 fail-fast + 显式 `all`。我们的「课程链」（刷完一门自动进下一门没进过的课）本质是同类风险。
- 相关内容：[#647](https://github.com/Samueli924/chaoxing/pull/647)（2026-10-30）把「停止任务、优雅中断、章节手动模式」做成 Web 控制台——说明**并发被社区当工程问题处理，而风控侧的风险并没有被解决**。

### 1.7 播放熔断的两个已知误判源（直接冲我们的「播放抖动自动熔断」）

事实（B）：

1. **断点续播跳变**：实测开播 ~13s 时 `currentTime` 从 `12.7s` **瞬跳 1964s**——平台取回上次观看位置后自己 seek，**不是外部拖拽**。作者原话是「我一开始把它判成异常并中断了整个刷课」。正确判据：**开播 90s 内的「向前」大跳** = 正常续播（重建基线）；**向后跳、或 90s 后才跳**才算异常。
2. **加载期误报卡住**：点播放后要**几十秒**才读出 `duration`（`readyState 0→4`），期间 `currentTime` 恒 0 且 `paused=false`。判据：**`readyState>=3 && duration>0` 之后**才做「卡住/跳变」判定。

→ 我们的熔断模块如果按「N 秒不前进」+「位置突变」判故障，这两条会各造成一类误熔断。属于**低成本、高收益**的修正。

---

## 2. 必须不碰的能力（Q2）

| 能力 | 证据与时间 | 为什么必须不碰 |
|---|---|---|
| **绕人脸 / 代过人脸** | [Mortal004#11](https://github.com/Mortal004/Xuexitong_shuake/issues/11)（用户报「2026.9.8 现在已经绕不了人脸了」，2026-09-08）；[#12](https://github.com/Mortal004/Xuexitong_shuake/issues/12)（2026-10-09 运行日志：「已检测人脸认证弹窗…**跳过人脸认证失败**…请按照要求手机扫码」）；`bclswl0827/Fuck-ChaoXing` 已 archived | 已失效，且是「避开安全保护措施」最容易被指证的点。我们 v3 已改为「检测到即暂停，不绕过」——**保持，不要为了「能过」回退** |
| **秒刷 / 直接打 complete / 暴力模式** | [Yatori 官方文档](https://yatori-dev.github.io/yatori-docs/yatori-go-console/docs.html)「暴力模式大概率打回」；[#649](https://github.com/Samueli924/chaoxing/issues/649)（2026-11-02）实测秒过 → `isPassed` 但时长≈0 且**事后补不回来**；桂林理工通报把「0 分钟完成任务点」列为异常 | 名义完成率最高、回滚与清算概率最高；副作用是**毁掉补救路径**（已完成章节被跳过） |
| **伪造接口 / 伪造心跳 / 自建签到活动** | `MuWinds/yuketangHelperBUU` 伪造雨课堂心跳秒刷；`aquamarine5/ChaoxingSignFaker` 伪造签到活动；[flutter_chaoxing](https://pub.dev/packages/flutter_chaoxing)：移动端 `view=json` 无设备指纹返回 `code=3`，`cxsign` 每安装一个 secret | 2026 年 WAF + 每装一密签名 + 设备注册把纯协议门槛抬到「必须伪造设备」；一旦被识别，请求里没有任何真人痕迹，是最直接的外挂证据 |
| **多端 / 多课程并发** | [河南城建学院通报](https://jwc.huuc.edu.cn/info/1019/5211.htm)（358 人清零）；NWNU 规则；Mortal004 教程「多端…可能清空进度甚至挂科」 | 平台规则级红线，收益仅为省墙钟时间 |
| **拖拽 / 补时长（seek、改 `currentTime`、伪造 playingTime）** | [SCUEC 通知](https://www.scuec.edu.cn/jwc/info/1003/3636.htm)「第一次观看不可拖拽」；`isdrag=1` 会把 `playingTime` 变成 `from-to` 单独上报 | 把「正常播放」变成「显式拖拽事件」，自己制造异常 |
| **批量秒交 / 集中提交** | 桂林理工「章节测验完成时间过于集中」；NWNU「做题时长不满足」 | 我们已有拟人化间隔与阈值提交，继续保持，不要为速度关掉 |
| **考试自动交卷** | `risk-and-tech.md` §7.1 第 9 条 | 收益 5–15 分，风险是清零/处分；保持「可答、不自动交」 |

---

## 3. 有没有比「油猴注入页面」更稳的架构（Q3）

矩阵口径沿用 `research/risk-and-tech.md` §4.1（完成率/隐蔽性/维护成本/风险），这里只补 **2026-11 的新证据**与代价。

| 形态 | 代表 / 新证据 | 相对收益 | 真实代价 |
|---|---|---|---|
| **a. 油猴注入（现状）** | 我们；ScriptCat 6337；GreasyFork 头部 | 同源登录态、开发与分发最便宜、用户可见可控 | 硬绑 DOM + iframe realm + 后台节流；只改客户端，**服务端时间线判定轴不变** |
| **b. 浏览器扩展** | `CodFrm/cxmooc-tools`（2,724★，2022-02 后**已归档**） | 跨 tab 编排、权限与注入比油猴稳 | 分发/审核/MV3 生命周期；**归档事实证明「扩展形态」并不带来更长寿命** |
| **c. 独立进程 + CDP 接管真实浏览器** | [Mortal004 PR#10](https://github.com/Mortal004/Xuexitong_shuake/pull/10)（2026-06-25 合入）作者原话：「**不再是开一个单独环境隔离的浏览器强行注入 cookie！这样很容易环境校验不通过弹人脸**…使用宿主 profile，直接调用浏览器本体的指纹参数和缓存 cookie，降低风控」+「先启动浏览器开启 remote-debugging-port 再由程序接管」；[dsh-chaoxing](https://github.com/LeuJasYoh/dsh-chaoxing)（Edge 9222、frame 树、隔离执行上下文、8 个**只读**工具、章节页+PDF 已实测） | 真实指纹与真实 cookie；可跨 frame 精确观察、可截图补读混淆题面；能做成「只读优先」的低风险形态 | 用户须**手动以调试端口启动**浏览器（dsh-chaoxing 要求 Edge 9222）；CDP 自身可被检测（`Runtime.enable` 泄漏，patchright 正是在补这个）；**frame 在切 tab 时整体失效**（`Page.createIsolatedWorld: No frame for given id found`），每次都要重新 `page.frames()`；且**学习时长判定轴依然不变** |
| **d. 纯协议** | flutter_chaoxing（钉死客户端 7.0.2，自警「Chaoxing rotates these periodically — re-verify before relying on them」）、Samueli924、tzg-nz | 无浏览器、可批量、字段完全可控 | 四道门：`enc`（可算）、`cxsign`（需设备注册）、滑块、WAF 指纹；秒过必回滚；版本升级即失效；行为时间线自相矛盾 |
| **e. 只读 MCP / CLI** | `Han-maker-wp/chaoxing-mcp`（11★，「AI 只做辅助，提交权永远在人」）、`DanMo661/xuexitong-cli`（18★）、dsh-chaoxing | 风险最小：只解决信息不对称，不写任何平台数据 | 不解决「完成课程」；仍要维护登录态 |

**结论（D，推测但基于上面 A/B 证据）**：不存在「整体比油猴更稳」的替代。可行的是**把判定搬到 c、把动作留在 a**——观察/回读/截图走 CDP（只读、不动进度），点击与播放留在页面内（有真实登录态与原生上报链路）。这正是 dsh-chaoxing 的取舍：8 个工具里没有一个能提交。若要做 c，**先做只读观察层**（对齐它的 `page_snapshot` / `task_points` / `task_point_check`），验证完再谈操作。

---

## 4. 给 v4 的可执行结论

### 加什么（按性价比排序）

1. **任务点状态双信号**：`aria-label` 有则优先、class 兜底、不一致打日志；测试补「已完成 / 未完成」各一样本。（§1.3）
2. **音频回读完成**：播完 → 回读标记 → 未完成重播一次 → 告警跳过；**禁止 seek 到末尾冒充完成**。（§1.4）
3. **一页多任务点 + tab 枚举**：`#prev_tab li` 取 cardid → 调 `changeDisplayContent` → 等 `#cardId` 变化。分两步走：先「枚举 + 日志」（零风险），再做自动切换。（§1.1）
4. **熔断判据修正**：90s 内向前大跳 = 续播；`readyState<3` 不判卡住。（§1.7）
5. **`work` 页类型判据换成「有没有 `a.btnSubmit`」**；确认框用 `#popok`（旧版 `.popDiv.Marking + a.jb_btn` 并列兜底）+ **可见性前置**。（§1.2）
6. **课程链加范围上限与可见计数**，防 #642 式「填错就刷全部课程」。（§1.6）

### 不加什么

- 多课程 / 多标签并发（红线，收益仅墙钟时间）
- 任何形式的 seek / `currentTime` 补进度 / 直接打 `complete`
- 绕人脸、过滑块、伪造心跳或接口、自建签到活动
- 考试自动交卷、批量秒交

### 为什么（一句话）

平台判定轴是**服务端时间线**（时长、并发、时段、完成周期），不是浏览器指纹；因此「让客户端看起来像在学习」的技巧都不改变判定，而**「让回读结果真实」**（aria/完成标记/异步延迟/不误熔断）才是既提高完成率又不制造异常的那一半。

---

## 5. 未证实 / 不要依赖

1. `aria-label` 是否在所有课程与模板上都存在 —— PDF 实测**测试前为 `null`**，只能「有则优先」。
2. 音频任务点的服务端判定字段（`dtype=Audio`？`objectId` 与视频同构？）——**未找到可核验来源**。
3. 「同账号同浏览器多标签并行」是否被平台认定为多端 —— **未证实**（学校公文只写「多终端不同地点」）。
4. `.ans-job-icon-clear` 在新旧模板的确切语义映射 —— 单一来源，且**其映射方向与本项目相反**，不可反向推断我们的实现是对或错。
5. `knowledge/cards` 的 frame 结构是否全平台一致 —— 仅一个真实账号的实测样本（B 级）。
6. 本轮**没有任何一次真实页面操作验证**：所有 DOM/行为结论来自他人实测记录与源码，不是我们自己的抓包。

## 6. 主要来源

- 页面事实集与 PDF 实测：[dsh-chaoxing](https://github.com/LeuJasYoh/dsh-chaoxing) 的 `docs/学习通事实.md`（[commit 固定直链](https://raw.githubusercontent.com/LeuJasYoh/dsh-chaoxing/02044bc515b188769119c78dc71801db619ab8d3/docs/%E5%AD%A6%E4%B9%A0%E9%80%9A%E4%BA%8B%E5%AE%9E.md)，2026-10-25 前后）与 [`docs/research/pdf-scroll-completion.md`](https://github.com/LeuJasYoh/dsh-chaoxing/blob/main/docs/research/pdf-scroll-completion.md)（2026-10-20）
- 音频任务实现：<https://github.com/unraous/uxuescript/blob/main/.github/release-notes/v2.4.0.md>（2026-10-26）
- 秒过导致时长不足 / cards 阅读时长：<https://github.com/Samueli924/chaoxing/issues/649>（2026-11-02）
- 课程范围爆炸防护：<https://github.com/Samueli924/chaoxing/pull/642>；控制台与中断：<https://github.com/Samueli924/chaoxing/pull/647>（2026-10-30）
- 绕人脸失效现场：<https://github.com/Mortal004/Xuexitong_shuake/issues/11>、<https://github.com/Mortal004/Xuexitong_shuake/issues/12>
- CDP 接管宿主浏览器的动因：<https://github.com/Mortal004/Xuexitong_shuake/pull/10>（2026-06-25）
- 平台/学校规则与处罚：SCUEC <https://www.scuec.edu.cn/jwc/info/1003/3636.htm>；河南城建 <https://jwc.huuc.edu.cn/info/1019/5211.htm>；桂林理工 <https://nnfx.glut.edu.cn/jxjy/info/1159/1064.htm>
- 官方客户端协议移植：<https://pub.dev/packages/flutter_chaoxing>；秒刷自述：<https://yatori-dev.github.io/yatori-docs/yatori-go-console/docs.html>

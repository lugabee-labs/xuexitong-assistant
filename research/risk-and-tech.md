# 超星学习通（Chaoxing / 学习通）检测机制与自动化对抗技术路线调研

**调研时间**：2026-10-28
**服务对象**：`D:\脚本项目` 浏览器用户脚本（自动播放 / 静音 / 倍速 / `Object.defineProperty` 伪造 `document.hidden` / 90% 跳节 / 视频弹题自动作答 / DeepSeek 答题）
**对照基线**：本项目 v1.5.9 代码自检见 [`research/_draft-part1.md`](./_draft-part1.md)

**证据分级**

| 级别 | 含义 |
|---|---|
| **A 确证** | 官方文件、法院案例、可复核的协议字段/源码，或我本次直接抓取并阅读到的原文 |
| **B 一手自述** | 开源项目作者在其 README/文档中的明确陈述，未经第三方复现 |
| **C 社区说法** | 论坛、社媒、问答里的个人经验，未验证，仅作线索 |
| **D 推测** | 基于技术原理的推断，本报告明确标注 |

> **一句话结论**
> 学习通风控的核心不是"浏览器指纹"，而是**服务端对学习时间线的统计一致性**：上报的 `playingTime` 序列、请求到达时间、账号并发终端、IP 与学习时段。
> 因此"伪造 `document.hidden`"只能阻止播放器自动暂停，**不能制造"有效学习"**；真正决定是否被清零的是**倍速、总完成时长、并发终端、课程完成周期**。
> 公开证据显示：**>2 倍速、秒过、多端并发会被回滚**；而 **≤2 倍速是平台官方允许的**。

---

## 0. TL;DR（给项目组的 10 条）

1. **任务点"变绿"的门槛不是 90%**。多所高校的官方学习通知写的是"**完整观看所有课程视频，系统才会判定任务点通过（变为绿色）**"，并要求"完成章节任务点 **90%** 才能参加考试"——90% 是**课程级**参加考试的门槛，不是**单个视频**变绿的门槛。[中南民族大学教务处通知](https://www.scuec.edu.cn/jwc/info/1003/3636.htm)（A）
2. **我们"90% 就跳下一节"很可能拿不到任务点**：官方客户端在"看到结尾"时才上报 `isdrag=4`（complete）事件，90% 跳转会跳过这个事件；同类脚本的达标阈值普遍是 0.98。[flutter_chaoxing 的 `ChaoxingVideoProgressType` 文档](https://pub.dev/documentation/flutter_chaoxing/latest/flutter_chaoxing/ChaoxingVideoProgressType.html)（A）+ 本项目基线（B）
3. **倍速确实"已被检测"，但有明确分界**：≤2x 是平台官方支持的功能；**"倍速过高会导致学习通已完成的任务点被清空"** 是某学习通脚本作者写进使用手册的原话。[Mortal004 使用教程 5.4](https://mortal004.github.io/xuexitong-tutorial/guide/usage.html)（B）
4. **"秒刷/暴力模式"在学习通上大概率被打回**。头部工具 Yatori 官方文档对"学习通"一行原文是："支持绕过人脸认证，**支持暴力模式（暴力模式大概率打回）**"。[Yatori 官方文档](https://yatori-dev.github.io/yatori-docs/yatori-go-console/docs.html)（B）
5. **多终端/多课程并发是明确的高危项**，不是猜测：平台规则与多所学校通报都单列"多终端不同地点同时登陆学习相同内容"；某脚本把"多端学习"标注为"**有可能清空课程进度，甚至直接挂科**"。[河南城建学院处理通知](https://jwc.huuc.edu.cn/info/1019/5211.htm)（A）+ [Mortal004 5.6](https://mortal004.github.io/xuexitong-tutorial/guide/usage.html)（B）
6. **平台有"每日视频任务点上限"**：会出现"今日视频任务点完成数已达上限"的提示，当天不再计分——这意味着"堆量猛刷"本身会被限额截断。[DaRin1403/xuexitong-autostudy README FAQ](https://github.com/DaRin1403/xuexitong-autostudy)（B）
7. **人工验证是硬门槛**：登录/长时间挂机会触发**滑块或微信扫码验证**，"任何脚本都过不了，本人扫码"；且有开发者记录"宿主机锁屏时，虚拟机里模拟鼠标过滑块老失败，不锁屏并置顶就成功"。[DaRin1403 README](https://github.com/DaRin1403/xuexitong-autostudy)（B）+ [52pojie 滑块逆向帖回帖](https://www.52pojie.cn/thread-2037138-1-1.html)（C）
8. **判定是"延迟批量清算"，不是实时**：学校文件明确"不良记录的发布需要大量数据支撑，时间会有延迟"；平台"每天对任务点完成情况进行复核"。所以"今天刷完没事"不等于安全。[西北师范大学《网络通识课学习注意事项》](https://jwc.nwnu.edu.cn/_upload/article/files/98/bd/d45ff34c44abb0a9b7f89f49a908/8ad1c439-2a77-4fec-b036-1dfeb153ca7f.docx)（B）+ SCUEC（A）
9. **真正的"100% 且低异常"只有一条路：以接近真实时长、单端、正常时段完成**。GUI/真人级自动化的隐蔽性最高但成本最高；纯协议"秒过"完成率名义最高、实际回滚率最高。
10. **法律红线不在"学生自用"，在"制作/提供/售卖"**：已有判例把"仅模拟键鼠、机器浏览刷学习时长"的辅助程序定为**提供侵入、非法控制计算机信息系统程序、工具罪**，判 3 年。见 §5。

---

## 1. 学习通的"有效学习"是怎么判定的

### 1.1 任务点、变绿与 90%

多所高校的教务通知是目前最可靠、可公开引用的规则来源（学校直接转述平台规则）。

| 结论 | 原文 | 来源 | 级别 |
|---|---|---|---|
| 视频要"完整观看"才变绿 | "请同学们**完整观看所有课程视频**，系统才会判定**任务点通过（变为绿色）**。" | [SCUEC 通知](https://www.scuec.edu.cn/jwc/info/1003/3636.htm) | A |
| 90% 是"参加考试"的课程级门槛 | "须完成章节任务点 **90%**……方可进行（考试）"；"需完成 **90%** 的章节任务点，第二天方可参与期末考试" | 同上 / [衡水学院通知](https://jwc.hsnc.edu.cn/info/1011/5980.htm) | A |
| 首次观看禁止拖拽 | "**第一次观看视频时不可拖拽进度条**" | SCUEC | A |
| 倍速有官方上限 | "根据课程不同，系统支持**最高不超过 2 倍速**的倍速播放功能" | SCUEC | A |
| 平台每天复核任务点 | "系统**每天会对任务点完成情况进行复核**。若发现刷课行为，将判定该任务点不通过，需重新自主学习。" | SCUEC | A |
| 章节测验提交后才变绿 | "章节测验任务点在**正式提交后**才会判定为通过（变为绿色）" | SCUEC | A |

**对本项目的直接含义**

- 我们脚本的 `nextAtPercent = 90%` + `thresholdDelay = 15s`（见 `_draft-part1.md` §1.2）**大概率不足以让任务点变绿**。若单个视频的判定接近"完播"，90% 会落在阈值之下；即使平台按"累计有效时长"结算，90% 也会被打折。
- 同类脚本的实际取值可作参照：ScriptCat 上的《学习通自动刷课·复习》v1.5.2 源码里 `completionThreshold: 0.98`（我本次直接下载源码核验，见 §3a）。0.98 而非 0.90，说明社区经验值更接近"完播"。
- **90% 跳转还有一个更硬的问题**：官方客户端在"看到结尾"时才发 `isdrag=4 (complete)` 事件（见 §1.2）。90% 跳节意味着这一节**永远不会发 complete**。如果服务端把 complete 当作任务点结算信号之一，我们就永远差这一步。（D，但依据是 A 级字段语义）

**未证实项（不要当结论用）**

- 单个视频"变绿"的精确百分比（80%/90%/95%/100%）平台未公开。学校通知只说"完整观看"。第三方脚本取 0.98 属于经验值。→ **D**
- "阅读/文档/PPT 任务点"的完成判定（停留时长、滚动、点击）未找到可靠公开资料。`insertlog`、`ppt`、`videoLog`、`heartbeat` 这些接口名**在本轮公开检索中没有找到可核验的原始出处**，本报告不采信。→ 未证实

### 1.2 视频进度上报接口（本轮能确证的部分）

2019 年吾爱破解的抓包分析给出了完整请求形态，2026 年的 `flutter_chaoxing` 包（对官方 Android 客户端 **7.0.2** 的反编译逐行移植）给出了字段语义与签名算法，两者互相印证。

**请求形态**（2019 年抓包原文，[52pojie](https://www.52pojie.cn/thread-975538-1-1.html)）：

```
GET /multimedia/log/a/{数字ID}/{32位token}
    ?otherInfo=nodeId_143057010
    &playingTime=329
    &duration=903
    &akid=null
    &jobid=<jobid>
    &clipTime=0_903
    &clazzId=<clazzId>
    &objectId=<objectId>
    &userid=<userid>
    &isdrag=2
    &enc=<已脱敏>
    &dtype=Video
    &view=json
```

**2026 年版本新增/变化**（`flutter_chaoxing` 的 `buildUri` 实现，A 级）：

- 多了 `rt` 参数（`_formatRt(video.rt)`，语义未公开）
- `view` 从 `json` 变为 **`pc`**，原因写在源码注释里：

> "The mobile `view=json` report path is **WAF-gated behind the native client's device fingerprint and returns `code=3` without it**; the web `view=pc` path accepts the same `enc` digest with no device context (verified live against mooc1.chaoxing.com, **2026-09-27**)."
> —— [buildUri 文档](https://pub.dev/documentation/flutter_chaoxing/latest/flutter_chaoxing/ChaoxingVideoReport/buildUri.html)

**这是一条很重要的现代风控证据**：移动端上报通道已经加了 WAF + 设备指纹，无指纹直接返回 `code=3`；Web 端 `view=pc` 仍接受同一套 `enc`。也就是说"纯协议打移动端接口"这条路在 2026 年被显著抬高。

**字段语义**（据 `flutter_chaoxing` 对 `CourseViewModel.java` / `InterfaceC19424a.java` 的引用）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `otherInfo=nodeId_<id>` | 章节知识点（node）ID | 2019 抓包 + 包文档 |
| `playingTime` | 播放位置（秒）；拖拽时变为 `from-to` | `playingTimeOf` |
| `duration` | 视频总时长（秒） | 抓包 |
| `clipTime` | 教师剪辑窗口，缺省 `0_duration` | `clipTimeOf` |
| `clazzId` | 教学班 ID | 抓包 |
| `objectId` | 任务点对象 ID（每个视频/文档一个） | 抓包 |
| `jobid` | 本次播放会话 ID | 抓包 |
| `userid` / `puid` | 用户 ID | 抓包 |
| `isdrag` | **事件类型**，见下表 | `ChaoxingVideoProgressType` |
| `dtype` | 固定 `Video` | 抓包 |
| `view` | `json`（移动，WAF 保护）/ `pc`（Web） | 包文档 |
| `enc` | MD5 校验 | 见下 |

**`isdrag` 的 5 个取值（A 级，来自官方客户端 `CommiteProgressType` 的序数）**：

| 值 | 语义 | 触发时机 |
|---|---|---|
| 0 | `playing` | 播放中的**周期性心跳** |
| 1 | `drag` | 拖动进度条之后，`playingTime` 变为 `from-to` |
| 2 | `pause` | **暂停，或播放器切到后台（backgrounded）** |
| 3 | `start` | 开始/恢复播放 |
| 4 | `complete` | **看到结尾** |

> 来源：[ChaoxingVideoProgressType](https://pub.dev/documentation/flutter_chaoxing/latest/flutter_chaoxing/ChaoxingVideoProgressType.html)。
> **注意第 2 项**：平台把"切后台"建模成一个**显式的暂停事件**上报。这正是"切屏/切后台检测"在协议层的落点，也说明"伪造 visibility"要对抗的其实是这个上报动作。

**`enc` 算法（A 级，两个独立来源一致）**：

```
enc = md5( "[" + clazzId + "][" + uid + "][" + jobid + "][" + objectId + "]"
         + "[" + playingTime秒*1000 + "][" + salt + "]"
         + "[" + duration秒*1000 + "][" + clipTime + "]" )
```

- 移动端盐值：`d_yHJ!$pdA~5`（2019 抓包与 2026 包文档一致，**七年未变**）
- **H5 播放器是另一套**：`d_yHJW$XHF_4SmmD_2M9` + `dtoken` 方案，**两套不能混用**（包文档明确警告）
- 2019 年帖子的逆向代码：`String v1_1 = com.fanzhou.d.l.b("[" + this.V + "][" + v4 + "][" + jobid + "][" + objectid + "][" + playingTime*1000 + "][" + "d_yHJ!$pdA~5" + "][" + duration*1000 + "][" + aW + "]")`，其中 `b()` 即 MD5。

**去重规则（A 级，官方客户端行为）**：官方客户端会**跳过 `(playingTime 秒数, 事件类型)` 与上一次完全相同的上报**（`CourseViewModel.java:546-550`）。这意味着"原地重复发同一个 playingTime"不会增加任何有效记录。

**签名体系（2026 年现状，A 级）**：除 `enc` 外，客户端还有三套请求签名并存——`inf_enc` 查询签名、`cxsign`/`signToken` 请求头签名（**每安装一份客户端生成一个 secret，不是硬编码常量**）、`webRequestSign`（RSA-SHA256）。UA 也有 `cryptUserAgent`（`"(schild:" + MD5(suffix+salt) + ")" + suffix`），普通 UA 会被 passport2 拒绝，浏览器 UA 会被 mobilelearn 拒绝。详见 [flutter_chaoxing README](https://pub.dev/packages/flutter_chaoxing)。

**参数结构小结**

- `clazzId` / `objectId` / `jobid` / `otherInfo(nodeId)` 四者是构造上报的核心；`clazzId`、`objectId` 等可从课程页 DOM 属性（`courseid`/`clazzid`/`personid`）与章节接口拿到，`jobid` 是播放会话级。
- URL 路径里的数字 ID 与 32 位 token 由服务端下发（`reportUrl` 原样带回），公开资料未统一命名，不建议硬编码。
- **`chapterId`**：本项目关心它，但在本轮可核验资料中，`chapterId` 更多出现在章节树/任务点接口，而不是这条 `multimedia/log` 上报里；上报侧用的是 `nodeId`。→ 谨慎：不要把 `chapterId` 当成上报必填项。

### 1.3 服务端还看什么（这决定伪造 visibility 有没有用）

从学校文件、平台规则转述与项目实践可归纳出 6 类服务端信号：

1. **上报的 `playingTime` 序列 vs `duration`**：累计有效时长不足 → 异常。
2. **请求到达时间 vs 上报的播放位置**：若 10 分钟内上报了 60 分钟的播放进度，说明是倍速或伪造。2019 年帖子下的高赞回复就是："现在超星学习通是通过 log 日志来封你号的，虽然秒视频了，但是 **post 包的时间还是会被检测出来**，我就这样被封的"（C，一手经验）。
3. **账号并发终端数**：同一账号 PC + App 同时在线 → 警告，再犯 → 不良记录。
4. **IP 与地理跨度**：短时间多地 IP、IP 黑名单。
5. **学习时段**：凌晨等异常时段。
6. **课程完成周期**：一门课几小时内完成 → 异常（"课程学习周期至少控制在一周以上"）。

> 结论：**客户端页面可见性不在上述任何一条里**。服务端拿不到 `document.hidden`，它只拿到你上报的数字与请求时间。

---

## 2. 已知的风控 / 检测手段清单

| # | 手段 | 具体表现 | 证据 | 级别 |
|---|---|---|---|---|
| 1 | **倍速检测** | >2x 或"暴力模式"→ 任务点被清空/打回 | Mortal004 5.4；Yatori 文档 | B |
| 2 | **切后台/失焦** | 播放器自动暂停，并上报 `isdrag=2 (pause, backgrounded)` | flutter_chaoxing | A |
| 3 | **拖拽检测** | 首次观看禁止拖拽；拖拽单独上报 `isdrag=1` + `from-to` | SCUEC；flutter_chaoxing | A |
| 4 | **异常时长 / 0 分钟完成** | "视频观看 0 分钟但是完成任务点" | [桂林理工大学通报](https://nnfx.glut.edu.cn/jxjy/info/1159/1064.htm) | A |
| 5 | **学习时段异常** | 凌晨学习、偏离正常作息 | [NWNU 注意事项](https://jwc.nwnu.edu.cn/_upload/article/files/98/bd/d45ff34c44abb0a9b7f89f49a908/8ad1c439-2a77-4fec-b036-1dfeb153ca7f.docx) | B |
| 6 | **完成周期过短** | "课程学习周期至少控制在一周以上" | NWNU | B |
| 7 | **多终端并发** | 同账号 PC+App 同时学同一内容；首次警告，再犯记不良 | NWNU；[广东科技学院问答](https://www.gdust.edu.cn/jwc/jiaowu/20260525/10074.html)；[河南城建](https://jwc.huuc.edu.cn/info/1019/5211.htm) | A |
| 8 | **IP 黑名单 / 跨度** | "提交章节测验 IP 地址黑名单"；"IP 地址跨度大" | NWNU；桂林理工 | A/B |
| 9 | **答题时长过短 / 提交过于集中** | "做题时长不满足"；"章节测验完成时间过于集中" | 桂林理工；NWNU | A |
| 10 | **每日任务点上限** | 提示"今日视频任务点完成数已达上限"，当天不计分 | DaRin1403 FAQ | B |
| 11 | **滑块 / 微信扫码人机验证** | 登录滑块；长时间挂机弹人机验证；微信扫码验证"任何脚本都过不了" | 52pojie 滑块帖；Autovisor 已知问题；DaRin FAQ | A/B |
| 12 | **WAF + 设备指纹** | 移动端 `view=json` 无指纹返回 `code=3`；UA 需 `cryptUserAgent` | flutter_chaoxing | A |
| 13 | **签名/加密** | `inf_enc`、`cxsign`（每安装 secret）、RSA `webRequestSign`、`enc` 盐 | flutter_chaoxing；52pojie | A |
| 14 | **字体反爬** | 章节测验题目用自定义字体打乱字形 | DaRin1403；[tzg-nz/ChaoxingAuto](https://github.com/tzg-nz/ChaoxingAuto) | B |
| 15 | **不良记录累计→黑名单** | "6 个月内不累计，超过 2 次列入黑名单"；"不良记录无法消除" | NWNU | B |
| 16 | **延迟批量清算** | "需要大量数据支撑，时间会有延迟"；"每天复核" | NWNU；SCUEC | A/B |
| 17 | **虚拟机/多开识别** | "学习通可能会检测虚拟机安卓版本" | [油猴中文网帖](https://bbs.tampermonkey.net.cn/thread-9204-1-1.html) | C |
| 18 | **媒体嗅探插件识别** | 360/搜狗等内置媒体抓取插件"容易被系统识别为外挂脚本" | NWNU | B |

### 2.1 三个必须点名的"已生效"证据

**(1) 倍速：已被检测，但阈值在 2x**

- 平台官方允许 ≤2x（SCUEC，A）。
- 头部学习通脚本使用手册原文："**建议设置为 2 倍速，否则倍速过高，有可能会导致学习通已完成的任务点被清空**"（[Mortal004 5.4](https://mortal004.github.io/xuexitong-tutorial/guide/usage.html)，B）。
- Yatori 对学习通："支持暴力模式（**暴力模式大概率打回**）"（[官方文档](https://yatori-dev.github.io/yatori-docs/yatori-go-console/docs.html)，B）。
- 某学习通脚本 FAQ 直接写"视频倍速：默认 2（上限 2）；1 = 原速最稳，**2 = 检测风险最高**，自行权衡"（[DaRin1403](https://github.com/DaRin1403/xuexitong-autostudy)，B）。

→ **判定：`playbackRate` 本身没有被前端拦截，但"相对真实时长的偏离"在服务端结算时被利用。2x 是官方白名单内的极限，>2x 进入高回滚区。**

**(2) 秒刷：大概率打回**

- Yatori 文档（B）。
- 桂林理工："视频观看 0 分钟但是完成任务点"被列为异常（A）。
- 2019 年帖子回复："秒视频会被封的"（C）。

**(3) 多端并发：明确的规则级红线**

- 平台规则转述把"多终端同时登陆观看课程视频"列为不良记录第 5 条（NWNU，B）。
- 学校通报把"多终端不同地点同时登陆学习相同内容"列为违规情形（河南城建，A）。
- 脚本作者把"多端学习"标注为"有可能清空课程进度，甚至直接挂科"（Mortal004，B）。

---

## 3. 现有对抗技术路线对比

> 说明：GitHub 在本机网络环境下无法直连，下列 GitHub 项目的信息来自**搜索引擎索引 + 姊妹任务已抓取的 README 原文**（存于 `research/readmes/` 与 `research/issues/`）。链接本身均来自公开索引，可按需复核。

### 3.a 用户脚本 / 浏览器扩展注入（Tampermonkey / ScriptCat）

**代表项目**

| 项目 | 链接 | 说明 |
|---|---|---|
| 学习通自动刷课·复习（ScriptCat 6337） | [scriptcat.org/…/6337](https://scriptcat.org/zh-CN/script-show-page/6337) | 4.4K 安装；我本次下载了其 `v1.5.2` 源码逐行核验 |
| NoStopVideo | [github.com/BlairCode/NoStopVideo](https://github.com/BlairCode/NoStopVideo) | 防"鼠标移出窗口暂停"，专为学习通等 |
| course-helper | [github.com/Minnjee/course-helper](https://github.com/Minnjee/course-helper) | 倍速/记忆位置/章节跳转，"不刷时长不刷题" |
| chaoxing-auto-study | [github.com/Fanxiaoyao66/chaoxing-auto-study](https://github.com/Fanxiaoyao66/chaoxing-auto-study) | 自动答视频弹题、播完跳节、过防挂机弹窗 |
| xuexitong-autostudy | [github.com/DaRin1403/xuexitong-autostudy](https://github.com/DaRin1403/xuexitong-autostudy) | 内置"拟人化防检测"（原速/随机延迟/故意答错/每日上限） |
| chaoxing-toolkit | [github.com/pang-qin/chaoxing-toolkit](https://github.com/pang-qin/chaoxing-toolkit) | 任务点跳转 + 题库 + DeepSeek |
| dsh-cx-learn | [github.com/forgotfish/dsh-cx-learn](https://github.com/forgotfish/dsh-cx-learn) | **与本项目形态最接近**：DSH 插件、AI/人工答题、可选浏览器内核与 LLM |
| 学习通全能助手（Firefox 扩展） | [addons.mozilla.org](https://addons.mozilla.org/zh-CN/firefox/addon/%e5%ad%a6%e4%b9%a0%e9%80%9a%e5%85%a8%e8%83%bd%e5%8a%a9%e6%89%8b/) | 扩展形态 |

**原理（以 ScriptCat 6337 源码为样本，我本次实读）**

```js
// 1) 页面级伪造可见性
Object.defineProperty(doc, 'hidden', { get: () => false })
Object.defineProperty(doc, 'visibilityState', { get: () => 'visible' })
// 2) 捕获阶段吞掉事件
win.addEventListener('blur', e => e.stopImmediatePropagation(), true)
doc.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true)
// 3) 直接改播放参数
v.muted = true; v.playbackRate = CONFIG.playbackRate
// 4) 播放器暂停就续播
if (v.paused && v.duration > 0 && v.currentTime < v.duration - 0.5) v.play()
// 5) 进度达标跳节
completionThreshold: 0.98
```

它还做了两件很关键的事（**我们的脚本应当对齐**）：
- 播放器在 **iframe** 里：`document.getElementById('iframe').contentDocument`，视频选择器是 `video#video_html5_api`（即 **Video.js** 播放器），因此**顶层 `defineProperty` 不够，必须进入 iframe 的 realm 再覆写一次**；脚本对 `frame.contentWindow` 单独挂 `blur` 监听。
- 申请 `navigator.wakeLock.request('screen')` 防息屏，并在 `visibilitychange`/`focus` 时调用 `recoverVideos()` 恢复播放。

**优点**：同源、有真实登录态与播放器上下文；能点弹题、能按目录跳节；开发与分发成本最低；用户可见可控。
**缺点**：
- 只改客户端，**不改服务端看到的时间线**；时长/倍速/并发照样被抓。
- 强依赖 DOM：`.ans-videoquiz`、`.chapter_item`、`video#video_html5_api` 一改版就大面积失效（本项目基线已把"选择器全硬编码"列为缺口）。
- 浏览器后台节流、iframe realm、CSP 都可能让注入失效。

### 3.b Selenium / Playwright / Puppeteer + 反检测浏览器

**代表项目**

| 项目 | 链接 | 技术栈 | 备注 |
|---|---|---|---|
| Mortal004/Xuexitong_shuake | [github.com/Mortal004/Xuexitong_shuake](https://github.com/Mortal004/Xuexitong_shuake) | Python + Selenium | 最高 16 倍速、跳人脸、多端、DeepSeek |
| Yatori (yatori-go-console) | [github.com/yatori-dev/yatori-go-console](https://github.com/yatori-dev/yatori-go-console) | Go | 多平台；学习通支持"暴力模式（大概率打回）" |
| Autovisor | [github.com/CXRunfree/Autovisor](https://github.com/CXRunfree/Autovisor) | Python + Playwright | 自动过登录滑块、隐藏窗口后台刷课 |
| SuperAutoStudy | [github.com/Dainoar/SuperAutoStudy](https://github.com/Dainoar/SuperAutoStudy) | Spring Boot | "基于官方 API、模拟真实用户、规避基础检测" |
| chaoxing-toolkit | [github.com/pang-qin/chaoxing-toolkit](https://github.com/pang-qin/chaoxing-toolkit) | Web + 脚本 | 题库 + LLM |
| undetected-chromedriver | [github.com/ultrafunkamsterdam/undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver) | Python | 经典反检测驱动 |
| patchright | [github.com/Kaliiiiiiiiii-Vinyzu/patchright-python](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python) / [PyPI](https://pypi.org/project/patchright/) | Python | Playwright 的"去特征"分支 |

**原理**：真实浏览器 + 驱动控制，页面 JS 与登录态都是真的；通过 UC/patchright 消除 `navigator.webdriver`、CDP 泄漏、启动参数特征。

**patchright 具体补了什么（A 级，官方 README）**：
- `Runtime.enable` 泄漏：改用隔离 ExecutionContext 执行 JS，不触发 `Runtime.enable`；
- `Console.enable` 泄漏：直接禁用 Console API；
- 命令参数泄漏：加 `--disable-blink-features=AutomationControlled`、去 `--enable-automation` 等；
- 自称通过 CreepJS / Cloudflare / Kasada / Akamai / DataDome / Fingerprint.com 等检测（**这是通用 bot 检测，不等于能过学习通的行为风控**）。

**优点**：可精确控制节奏（随机暂停、随机时长）、可多账号、可截图/OCR、可跑无头服务器。
**缺点**：
- 驱动/浏览器版本地狱（Mortal004 专门写了"驱动安装"一章）；
- **反检测解决的是"你是不是机器人浏览器"，不解决"你的学习时长是不是假的"**——后者才是学习通的判定轴；
- 资源占用高；多账号并发反而撞"多端"红线。

### 3.c CDP 直连 / 协议层伪造

**代表项目**

| 项目 | 链接 | 说明 |
|---|---|---|
| DrissionPage | [drissionpage.cn](https://drissionpage.cn/) + [52pojie 实战帖](https://www.52pojie.cn/forum.php?mod=viewthread&tid=1936866) | 国内最常用的 CDP 封装；帖子里用它模拟登录学习通、抓 `courseid/clazzid/personid` |
| patchright（CDP 补丁） | [CDP-Patches](https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches) | 针对 CDP 自身泄漏的补丁集 |
| 青龙面板 + 脚本 | 评论区提及（C） | 定时任务化、批量跑 |

**原理**：不通过 WebDriver，而是直接说 CDP（`Page.navigate`、`Runtime.evaluate`、`Network.*`），在真实 Chromium 里注入 JS、改请求、读响应。

**优点**：真实内核 + 极细粒度控制；可拦截/改写上报请求；比 Selenium 更隐蔽（无 webdriver 标志）。
**缺点**：
- CDP 自身有指纹：`Runtime.enable` 会让页面能检测到调试器；`Console.enable` 同理（patchright 正是补这个）；
- 仍需浏览器与登录态，工程复杂度高；
- 对"学习时长"这条判定轴依然无解。

> 本项目若要"协议层伪造"，正确的参考不是 CDP，而是 §3f 的纯协议路线；CDP 更像是"带浏览器的半协议"。

### 3.d 移动端自动化（Auto.js / AutoX.js / Appium / 无障碍）

**代表项目 / 文档**

| 项目 | 链接 | 说明 |
|---|---|---|
| AutoX.js | [github.com/kkevsekk1/AutoX](https://github.com/kkevsekk1/AutoX) / [文档](https://v7.autoxjs.dayudada.com/docs/rhino/base/widgetsBasedAutomation/) | 安卓无障碍自动化，基于控件树 |
| Appium | [appium.io](https://appium.io/) | 跨平台移动自动化 |
| 社区实践 | [油猴中文网：如何解决学习通的切屏检测？](https://bbs.tampermonkey.net.cn/thread-9204-1-1.html) | 虚拟机/云手机方案，明确说"不是脚本的方法" |

**原理**：在真机/虚拟机/云手机里装学习通 App，用无障碍服务读控件、点击；或用 Appium 走 WebDriver 协议。

**优点**：App 端风控通常比 Web 松（社区普遍说法，C）；无浏览器指纹；能覆盖部分 Web 端没有的任务。
**缺点**：
- 页面结构差异大，弹题/文档/PPT 难覆盖；
- 虚拟机/多开/云手机本身是被点名的异常特征（NWNU 明确说代刷商家"使用安卓/苹果虚拟机批量登录"；油猴帖说"可能检测虚拟机安卓版本"）；
- 无障碍服务权限敏感，易被 App 检测；
- 多开=多端并发，直接踩红线。

### 3.e Computer-use / GUI Agent（截图 + VLM 点击）

**代表项目 / 产品**

| 项目 | 链接 | 说明 |
|---|---|---|
| UI-TARS（字节） | [github.com/bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) / [seed-tars.com](https://seed-tars.com/1.5/) | 原生 GUI agent 模型 + 桌面端 |
| Claude Computer Use | [code.claude.com/docs/en/computer-use](https://code.claude.com/docs/en/computer-use) / [platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | 截图→坐标点击的官方能力 |
| TRAE SOLO | [智东西报道](https://www.zhidx.com/p/555389.html) / [雷峰网](https://m.leiphone.com/category/industrynews/HlSXWFj00fGo38wZ.html) | 字节的自主 Agent 产品（桌面/网页/移动三端） |

**原理**：不注入页面、不改协议，直接"看屏幕→点鼠标/点触屏"，输入事件与真人同源。

**优点**：
- **隐蔽性最高**：没有 `webdriver`、没有脚本注入、没有异常请求；浏览器看到的是真实用户输入；
- 天然按真实时间推进（1x），恰好符合"课程周期"要求；
- 跨 Web/App，不依赖 DOM 选择器。

**缺点**：
- 慢（实时 1x）、贵（每步一次 VLM 推理）、长任务误差累积；
- 对"看完 2 小时视频"这种任务，agent 大部分时间在空转，性价比极低；
- 仍需人工登录/过验证码；窗口失焦/锁屏时同样会失败（与 §2 第 11 条同源）。

> 判断：GUI agent 是**"隐蔽性最优、经济性最差"**的路线。它适合"考试/签到"这类短时高风险动作，不适合"刷完一门课"。

### 3.f 纯协议模拟（HTTP 层直接打接口，不开浏览器）

**代表项目**

| 项目 | 链接 | 说明 |
|---|---|---|
| flutter_chaoxing | [pub.dev/packages/flutter_chaoxing](https://pub.dev/packages/flutter_chaoxing) | 对官方 Android 7.0.2 的**逐行移植**，含 `enc`、`cxsign`、设备注册、滑块求解器 |
| CxKitty | [github.com/lsicdl2d/CxKitty](https://github.com/lsicdl2d/CxKitty) | "视频文档观看、模拟答题，无需浏览器、无需油猴" |
| xxtkitty | （链接含第三方个人信息，已隐去） | 同类，批量选课 |
| fakechaoxing | [github.com/jiangyei/fakechaoxing](https://github.com/jiangyei/fakechaoxing) | 2019 年最早的 Python 协议刷课 |
| chaoxing（Samueli924） | [github.com/Samueli924/chaoxing](https://github.com/Samueli924/chaoxing) | 命令行版任务点，`video-mode: 0 立即完成 / 1 等时长刷取` |
| yatori-go-core | [github.com/yatori-dev/yatori-go-core](https://github.com/yatori-dev/yatori-go-core) | Go 协议核心 |

**原理**：登录拿 Cookie/SSO → 拉章节树 → 构造 `multimedia/log` 请求（自己算 `enc`）→ 按需伪造 `playingTime` 序列。

**优点**：无浏览器、可批量、可精确控制每个字段；理论上"完成率"最高。
**缺点（2026 年尤其明显）**：
- **四道门**：`enc`（可算）、`inf_enc`/`cxsign`（每安装 secret，需设备注册）、滑块（需 CV 求解）、WAF 设备指纹（`view=json` 直接 `code=3`）；
- **"秒过"必被回滚**：Yatori 自己承认"暴力模式大概率打回"；
- **一旦被识别，是最直接的外挂证据**：请求里没有任何真人痕迹，且时间线自相矛盾；
- 维护成本最高：客户端一升级（7.0.2 → 新版）签名/字段就可能变，`flutter_chaoxing` 自己都写"Endpoints and constants are pinned to client 7.0.2. Chaoxing rotates these periodically — re-verify against a current capture before relying on them."

> 一个有意思的折中：`Samueli924/chaoxing` 提供 `video-mode: 1 等时长刷取`——**用协议但按真实时长发心跳**。这是"协议路线里唯一可能不被回滚"的做法，代价是失去了"快"的意义。

---

## 4. "效果更好"的判据

### 4.1 技术路线能力矩阵

> 评分口径：**完成率**=能否让一门课的任务点真正变绿（含非视频任务点）；**隐蔽性**=行为/时间线像真人的程度，不是"浏览器指纹"；**维护成本**=平台改版后的适配工作量；**风险**=被清空进度/记不良/处分的概率；**需登录态**=是否必须拿到用户 Cookie/账号。

| 路线 | 完成率 | 隐蔽性 | 维护成本 | 封号/清零风险 | 需登录态 | 一句话 |
|---|---|---|---|---|---|---|
| **a. 用户脚本/扩展** | 中高（视频强，非视频弱） | **中低**（同源但行为机械） | **低** | **中高**（看倍速/并发） | 是（Cookie） | 性价比最高，但天花板就是"客户端伪装" |
| **b. Selenium/Playwright + UC/patchright** | 高 | 中（指纹干净，节奏仍机械） | 高（驱动/版本/DOM） | 中 | 是（可密码登录） | 反检测解决"浏览器像不像人"，不解决"时长像不像人" |
| **c. CDP 直连** | 高 | 中高（真实内核） | 高 | 中 | 是 | 工程最强，收益主要在网络层可控 |
| **d. 移动端（AutoX/Appium）** | 中（页面差异大） | 中（真机但无障碍/VM 特征） | 高 | **中高**（多开=多端） | 是（App 登录） | 覆盖 App 专属任务，但多开即红线 |
| **e. GUI Agent（截图+VLM）** | 中（慢、易错） | **最高**（真人级输入） | 中（工程）/极高（成本） | **低** | 是（人工登录后接管） | 最像人，也最慢最贵 |
| **f. 纯协议** | **名义最高**（可伪造任意进度） | **最低**（零真人痕迹） | **极高**（签名/滑块/WAF） | **最高**（秒过必回滚） | 是（Cookie/SSO/设备身份） | 理论完成率 100%，实际回滚率也最高 |

**关键洞察**：学习通的风控轴是**行为时间线**，不是**浏览器指纹**。所以：
- 在 b/c 上堆 stealth（patchright、UC）**边际收益很低**；
- 在 a 上堆"反暂停"（visibility 伪造）**边际收益也很低**；
- 真正有效的是 **e（真人级、真实时长）** 或 **a/b 的"1x–2x + 单端 + 正常时段 + 多天完成"纪律**。

### 4.2 一手经验与数据（都标明来源性质）

| 观察 | 来源 | 性质 |
|---|---|---|
| "暴力模式大概率打回"（学习通） | Yatori 官方文档 | B，项目自述 |
| "倍速过高会导致已完成的任务点被清空" | Mortal004 使用教程 | B，项目自述 |
| "多端学习……有可能清空课程进度，甚至直接挂科" | Mortal004 | B |
| "今日视频任务点完成数已达上限"（平台每日限制） | DaRin1403 FAQ | B |
| "微信扫码验证……任何脚本都过不了，本人扫码" | DaRin1403 FAQ | B |
| "长时间挂机有概率弹出人机验证，程序检测到后会暂停操作" | Autovisor 已知问题 | B（智慧树项目，机制可类比） |
| "最小化会让浏览器暂停渲染，进度不增加" | Autovisor FAQ | B（智慧树；Chromium 通用行为） |
| "宿主机锁屏时，虚拟机模拟鼠标过滑块老失败；不锁屏并置顶就成功" | 52pojie 滑块帖回帖 | C，一手经验 |
| "post 包的时间还是会被检测出来，我就这样被封的" | 52pojie 2019 帖回帖 | C |
| "自动答题会被检测并踢出" | [ocsjs issue #354](https://github.com/ocsjs/ocsjs/issues/354) | C（智慧树平台） |
| 358 名学生因刷课被"学习记录清零 + 期末总评记零分" | 河南城建学院教务处 | A |
| 2000+ 条异常数据被平台筛查清除 | 桂林理工大学通报 | A |
| 学习进度被"退回"，原因是"系统检测到学习数据异常（刷课软件、多终端登录）" | 广东科技学院问答 | A |

### 4.3 "100% 任务点"到底谁能做到

| 路线 | 名义 100% | 实际稳定 100% | 原因 |
|---|---|---|---|
| 纯协议秒刷 | 能 | **不能** | 回滚；且非视频任务点难覆盖 |
| 纯协议等时长 | 能 | 较可能 | 时间线自洽，但维护成本极高 |
| 用户脚本 2x | 视频能 | 部分能 | 非视频任务点、弹题、每日上限、倍速风险 |
| 用户脚本 1x | 视频能 | 较可能 | 慢，但最接近合规 |
| Selenium 1–2x | 能 | 较可能 | 同上，另加驱动稳定性 |
| 移动端 | 视课程 | 不稳定 | 覆盖面与多开风险 |
| **GUI Agent 1x** | 能 | **最可能** | 真人级输入 + 真实时长，代价是时间与成本 |

**结论**：不存在"又快又稳 100%"的路线。**"100% 完成"与"不被判异常"是同一约束的两面：完成得越快，越异常。** 唯一同时满足两者的，是"以接近真实时长完成"。

---

## 5. 合规与法律风险

### 5.1 部门规章与平台义务

**《教育部等五部门关于加强普通高等学校在线开放课程教学管理的若干意见》（教高〔2022〕1 号）** —— [中国政府网原文](https://www.gov.cn/zhengce/zhengceku/2022-04/01/content_5682923.htm)（A）

> 注：桂林理工通报中引作"教高【2022】16 号"，国务院文件库实际文号为 **教高〔2022〕1 号**，以 gov.cn 为准。

关键条款：

- 第 9 条：**"严禁通过非法软件或委托第三方提供的人工或技术服务等方式获取学习记录和考试成绩的'刷课''替课''刷考''替考'行为"**。
- 第 10 条：违规者"**取消课程成绩**，视情节给予警告、严重警告、记过、留校察看、**开除学籍**等相应处分，并**记入学生档案**"；构成违法的追究法律责任。
- 第 13 条：平台要"充分运用人工智能、大数据、区块链……对身份认证、课程内容、讨论记录、**学习数据**实施监控，有效识别'刷课'……"。
- 第 16 条：教育部委托第三方建"高校在线开放课程教学管理与服务平台"，平台须提供**学习行为数据**，用于大数据监测。
- 第 19–21 条：网信处置"刷课"APP、电信处置网站、**公安打击利用黑客手段提供有偿"刷课"服务**。

→ 这解释了为什么学习通要做"每天复核 + 不良记录 + 通报学校"：**它有法定的监控与通报义务**。

### 5.2 学校处罚先例（公开可查）

| 学校 | 时间 | 处理 | 来源 |
|---|---|---|---|
| 河南城建学院 | 2025-06 | 358 名学生"学习记录清零 + 期末总评记零分"，附违规名单 xlsx | [通知](https://jwc.huuc.edu.cn/info/1019/5211.htm) |
| 桂林理工大学 | 2022-05 | 平台筛查出 2000+ 条异常数据，"对通过刷课获取的学习记录进行了清除" | [通报](https://nnfx.glut.edu.cn/jxjy/info/1159/1064.htm) |
| 广东科技学院 | 2026-05 | 学习进度被"退回"，"被退回的进度无法调整，只能重新正常学习" | [问答](https://www.gdust.edu.cn/jwc/jiaowu/20260525/10074.html) |
| 广东第二师范学院 | — | 重置"存在不良学习记录"学生的课程学习进度 | [通知 PDF](https://www.gdei.edu.cn/_upload/article/files/15/f1/dcacbd8340d3ab1955bf711e0125/bb806a21-6dac-4946-b316-a7c530739045.pdf) |
| 广东石油化工学院 | — | 将"委托他人或利用第三方软件完成课程任务点""利用平台技术漏洞快速完成任务点""安装或使用刷课外挂"列为不良作弊 | [通知](https://jwb.gdupt.edu.cn/info/1053/10772.htm) |

**共性**：处罚不是"封号"，而是**清零学习记录 / 退回进度 / 记零分 / 记入档案**——这比封号更疼，且**不可申诉**（"被退回的进度无法调整"）。

### 5.3 刑法边界（这是本项目最需要读的部分）

**（1）提供侵入、非法控制计算机信息系统程序、工具罪（刑法第 285 条第 3 款）**

判例：刘健案，一审（2019）苏 0623 刑初 535 号，二审（2020）苏 06 刑终 333 号。被告人编写 16 个"学习平台辅助程序"（法宣在线、江西/青海/广西/河北/新疆干部网络学院等），功能是"**自动刷机获取积分、学习时长和自动答题**"，其中 15 个"**只有模拟键鼠行为，以机器方式浏览文章、观看视频以获取学习平台积分**"。法院认定构成**提供侵入、非法控制计算机信息系统程序、工具罪**，判处**有期徒刑 3 年、罚金 30 万元**，追缴违法所得 70 余万元。

裁判要旨原文（[人民司法案例转载](http://bjjbls.com/m/NewsDetail.aspx?Id=5654)，A）：

> "学习平台辅助程序以**机器浏览方式非法访问学习平台**，并利用该访问**改变学习平台内原有数据**，侵犯他人计算机信息系统的可信性和预期功能，与专门用于侵入、非法控制计算机信息系统的程序具有相当性。"

**这条对我们极其重要**：即使程序**只是模拟鼠标键盘、不做协议破解**，只要它是"为他人提供、用于改变平台学习数据"，就可能落进 285 条第 3 款。区分点不在"技术多高级"，而在**是否制作/提供/销售给他人**。

**（2）非法控制计算机信息系统罪（刑法第 285 条第 2 款）**

全国首例"付费刷课"案：辽宁朝阳公安 2020 年以"非法控制计算机系统罪"抓获"97 学习网""娜娜""课易通"等 5 家平台 **57 人**；仅 2019–2020 年，购买刷课服务的学生超 **790 万人**、刷课 **7900 万科次**；主犯于某松 2020 年牟利 690 余万元，还"入侵老师账号给学生改分"。[中国长安网/半月谈](http://chinapeace.gov.cn/chinapeace/c100042/2021-09/13/content_12535955.shtml)（A）

**（3）破坏计算机信息系统罪（刑法第 286 条）**

适用于"对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行"或"对数据/应用程序进行删除、修改、增加"且**后果严重**的情形。单纯"刷自己的课时"通常不落入 286 条（没有破坏系统功能），但**改分、删记录、注入数据库、攻击平台**会。

**（4）分层结论**

| 行为 | 风险等级 | 依据 |
|---|---|---|
| 自己写、自己用、不传播 | 校纪风险（清零/处分），刑事风险低 | 教高〔2022〕1 号第 10 条 |
| 在 GitHub 开源 | 校纪风险 + 被平台/学校追溯的风险；若被认定"提供工具"且有他人使用，存在刑事风险敞口 | 刘健案逻辑 |
| 售卖 / 代刷 / 收账号 | **高**：285 条第 3 款/第 2 款 | 刘健案、朝阳案 |
| 改分 / 入侵 / 删数据 | **极高**：285 条第 2 款、286 条 | 朝阳案（入侵教师账号改分） |

> 免责声明：以上为公开资料梳理，不构成法律意见。

### 5.4 学术诚信与个人信息

- 学生通常已签署"在线学习诚信承诺书"（教高〔2022〕1 号第 8 条），使用脚本可能直接违反承诺书。
- 代刷需要交出**账号密码**；平台账号往往绑定手机号、通讯录、校园身份。NWNU 文件明确提示"学习通中绑定的通讯录、聊天记录、钱包账户等敏感信息也会泄露"。这触及《个人信息保护法》。
- 本项目会把题目发给 DeepSeek：**题干可能包含课程内容/教师原创题**，属于向第三方提供数据，需在 UI 明示。

---

## 6. 对本项目伪造点的逐项评估（重点）

> 基线：v1.5.9，`nextAtPercent=90%`、`thresholdDelay=15s`、`Object.defineProperty(document,'hidden'/'visibilityState')`、捕获阶段 `stopImmediatePropagation`、跨 iframe 收集 `.chapter_item`、`.ans-videoquiz` 弹题、DeepSeek 四级降级。

| # | 伪造点/策略 | 它实际改变了什么 | 是否有效 | 证据 | 风险 |
|---|---|---|---|---|---|
| 1 | `Object.defineProperty(document,'hidden'→false)` | 只改变**页面 JS 读到的值**；服务端看不到 | **部分有效**：能阻止"读到 hidden 就暂停"的播放器逻辑 | 同类脚本普遍如此（ScriptCat 6337 源码） | 可被 `getOwnPropertyDescriptor(...).get.toString()` 检测（D）；iframe realm 需单独覆写 |
| 2 | `visibilityState='visible'` | 同上 | 同上 | 同上 | 同上 |
| 3 | `stopImmediatePropagation` 吞 `visibilitychange`/`blur`/`pagehide` | 阻止页面注册的暂停回调 | **部分有效** | 同上 | 若播放器用 `document.hasFocus()` 或原生事件则无效（D） |
| 4 | `playbackRate=2` | 视频位置推进速度 ×2 | **有效但踩线**：2x 是官方上限；>2x 高危 | SCUEC（A）；Mortal004（B） | 高倍速 → 任务点清空 |
| 5 | 静音 `muted=true` | 无 | 无影响 | — | 无 |
| 6 | **90% 跳下一节** | 跳过最后 10%；**很可能跳过 `isdrag=4 complete`** | **很可能无效** | SCUEC"完整观看才变绿"（A）；`complete` 语义（A）；同类脚本 0.98（A） | **任务点不变绿**，完成率反而 <100% |
| 7 | 自动答视频弹题 | 正确率、答题时长 | 有效（对成绩），但**答题过快**可能异常 | 桂林理工"做题时长不满足"（A）；NWNU"完成时间过于集中"（B） | 中 |
| 8 | DeepSeek 答题 | 与检测无关 | 对"是否异常"无效 | — | 数据出境/隐私 |
| 9 | 多标签/多课程并发 | 同账号多终端 | **无效且高危** | 河南城建（A）；Mortal004（B） | **高：清空进度/挂科** |
| 10 | 后台挂机（标签页隐藏） | 定时器被节流 | **不稳定** | Chromium 后台节流（见下）；Autovisor"最小化进度不增加"（B） | 心跳间隔异常（D） |

### 6.1 特别标注 A：伪造 visibility 是否"已失效"？

**结论：没有公开证据表明学习通"识破"了 `document.hidden` 覆写；但同样没有证据表明它能改善判定。**

支持"未被专门封堵"的证据：
- 2025–2026 年仍在维护的主流脚本（ScriptCat 6337 v1.5.2、本项目、NoStopVideo、DaRin1403）**全部仍在使用** `defineProperty` + `stopImmediatePropagation` 这一套，且没有 issue 报告"该方法被识别"。
- 平台侧公开的处罚理由里，**从未出现"页面可见性伪造"**；出现的是"时长不足""0 分钟完成""多终端""倍速过高"。

支持"它本来就不是关键"的证据：
- 服务端只收到 `playingTime`/`isdrag`/时间戳，收不到 `document.hidden`。伪造 visibility **不改变任何上报字段**。
- 真正被清算的案例（桂林理工、河南城建、广东科技学院）全部指向**时长/并发/倍速**，不指向可见性。
- 反例：Autovisor 记录"**最小化会让浏览器暂停渲染，进度不增加**"——说明"可见性"确实影响播放，但正确解法是"让窗口真实渲染（移出屏幕）"，而不是"骗 DOM 说自己是可见的"。如果播放器依赖 `requestAnimationFrame`/渲染管线，`defineProperty` 骗不过它。

**因此**：
- 把它当"防暂停兜底"——**可以保留**；
- 把它当"防检测手段"——**是高估**；
- 真正需要补的是 §6.2 的时长与并发纪律。

### 6.2 特别标注 B：倍速是否"已被检测"？

**结论：已被检测，但阈值在 2x，不是"一开倍速就死"。**

三层证据：
1. **官方允许 ≤2x**（SCUEC，A）——说明平台把 2x 视为正常学习行为。
2. **>2x / 暴力模式会回滚**（Mortal004 B、Yatori B）——说明检测的是"相对真实时长的偏离"。
3. **同类脚本把 2x 标为"检测风险最高"**（DaRin1403 B）——说明即使 2x 也在边缘。

**机制推测（D）**：服务端用"两次上报的 `playingTime` 增量 ÷ 两次请求的到达时间增量"估计实际倍速；若显著 >2（例如 8x 时该比值≈8），标记异常；若整门课在极短周期完成，直接判"刷课"。这与"每天复核""延迟清算"的描述吻合。

### 6.3 特别标注 C：90% 跳转是当前最大的技术缺陷

三条独立线索指向同一结论：

1. **规则层**："完整观看所有课程视频，系统才会判定任务点通过"（SCUEC，A）。
2. **协议层**：`complete (isdrag=4)` 的语义是"Watched to the end"（A）。90% 跳转 = 永远不发 complete。
3. **社区层**：同类脚本阈值取 **0.98**（ScriptCat 6337 源码，A），而不是 0.90。

**建议的最小改动**（不改平台、仅自测）：
- 把 `nextAtPercent` 提到 **98%**，并保证最后 2% 是"自然播放"而非 seek；
- 或在跳转前**主动触发一次 ended/complete 路径**（让播放器自己认为播完），再跳；
- 保留 `thresholdDelay`（15s）作为上报窗口，但不要用 seek 补进度。

---

## 7. 给项目的建议

### 7.1 工程侧（按性价比排序）

1. **阈值 90% → 98%，并补 complete 上报**（见 §6.3）。这是唯一能直接提升"任务点变绿率"的改动。
2. **默认倍速 1x，允许 1.5x/2x，硬上限 2x**；>2x 只作为"复习模式"且明确警告。
3. **单账号单端**：检测到同账号在另一标签/另一课程播放时，主动暂停并提示。不要做"多课程并发"。
4. **不要伪造心跳**：保留播放器原生的上报链路，不要自己 `fetch` 打 `multimedia/log`（自算 `enc` 一旦算错/时序错，反而是最硬的异常证据）。
5. **可见性伪造保留在 iframe realm**：顶层 + `#iframe` 的 `contentDocument` 都要覆写；优先用 `all_frames` 注入，而不是只改顶层。
6. **避免后台节流**：不要依赖隐藏标签页挂机。若必须后台，用"窗口移出屏幕"而不是"最小化/隐藏"（Autovisor 的经验）。`navigator.wakeLock` 只防息屏，不防节流。
7. **拟人化**：随机暂停 3–15s、每节之间随机 10–60s、每天上限（如 4h）、只在 7:00–23:00 运行、整门课分 ≥3 天完成。
8. **答题节奏**：每题间隔 ≥3–5s，不要"零延迟批量提交"；弹题正确率优先于速度。
9. **不碰签到/考试**：这两块的处分与法律风险最高，收益（5–15 分）与风险不成比例。
10. **凭据安全**：账号密码/DeepSeek Key 只存本地；不要上传任何服务器；日志脱敏。

### 7.2 合规侧

- **不公开分发、不售卖、不代刷他人账号**。刘健案的门槛是"制作 + 销售/提供"，自用与分发的法律性质不同。
- 若开源：README 必须写明"仅限个人学习研究、禁止代刷/售卖、后果自负"，且**不要内置"秒刷/多端/过验证码"**——这些会把项目从"辅助"推向"外挂"。
- UI 明示：题目会发送到 DeepSeek；不要静默上传。
- 不要把"绕过人脸/过滑块"作为卖点——这是最容易被认定为"避开安全保护措施"的功能。

### 7.3 建议的验证实验（不改平台，仅自测）

1. 用测试账号，把某一节看到 **90% 跳转**，24h 后看任务点是否变绿；再对比 **98% 自然播完**。→ 验证 §6.3。
2. 同一节课分别用 **1x / 2x / 4x** 完成，记录 24h/72h 后任务点状态。→ 验证倍速阈值。
3. 抓一次 `multimedia/log`，对比 `playingTime` 增量与本地 `performance.now()` 增量，算出服务端可推断的倍速。→ 验证 §6.2 机制。
4. 在隐藏标签页 vs 窗口移出屏幕两种情况下，记录上报间隔分布。→ 验证 §6.1 的节流推测。

---

## 8. 参考来源

### 8.1 平台规则 / 学校文件（A/B）

1. 中南民族大学教务处《关于 2024-2025 学年第 2 学期网络通识选修课修读的通知》—— https://www.scuec.edu.cn/jwc/info/1003/3636.htm
2. 衡水学院教务处《关于 2025-2026 学年第一学期网络通识课学习的通知》—— https://jwc.hsnc.edu.cn/info/1011/5980.htm
3. 西北师范大学《网络通识课学习注意事项》（docx）—— https://jwc.nwnu.edu.cn/_upload/article/files/98/bd/d45ff34c44abb0a9b7f89f49a908/8ad1c439-2a77-4fec-b036-1dfeb153ca7f.docx
4. 河南城建学院《关于 2024-2025 学年第二学期尔雅通识公选课违规学习学生处理的通知》—— https://jwc.huuc.edu.cn/info/1019/5211.htm
5. 桂林理工大学《关于学习异常数据处理情况的通报》—— https://nnfx.glut.edu.cn/jxjy/info/1159/1064.htm
6. 广东科技学院《超星学习通网课学习进度被退回怎么办？》—— https://www.gdust.edu.cn/jwc/jiaowu/20260525/10074.html
7. 广东第二师范学院《关于重置存在不良学习记录学生超星尔雅网络公选课相关课程学习进度的通知》—— https://www.gdei.edu.cn/_upload/article/files/15/f1/dcacbd8340d3ab1955bf711e0125/bb806a21-6dac-4946-b316-a7c530739045.pdf
8. 广东石油化工学院《关于开展 2026-2027 学年第一学期线上通识教育选修课课程学习及考试工作的通知》—— https://jwb.gdupt.edu.cn/info/1053/10772.htm

### 8.2 协议 / 逆向（A）

9. 《超星学习通协议分析》，吾爱破解，2019-06-15 —— https://www.52pojie.cn/thread-975538-1-1.html
10. flutter_chaoxing（官方 Android 7.0.2 逐行移植）—— https://pub.dev/packages/flutter_chaoxing
11. `ChaoxingVideoReport`（enc 算法、盐值、query 模板）—— https://pub.dev/documentation/flutter_chaoxing/latest/flutter_chaoxing/ChaoxingVideoReport-class.html
12. `ChaoxingVideoReport.buildUri`（含 `view=json` 被 WAF 拦、`view=pc` 可用）—— https://pub.dev/documentation/flutter_chaoxing/latest/flutter_chaoxing/ChaoxingVideoReport/buildUri.html
13. `ChaoxingVideoProgressType`（isdrag 0–4 语义）—— https://pub.dev/documentation/flutter_chaoxing/latest/flutter_chaoxing/ChaoxingVideoProgressType.html
14. 《超星某习通滑块验证登录逆向分析》，吾爱破解，2025-06-07 —— https://www.52pojie.cn/thread-2037138-1-1.html
15. 《学习通 DrissionPage 模拟登录及获取课程分析（一）》，吾爱破解，2024-06-21 —— https://www.52pojie.cn/forum.php?mod=viewthread&tid=1936866

### 8.3 开源项目（B）

16. Yatori（yatori-go-console）—— https://github.com/yatori-dev/yatori-go-console ；官方文档 https://yatori-dev.github.io/yatori-docs/yatori-go-console/docs.html
17. Mortal004/Xuexitong_shuake —— https://github.com/Mortal004/Xuexitong_shuake ；使用教程 https://mortal004.github.io/xuexitong-tutorial/guide/usage.html
18. DaRin1403/xuexitong-autostudy —— https://github.com/DaRin1403/xuexitong-autostudy
19. CXRunfree/Autovisor（Playwright，智慧树）—— https://github.com/CXRunfree/Autovisor
20. Dainoar/SuperAutoStudy —— https://github.com/Dainoar/SuperAutoStudy
21. pang-qin/chaoxing-toolkit —— https://github.com/pang-qin/chaoxing-toolkit
22. forgotfish/dsh-cx-learn —— https://github.com/forgotfish/dsh-cx-learn
23. Fanxiaoyao66/chaoxing-auto-study —— https://github.com/Fanxiaoyao66/chaoxing-auto-study
24. Minnjee/course-helper —— https://github.com/Minnjee/course-helper
25. BlairCode/NoStopVideo —— https://github.com/BlairCode/NoStopVideo
26. Samueli924/chaoxing —— https://github.com/Samueli924/chaoxing
27. tzg-nz/ChaoxingAuto —— https://github.com/tzg-nz/ChaoxingAuto
28. lsicdl2d/CxKitty —— https://github.com/lsicdl2d/CxKitty
29. jiangyei/fakechaoxing —— https://github.com/jiangyei/fakechaoxing
30. scriptscat / ScriptCat 脚本《学习通自动刷课·复习》v1.5.2 —— https://scriptcat.org/zh-CN/script-show-page/6337
31. CodFrm/cxmooc-tools —— https://github.com/CodFrm/cxmooc-tools
32. ocsjs/ocsjs issue #354《自动答题会被检测并踢出》—— https://github.com/ocsjs/ocsjs/issues/354

### 8.4 反检测 / GUI Agent（A/B）

33. patchright（PyPI）—— https://pypi.org/project/patchright/
34. patchright-python —— https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python
35. undetected-chromedriver —— https://github.com/ultrafunkamsterdam/undetected-chromedriver
36. DrissionPage 官网 —— https://drissionpage.cn/
37. AutoX.js —— https://github.com/kkevsekk1/AutoX ；文档 https://v7.autoxjs.dayudada.com/docs/rhino/base/widgetsBasedAutomation/
38. UI-TARS Desktop —— https://github.com/bytedance/UI-TARS-desktop ；https://seed-tars.com/1.5/
39. Claude Computer Use —— https://code.claude.com/docs/en/computer-use ；https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
40. TRAE SOLO 报道 —— https://www.zhidx.com/p/555389.html ；https://m.leiphone.com/category/industrynews/HlSXWFj00fGo38wZ.html

### 8.5 法律 / 政策（A）

41. 教育部等五部门《关于加强普通高等学校在线开放课程教学管理的若干意见》（教高〔2022〕1 号）—— https://www.gov.cn/zhengce/zhengceku/2022-04/01/content_5682923.htm
42. 教育部原文 —— https://hudong.moe.gov.cn/srcsite/A08/s7056/202204/t20220401_612700.html
43. 《制作、销售学习平台辅助程序的定性》（刘健案，人民司法案例）—— http://bjjbls.com/m/NewsDetail.aspx?Id=5654
44. 《790 万大学生仅花 5 元钱就能"刷课秒过"？警方揭秘全国首例"付费刷课"案细节》—— http://chinapeace.gov.cn/chinapeace/c100042/2021-09/13/content_12535955.shtml
45. 油猴中文网《如何解决学习通的切屏检测？》—— https://bbs.tampermonkey.net.cn/thread-9204-1-1.html

### 8.6 社区线索（C，仅作线索）

46. 小红书《学习通 视频有观看时长要求，用插件倍速播放任务点不会变绿》—— https://www.xiaohongshu.com/discovery/item/6a02f27a0000000036019808
47. 小红书《熬夜刷完的学习通进度一觉醒来清零》—— https://www.xiaohongshu.com/discovery/item/6a00466e0000000008024e5e
48. 小红书《学习通安全高效刷课全攻略（红线清单）》—— https://www.xiaohongshu.com/discovery/item/69c34b44000000001a02a3f5

---

## 附录 A：本轮核验状态说明

| 状态 | 说明 |
|---|---|
| 直接抓取并阅读 | SCUEC、HSNC、GDust、HUUC、GLUT、gov.cn、bjjbls、chinapeace、52pojie（975538 / 2037138 / 1936866）、pub.dev（包主页 + 3 个文档页）、yatori 文档、Mortal004 教程、ScriptCat 脚本源码、NWNU docx、xiaohongshu 若干 |
| 仅搜索引擎索引 + 姊妹任务抓取的 README | 全部 GitHub 项目（本机网络无法直连 github.com，`curl` 返回 000/连接重置）；其 README 原文已存于 `research/readmes/`，issue 原文存于 `research/issues/` |
| 未能打开 | 知乎（403）、linux.do（解析到非公网 IP）、微信公众号（跳验证码）、bubuko（404） |

**因此**：GitHub 链接的"项目存在"是可信的（README 已被抓取），但**具体某一行描述**若仅来自 README，请按 B 级看待。

## 附录 B：与本项目最相关的 5 个"下一步动作"

1. 把 `nextAtPercent` 从 0.90 改为 **0.98**，并确保最后一段自然播放（§6.3）。
2. 倍速硬上限 **2x**，默认 **1x**；UI 标注"2x = 检测风险最高"。
3. 禁止多课程/多标签并发；检测到同账号第二端播放时主动停。
4. 把"visibility 伪造"降级为"防暂停兜底"，并补 iframe realm 覆盖；不再把它当卖点。
5. 在 README/UI 增加"每日上限、正常时段、分多天完成、不碰签到考试"的合规提示（对齐 DaRin1403 的做法）。

---

*本报告仅用于技术研究与风险分析，不构成使用建议或法律意见。所有链接均为调研时（2026-10-28）可查的公开来源；平台接口与风控会持续变化，落地前请以最新抓包为准。*

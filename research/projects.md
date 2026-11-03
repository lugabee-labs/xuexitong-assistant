# 学习通/超星及其它中国 MOOC 平台「自动刷课 / 自动答题」开源项目横评

> **数据截止：2026-10-28 21:37（UTC+8，Asia/Shanghai）**
>
> star / fork / pushed_at / license / archived 全部为上述时点通过 GitHub REST API 实取，非记忆或估算。
>
> 采集方式：`api.github.com/search/repositories`（11 组关键词，匿名调用，每组取 star 降序前 100）+ `raw.githubusercontent.com` 取 README 原文 + `api.github.com/search/issues` 取各仓库最近 issue 标题。
>
> 脚本市场：GreasyFork「按站点」列表页（`/scripts/by-site/chaoxing.com` 等，含 `data-script-total-installs`）+ 单脚本 JSON；ScriptCat 开放 API（`scriptcat.org/api/v2/scripts?keyword=学习通`，共命中 1969 个脚本）。
>
> 口径说明：star 只能反映"代码被收藏"，**与真实使用量严重脱节**——OCS 在 GitHub 3,994★，在 GreasyFork 累计安装 245.8 万；见第五节。

---

## 一、结论速览

1. **生态呈"三足鼎立 + 长尾"**：`ocsjs/ocsjs`（3,994★，多平台+桌面端）、`Samueli924/chaoxing`（3,724★，纯协议+题库）、`chaolucky18/xuexitongScript`（3,456★，最克制）合计约 1.1 万★，占了头部声量。11 组关键词共去重出 **630 个仓库**，其中 437 个与网课主题相关；但这 437 个里只有 **53 个 ≥100★**，**255 个 <10★**——典型的长尾死火山。
2. **"能播"早已不是壁垒**，2020 年的方案（`LeoChen98/chaoxing`、`perhaps-yo/zhihuishu`）和 2026 年的方案在"自动播放+切集"上几乎无差别。真正的分水岭是**字体反爬、弹题、章节测验、风控自愈**这四件事。
3. **字体反爬解密是事实上的入场券**：学习通把题干字符用 `font-cxsecret` 动态字体打乱。2026 年还活着的答题项目几乎都内置了字形比对还原（`DaRin1403` 用 Canvas 字形对比、`tzg-nz` 用 fonttools+思源黑体基准、`unraous` 用 TTF 轮廓特征哈希）。
4. **AI 答题已是标配，但"能答"不等于"答对"**：本次实读的 30 个 README 里，**9 个**内置了 LLM 答题（`DaRin1403`、`pang-qin`、`kukuqi666`、`Trashwbin`、`Mortal004`、`tzg-nz`、`unraous`、`chaolucky18`、`Samueli924`）。真实反馈很差——`uxuescript` 的 issue 里直接写着"生成答案全是 A 导致不及格卡死"、"考试成绩过低"（2026-10-25/26）；`DaRin1403` 自述存在"字体解密假成功、判断题假作答"。
5. **最硬的护城河是"风控对抗 + 协议化"**：`tzg-nz/ChaoxingAuto` 做了 9010 验证码自动过码、滑块缺口识别、keep-alive 重连自愈；`MuWinds/yuketangHelperBUU` 直接伪造雨课堂心跳包；`qcxs/chaoxing` 干脆逆向 APK 改包。这类项目 star 都不高（12~135★），但工程量远超那些 3k★ 的脚本。
6. **签到是独立且成熟的赛道，且比刷课更"卷"**：`cxOrz/chaoxing-signin`（1,779★，已归档）、`CofbroTeam/Doraemon`（934★）、`aquamarine5/ChaoxingSignFaker`（886★）已经把"代签"做到伪造签到活动、任选照片过拍照签到、自动抓人脸照片过人脸识别。
7. **头部项目在集体老化**：`CodFrm/cxmooc-tools`（2,724★）自 2022-02 起零提交并已 archived；`cxOrz/chaoxing-signin`（1,779★）已 archived。活着的头部靠"高频适配页面改版"续命，`chaolucky18` 的 issue 里最新一条就是"学习通反爬虫导致大模型答题准确度较低"（2026-10-21）。
8. **没有任何一个项目真的在做 computer-use / GUI Agent**：全量结果里没有出现基于视觉定位或操作系统级 GUI 自动化的刷课项目，最接近"Agent 形态"的是把学习通封装成 MCP 工具（`Han-maker-wp/chaoxing-mcp`、`DanMo661/xuexitong-cli`）。**这是一个明确的空白位**（见第六节）。

---

## 二、项目对比表

> 按 star 降序。star/更新日期为 2026-10-28 21:37 实取值；"维护状态"按 pushed_at 与 archived 判定：活跃 ≤90 天、维护中 ≤1 年、半停更 1~2 年、停更 >2 年、已归档 = archived:true。

| 项目 | 平台 | 技术形态 | 核心能力 | star | 最近更新 | 维护状态 | 链接 |
|---|---|---|---|---|---|---|---|
| ocsjs/ocsjs | 学习通、智慧树、职教云、智慧职教、中国大学MOOC、雨课堂 | 油猴/脚本猫脚本 + 桌面客户端（TS） | 播放、任务点、弹题、章节测验、作业、考试；题库+AI 搜题；多账号、浏览器多开；桌面端宣称可绕智慧树/MOOC 的脚本检测 | 3994 | 2026-10-23 | 活跃 | https://github.com/ocsjs/ocsjs |
| Samueli924/chaoxing | 学习通/尔雅/泛雅 | 纯协议（Python requests），CLI/exe/Docker | 任务点、视频、文档、章节测验题库答题、章节学习次数、外部通知；`notopen_action` 三态、`submit` 只保存不交卷 | 3724 | 2026-09-28 | 活跃 | https://github.com/Samueli924/chaoxing |
| chaolucky18/xuexitongScript | 学习通 | 油猴/控制台单文件 JS | 自动播放、静音续播、自动切下一小节、测验页受限跳转（最多 3 次防循环）；1.5x 上限；另附 DeepSeek 控制台练习版 | 3456 | 2026-10-16 | 活跃（功能刻意保守） | https://github.com/chaolucky18/xuexitongScript |
| CodFrm/cxmooc-tools | 学习通、智慧树、中国大学MOOC | 浏览器扩展（Chrome/Firefox）+ 油猴 | 视频秒过、倍速、静音、任务答题、自动阅读、考试/作业答题、验证码自动打码 | 2724 | 2022-02-07 | **已归档** | https://github.com/CodFrm/cxmooc-tools |
| cxOrz/chaoxing-signin | 学习通签到 | 协议复现（TS/Nuxt 全栈） | 普通/拍照/手势/位置/二维码签到、自动监测、QQ 机器人推送 | 1779 | 2024-10-14 | **已归档** | https://github.com/cxOrz/chaoxing-signin |
| CXRunfree/Autovisor | 智慧树 | Playwright（Python+JS） | 无人值守、自动过登录滑块（OpenCV）、弹窗/弹题自动跳过、倍速静音、隐藏窗口后台刷、习惯分 | 1077 | 2026-09-24 | 维护中（作者称佛系更新） | https://github.com/CXRunfree/Autovisor |
| CofbroTeam/Doraemon | 学习通签到 | Android（Kotlin） | 普通/扫码/图片/二维码/定位签到，一键同步作业 | 934 | 2026-10-12 | 活跃 | https://github.com/CofbroTeam/Doraemon |
| aquamarine5/ChaoxingSignFaker | 学习通签到 | Android（Kotlin，AGPL-3.0） | **伪造签到活动**、一机多账号、任意位置、图库照片过拍照签到、代扫二维码、自动滑验证码、抓人脸照片过人脸识别、校园定制版 | 886 | 2026-10-28 | 活跃 | https://github.com/aquamarine5/ChaoxingSignFaker |
| Dainoar/SuperAutoStudy | 学习通 | Spring Boot + Dubbo + RabbitMQ 微服务，Docker | 云端多账号托管、断点续学、防挂机检测、Super 题库（宣称百万级）+ 大模型答题 | 779 | 2026-07-14 | 维护中 | https://github.com/Dainoar/SuperAutoStudy |
| eric-gitta-moore/chaoxing-sign-app | 学习通签到 | Electron + Next.js + Capacitor 全平台 | 六类签到、多账号切换、任选位置、无视二维码 10 秒刷新、Docker/termux 部署 | 570 | 2026-09-11 | 活跃 | https://github.com/eric-gitta-moore/chaoxing-sign-app |
| yatori-dev/yatori-go-console | 学习通、英华、仓辉、创能、党校、职教、青书等 16 平台 | Go 独立程序 + Docker | 多账号同刷、AI 过验证码、自动考试、绕过人脸、断点续刷、邮件通知、"暴力模式"无视前置课程 | 558 | 2026-10-26 | 活跃 | https://github.com/yatori-dev/yatori-go-console |
| lispringing/SuperStar | 学习通 | 云端刷课（Python） | 无需本地部署的云端托管 | 433 | 2026-07-24 | 维护中 | https://github.com/lispringing/SuperStar |
| 3425734131/GoodSign | 学习通签到 | Android（Java） | 全类型一键签到（含二维码）、未交作业提醒、后台静默签到、抢答 | 429 | 2023-04-27 | 停更 | https://github.com/3425734131/GoodSign |
| liuyunfz/chaoxing_tool | 学习通 | Python 协议 | 一键完成任务点、刷章节学习次数、下载课程资源 | 413 | 2024-06-22 | 半停更 | https://github.com/liuyunfz/chaoxing_tool |
| AneryCoft/course_helper | 学习通、雨课堂 | Flutter（Dart） | 课程管理、签到、随堂练习 | 343 | 2026-10-25 | 活跃 | https://github.com/AneryCoft/course_helper |
| unraous/uxuescript | 学习通 | Tauri 桌面端（Rust+Vue）+ WebView 注入 + 油猴/core.js 双形态 | AI 答题（多供应商+本地模型）、TTF 字形还原、失败批次重试/限流降并发、Review Answers 人工核验、作业只暂存不提交 | 327 | 2026-10-26 | 活跃 | https://github.com/unraous/uxuescript |
| destoryD/chaoxing-api | 学习通/智慧树/职教云/MOOC/雨课堂等 | 题库查询接口服务 | 多平台查题 API | 269 | 2025-02-18 | 半停更 | https://github.com/destoryD/chaoxing-api |
| perhaps-yo/zhihuishu | 智慧树 | 油猴 | 自动播放下一集、1.5x、静音 | 265 | 2019-03-22 | 停更 | https://github.com/perhaps-yo/zhihuishu |
| LetMeFly666/YuketangAutoPlayer | 雨课堂 | Selenium（Python），可打包 exe | 自动播放、无窗口模式、cookie/扫码登录 | 223 | 2025-11-13 | 维护中 | https://github.com/LetMeFly666/YuketangAutoPlayer |
| Mortal004/Xuexitong_shuake | 学习通 | Selenium + customtkinter GUI | 最高 16x 倍速、定时刷课、多课程并行、自动签到、跳过人脸、免费题库+DeepSeek、作业/直播/讨论/PPT/音频 | 178 | 2026-10-15 | 活跃 | https://github.com/Mortal004/Xuexitong_shuake |
| Xposed-Modules-Repo/com.yinshibai.chaoxingx | 学习通 App | Xposed 模块 | 考试击破（App 端 Hook） | 135 | 2026-10-19 | 活跃 | https://github.com/Xposed-Modules-Repo/com.yinshibai.chaoxingx |
| MuWinds/yuketangHelperBUU | 雨课堂 | 协议伪造心跳包 + 多线程（Python） | 秒刷、扫码登录、AI 答题（含填空题） | 101 | 2026-09-08 | 活跃 | https://github.com/MuWinds/yuketangHelperBUU |
| Trashwbin/MultiAI-Answer-cx | 学习通考试/作业 | Chrome 扩展（TS） | **多模型加权投票**、11 种题型、批量 prompt、答案对比面板、模拟人工点击延迟 | 71 | 2026-06-26 | 维护中 | https://github.com/Trashwbin/MultiAI-Answer-cx |
| 666cy666/Script-Zhihuishu | 智慧树 | 油猴 | 自动刷课、章节测试自动答题 | 70 | 2024-11-09 | 半停更 | https://github.com/666cy666/Script-Zhihuishu |
| qcxs/chaoxing | 学习通 App | APK 逆向/改包 | 拖拽章节进度条、考试切屏、填空题粘贴、同设备多签 | 61 | 2026-07-05 | 维护中 | https://github.com/qcxs/chaoxing |
| pang-qin/chaoxing-toolkit | 学习通 | 油猴 + FastAPI/SQLite 题库服务 + Vue3 后台 | 任务点跳转、测验/作业/考试答题、自建题库精确匹配、DeepSeek、未命中题目进"待处理"队列 | 59 | 2026-06-01 | 维护中 | https://github.com/pang-qin/chaoxing-toolkit |
| bclswl0827/Fuck-ChaoXing | 学习通 | 油猴 | 绕过人脸认证、题目 OCR、自动刷课 | 55 | 2022-05-13 | **已归档** | https://github.com/bclswl0827/Fuck-ChaoXing |
| sweetcornna/university-helper | 学习通、智慧树 | FastAPI + React + Docker | 签到与课程任务、智慧树扫码/密码登录刷课、后端异步（关网页不中断）、每用户独立 Postgres 多租户隔离 | 51 | 2026-10-26 | 活跃 | https://github.com/sweetcornna/university-helper |
| kukuqi666/chaoxing-script-ai | 学习通、九九助手、ABC网课 | 本地 OpenAI 兼容答题 API + 脚本猫脚本 | 自建 API 冒充付费题库协议（7 接口），任何题库兼容脚本可改指向 | 47 | 2025-11-16 | 停更 | https://github.com/kukuqi666/chaoxing-script-ai |
| DaRin1403/xuexitong-autostudy | 学习通 | 油猴单文件 user.js | 弹题+测验 AI 作答、字体 Canvas 解密、**拟人化防检测**（倍速上限/随机延迟/故意答错率/每日时长上限）、正确率≥60% 才提交 | 44 | 2026-10-20 | 活跃 | https://github.com/DaRin1403/xuexitong-autostudy |
| thuhollow2/yuketang | 雨课堂 | Python，支持 Termux/iSH | 自动签到、自动答题、PPT 下载、自动考试、同步答案、企微/钉钉/飞书推送 | 38 | 2026-10-17 | 活跃 | https://github.com/thuhollow2/yuketang |
| DanMo661/xuexitong-cli | 学习通（只读） | Python CLI + MCP Server | 课表/课程/资料/作业/考试/章节进度/通知/云盘查询，JSON 输出 | 18 | 2026-10-27 | 活跃 | https://github.com/DanMo661/xuexitong-cli |
| tzg-nz/ChaoxingAuto | 学习通 | 纯协议 Python（无浏览器/无 Selenium） | 视频/图文/测验/考试全自动、LLM 答题、字体反爬解码、**9010 风控自动过码**、滑块 OCR、网络自愈、满分模式 3 轮重做 | 12 | 2026-10-20 | 活跃 | https://github.com/tzg-nz/ChaoxingAuto |
| Han-maker-wp/chaoxing-mcp | 学习通（只读） | MCP Server，单文件 Python ~400 行 | 作业/课程/页面正文查询给 AI 直接调用；AES-CBC 登录逆向、cookie 落盘、自动重登 | 11 | 2026-10-21 | 活跃 | https://github.com/Han-maker-wp/chaoxing-mcp |

**表外补充（技术上有代表性但 star <10）**：`zhouchiwang/xuexitong`（7★，宣称"非倍速、直接跳过视频拿任务点"）、`TellMeYourWish/chaoxing_solution_of_font_confusion`（17★，专做字体反爬解码）、`wbfan95/Duxiu-iid-v3-Decoder-JS`（12★，离线解密读秀/超星 iid v3 封面）、`vibe-GIF/chaoxing`（13★，多账号并发）、`Khihl-lucky/ChaoXing-AutoAnswer`（12★，DeepSeek 多模态）、`yatori-dev/yatori-go-core`（55★，Go 核心库，供二次开发）。

### issue 区的失效信号（比 README 可信）

README 只会说"支持"，issue 才说"什么时候坏的"。下表是各仓库最近三个月的代表性 issue 标题（`search/issues` 按创建时间倒序）：

| 项目 | issue 总数 | 最近的代表性失效信号（日期） |
|---|---|---|
| ocsjs/ocsjs | 265 | 「自动答题会被检测并踢出」（10-20）；「超星学习通文字解密出错」（10-22）；「中国大学MOOC 网页改版，原刷课脚本失效」（10-20） |
| Samueli924/chaoxing | 430 | 「使用 AI 答题时，题目图片不能正常上传」（10-21）；「章节并发计时异常」（10-14）；「视频上报 403」（07-16） |
| chaolucky18/xuexitongScript | 50 | 「学习通反爬虫导致大模型答题准确度较低」（10-21）；「无法被记为完课」（10-16） |
| CodFrm/cxmooc-tools | 253 | 「此项目不再维护了吗？」（2022-04-15）；「题库又挂掉了」×3（2022-04）——**最后一条 issue 停在 2022 年** |
| cxOrz/chaoxing-signin | 208 | 「签到码无法以学生身份获取」（2025-02-26）；此后无新 issue |
| CXRunfree/Autovisor | 135 | 「新版共享课无法正常刷课」（10-12、10-14）；「课时激活超时」（10-12）；「您的脚本被盗用引流至刷课下单平台」（10-11） |
| Dainoar/SuperAutoStudy | 18 | 「学习通的接口更新了，登录一直报错账号密码不对」（05-19）——**接口漂移后 5 个月未修** |
| yatori-dev/yatori-go-console | 32 | 「学习通任务点提交后缺少结果验证，错误答案可能被误判为完成」（05-13）；「学习通作业无法完成」（10-27 已关） |
| unraous/uxuescript | 33 | 「生成答案全是 A 导致不及格卡死」（10-26 已关）；「考试成绩过低」（10-25）；「讨论类型任务点无法完成」（10-28） |
| DaRin1403/xuexitong-autostudy | 5 | 「AI 答题链路存在多平台权限、**字体解密假成功**与判断题假作答」（09-21）；「空提交」（10-24）；「无法切到下一页/章节」（10-19） |
| Mortal004/Xuexitong_shuake | 6 | 「2026.9.8 现在已经绕不了人脸了」（09-08）；「无法播放视频」（10-09 已关） |
| tzg-nz/ChaoxingAuto | 1 | 仅 1 条功能请求，无失效报告（但也意味着样本极小） |
| pang-qin/chaoxing-toolkit | 0 | 从未用过 issue 区，**无外部验证**，质量全靠作者自述 |

**三个反复出现的失效模式**：① **字体解密失败或"假成功"**（ocsjs、DaRin1403）——最致命，因为它会让 AI 在乱码上答题，错得毫无察觉；② **页面/接口改版**（MOOC 改版、共享课改版、登录接口改版）；③ **风控升级**（人脸绕过失效、自动答题被检测踢出）。**评估一个刷课项目，先看它最近 30 天有没有人报"失效"，再决定要不要用。**

---

## 三、能力分层：从「能播」到「跟风控对抗」

### L0 — 只是能播（自动播放 / 倍速 / 切集）

**做什么**：点 play、静音、设 playbackRate、监听 ended 事件切下一小节。
**代表**：`LetMeFly666/YuketangAutoPlayer`（Selenium，223★）、`perhaps-yo/zhihuishu`（油猴，265★，2019 年后再无更新）、`chaolucky18/xuexitongScript`（3,456★，但功能刻意停在 L0 — 作者明确说"不再叠加复杂的后台保活、通知、测试按钮"，播放倍速锁 1.5x，跳转最多重试 3 次防循环）。
**天花板**：**极低且已被平台打穿**。学习通服务端复核观看时长，快进会被回滚（`tzg-nz` README 原话："服务端会复核观看时长，快进会被回滚"）；视频内弹题一出就卡死；章节测验不解就"任务点未完成"，永远进不了下一章。L0 项目在 2026 年基本只剩"减少手点"的价值。

### L1 — 能过任务点 + 能填测验（脚本级自动答题）

**做什么**：识别 iframe 内视频、自动处理弹题、文档/音频/PPT 自动滚动停留、章节测验提取题目→查题库/AI→自动勾选→按正确率阈值提交。
**代表**：`Samueli924/chaoxing`（协议，3,724★）、`unraous/uxuescript`（327★）、`pang-qin/chaoxing-toolkit`（59★）、`Mortal004/Xuexitong_shuake`（178★）、`chaolucky18` 的 DeepSeek 控制台版。
**天花板**：**题库覆盖率 + 题型边界**。① 主观题（简答/论述）AI 答了也未必对，`tzg-nz` 干脆"一律不作答、留空交卷"；② 题库靠人头攒，新题没人做过就查不到（`CodFrm` 的题库机制就是"需要有人第一次做过"）；③ 字体反爬没解就等于题面是乱码——这是 L1 的隐形门槛。

### L2 — 能答题 + 能考试 + 多账号/云端托管（工程化）

**做什么**：把刷课变成"服务"：账号池、任务队列、断点续跑、多平台适配、自动考试、通知推送、Web 管理台。
**代表**：`Dainoar/SuperAutoStudy`（779★，Spring Boot+Dubbo+RabbitMQ 微服务，云端托管）、`yatori-dev/yatori-go-console`（558★，Go 单文件二进制，16 平台，多账号同刷+自动考试+AI 过验证码）、`lispringing/SuperStar`（433★，云端刷课）、`sweetcornna/university-helper`（51★，FastAPI 异步任务+每用户独立 Postgres 多租户）、`pang-qin/chaoxing-toolkit`（题库服务与脚本解耦）。
**天花板**：**正确率不可控 + 平台接口漂移**。`Dainoar` 的 issue 里就躺着"学习通的接口更新了，登录一直报错账号密码不对"（2026-05-19）；`uxuescript` 的"答案全是 A 卡死"、"考试成绩过低"；`yatori` 的"任务点提交后缺少结果验证，错误答案可能被误判为完成"。多账号托管还额外引入**关联封号**风险（同 IP/同设备指纹批量登录）。

### L3 — 在跟风控对抗（反爬 / 验证码 / 拟人化 / 协议直连）

**做什么**：
- **字体反爬解密**：`tzg-nz`（fonttools 字形比对 + 思源黑体基准 + 按字体 md5 隔离映射缓存）、`DaRin1403`（Canvas 字形对比）、`unraous`（TTF 轮廓特征哈希表）。
- **验证码/风控自愈**：`tzg-nz` 的 9010 验证码自动识别过码 + `slider_gap.py` 滑块缺口识别（OpenCV+ddddocr）+ keep-alive 被回收自动重发；`CXRunfree/Autovisor` 的 `enableAutoCaptcha` 自动过登录滑块。
- **拟人化行为**：`DaRin1403` 把"倍速上限、随机延迟、故意答错率、每日时长上限"做成可配置项，README 直接写明"请保持默认值，不要为了快而关闭它们"。
- **协议直连（绕开浏览器指纹）**：`tzg-nz`、`Samueli924`、`lyj0309`（105★，"协议发包，无需浏览器"）、`MuWinds`（伪造雨课堂心跳包，秒刷）。
- **检测对抗的另一面**：`ocsjs` 桌面端宣称"可绕过智慧树、中国大学 MOOC 的脚本检测"（官方文档原话）；`qcxs/chaoxing` 改 APK 实现"考试切屏""拖拽进度条"；`aquamarine5/ChaoxingSignFaker` **伪造签到活动**。
**天花板**：**这是一场没有终点的军备竞赛，且平台开始用 AI 反作弊**。学习通官方已声明用"AI、大数据技术监控刷课行为，并可能通报学生所在高校"（`DaRin1403` README 引用）。真实战况写在 issue 里：`ocsjs` "自动答题会被检测并踢出"（2026-10-20）、`chaolucky18` "学习通反爬虫导致大模型答题准确度较低"（2026-10-21）、`ocsjs` "超星学习通文字解密出错"（2026-10-22）。L3 的能力窗口通常只有几周到几个月，之后必须重新逆向。

### 分层结论

| 层 | 能力 | 代表 | 真实门槛 | 能否规模化 |
|---|---|---|---|---|
| L0 | 能播 | YuketangAutoPlayer、perhaps-yo | 无 | 不能 |
| L1 | 过任务点+填测验 | Samueli924、uxuescript | 字体解密 + 题库覆盖 | 单账号可以 |
| L2 | 考试+多账号+云端 | yatori、SuperAutoStudy、university-helper | 接口稳定性 + 正确率 | 勉强，风险高 |
| L3 | 风控对抗 | tzg-nz、DaRin1403、MuWinds、qcxs | 逆向速度 | 不能，且随时失效 |

**一句话**：市面上 90% 的项目停在 L0/L1，**star 数几乎不能作为能力指标**——3,456★ 的 `chaolucky18` 只做 L0，而 12★ 的 `tzg-nz` 做到了 L3 全套。选型要看 issue 区最近三个月的失效报告，而不是 star。

---

## 四、值得抄 / 值得借鉴的设计

以下每条都是**具体项目里的具体做法**，不是泛泛而谈。

### 1. 字体反爬：按字体 md5 隔离映射缓存，不做全局缓存
`tzg-nz/ChaoxingAuto` 维护 `cxsecret_map.json`，注释写明"按字体 md5 隔离，**考试卷同码位在不同卷真字不同，不能合并**"。这是最容易被写错的地方——把字形映射做成全局字典，第二份试卷就会全错。配套还提供 `test_decode.py`：`--offline` 用仓库自带真实密文字体做字形匹配回归，在线模式"拿已批阅测验的明文当标准答案"逐字对照。**可借鉴点：反爬模块必须有可离线回归的自检**，否则线上永远不知道是解密错了还是模型答错了。

### 2. 答题降级链：客观题答、主观题留空、识别失败按题型保底
`tzg-nz` 的三段式：客观题（单选/多选/判断）交 LLM；简答/填空**一律不作答但提交参数完整**（所有题号都在，所以不会报错，也不会卡住流程）；模型未识别时"单选选 A、多选全选、判断选对"保底。这三条组合起来保证**任何情况下流程都能走完**，而不是遇到怪题就死锁。`uxuescript` 的 issue 恰恰暴露了反面教材——"答案全是 A 导致不及格卡死"。

### 3. 满分模式：提交后判分 → 错题重做 → 最多 3 轮 → 落盘错题报告
`tzg-nz` 的 `full_score=True`：提交后判分，客观题有错就重做再答，最多 3 轮；仍未全对则写 `错题报告/用户名_章节名_测试.txt`。并且**只在没满分时才落盘**（"满分没有复盘价值"）。还区分 `mode`（all/course/watch/test/exam）与 `exam_id`，且默认"只考没做过的考试，做过的一律不碰"——**默认行为保守，重考必须显式点名**，这是很好的风险设计。

### 4. 风控自愈：验证码自动过 + 连接复用自愈 + 单点异常不中断
`tzg-nz` 把 9010 验证码处理做成内置模块，滑块缺口识别（`slider_gap.py`）"算法源自 SliderCaptchaOcr，已内化不依赖外部项目"；长挂机心跳撞上被回收的 keep-alive 会自动重发；单章节异常不中断整体流程。**可借鉴点：把"失败"分成"可自愈/需人工/需放弃"三类，而不是一个 try-catch 到底。**

### 5. 拟人化参数化：把"像人"做成配置项而不是硬编码
`DaRin1403/xuexitong-autostudy` 把倍速上限、随机延迟、**故意答错率**（填 8 = 8% 概率故意答错）、每日时长上限全部做成面板可调，默认值即保守值；README 单独一节"安全与合规建议"：倍速 1x、每日 ≤4 小时、正常时段、刷课时手机 App 退出登录（平台点名"多终端"检测）、不要门门满分。**这是少数把"对抗策略"文档化的项目**，比代码本身更值钱。

### 6. 正确率阈值提交 + 想交卷才交卷
`DaRin1403`：正确率 ≥60% 才自动提交，不足自动暂存；`Samueli924/chaoxing` 的 `submit` 布尔：true = 达题库覆盖率就交，false = **只答题不提交**，留给人工核对；`unraous/uxuescript` 更进一步：作业只调"暂存"、**永不自动提交**，考试也要用户自己点交卷，并提供 Review Answers 人工核验开关。**"最后一公里交给人"是当前最稳妥的产品决策。**

### 7. 题库服务与脚本解耦，统一答案协议
`pang-qin/chaoxing-toolkit`：脚本只配一个 `POST /api/search` 地址 + 密钥，服务端 FastAPI+SQLite 返回统一格式——多选用 `#` 分隔、填空用 `|` 分隔、单选直接返文本。好处是脚本换题库零改代码；未命中的题进"待处理"队列，人工补答案后题库自增长。**接口协议就是生态位**：谁定协议，谁收题。

### 8. 用本地服务"冒充"付费题库协议
`kukuqi666/chaoxing-script-ai` 没有改脚本，而是**照着付费题库的 7 个接口实现了一个本地 OpenAI 兼容服务**，于是任何"题库兼容"的脚本只要把地址指过来就能白嫖 AI 答题。这是成本最低的替换策略：**不动客户端，只伪装服务端**。

### 9. 多模型加权投票 + 合并 prompt + 模拟点击延迟
`Trashwbin/MultiAI-Answer-cx`：同时向 DeepSeek/Kimi/通义/智谱/豆包/ChatGPT/Grok 发同一题，**按可配置权重投票**出最终答案；所有题目合并成一条 prompt 减少请求数；自动填写时加"模拟人工点击延迟"；再给一个全屏网格面板让人工对比/改答案。**投票显著降低单模型幻觉**，代价是成本与延迟。

### 10. 工程化容错：无效 JSON 重试、限流降并发、逐题两遍采集
`unraous/uxuescript`：模型返回无效 JSON 或答案不完整 → 自动重试失败批次；遇服务限流 → 自动等待并**降低本次求解的请求并发**；不允许整卷预览的考试 → 第一遍只采集题目、第二遍才填答案，避免"翻页丢题"。这套"两遍法"对任何分页/无预览的考试页面都适用。

### 11. 把平台封装成 MCP 工具给 AI 用（而不是给浏览器装脚本）
`Han-maker-wp/chaoxing-mcp`：单文件 ~400 行 Python，把 `xt_homework_all` / `xt_courses` / `xt_page_text` 暴露成 MCP 工具，AI 直接问"我还有啥作业没交"；登录用逆向出的 AES-CBC（`key = iv = u2oh6Vu^HWe4_AES`，PKCS7+Base64 POST 到 `/fanyalogin`）；cookie 落盘、掉线自动重登；实测 36 门课 0.3 秒。它的设计哲学写得极好：**"AI 只做辅助，提交权永远在人"，刻意不提供"提交作业"能力**。配套 `AGENTS.md` 让 AI 自己安装自己——这是 2026 年真正新的形态。

### 12. 协议优先于浏览器自动化
`cxOrz/chaoxing-signin`（1,779★）和 `kuizuo/chaoxing-sign`（211★）都用 protocol replay（Nuxt 全栈复现接口）而不是 Selenium：更快、更省资源、不受页面改版影响，但**必须跟着接口变**。反面是 `Mortal004` 那类 Selenium+pyautogui 方案，重但"页面怎么变都能点"。**取舍标准：读多写少（查询/签到）走协议，强交互（考试翻页/弹题）走浏览器。**

### 13. 多租户隔离与异步任务（面向"托管"场景）
`sweetcornna/university-helper`：每个用户一个独立 Postgres 库（不是同库加 user_id 字段），任务由后端异步执行，"关闭网页不中断"，Docker Compose 一键部署。做多账号托管时，**隔离级别决定了事故半径**。

### 14. 反向思路：伪造签到活动
`aquamarine5/ChaoxingSignFaker` 不去"签"别人的到，而是**自己伪造一场签到活动**，再让同学来"签"——一机可给任意多人签到，还能抓取人脸照片过人脸识别。技术上这是对平台签到模型最彻底的理解（它把"签到"抽象成可自建的活动对象）。**借鉴价值不在用法，而在它对领域模型的拆解方式。**

---

## 五、脚本市场安装量（GreasyFork / ScriptCat）

> GreasyFork 的搜索页（`/scripts?q=`）对非浏览器 UA 返回 **403**，本机无 Chromium 无法用浏览器兜底；但**「按站点」列表页与单脚本 JSON 可正常访问**，因此按 `chaoxing.com` / `yuketang.cn` / `zhihuishu.com` / `icourse163.org` 四个站点各取前 100 条（含 `data-script-total-installs` 属性），并用单脚本 JSON 复核。ScriptCat 走开放 API，`keyword=学习通` 共命中 **1,969** 个脚本。
> 注意：**total_installs 是历史累计**，跨年不可比；`daily_installs`（日新增）更能反映当下热度。

### GreasyFork（按 chaoxing.com 站点，累计安装降序，取前 12）

| 脚本 | 累计安装 | 日新增 | 最近更新 | 链接 |
|---|---|---|---|---|
| Muketool 超星学习通网课助手 | 3,583,405 | 44 | 2024-02-03 | https://greasyfork.org/zh-CN/scripts/426360 |
| 云上全平台（多平台+AI搜题） | 2,788,397 | 79 | 2026-10-24 | https://greasyfork.org/zh-CN/scripts/462689 |
| 超星学习通小助手（覆盖98%） | 2,481,831 | 12 | 2025-11-24 | https://greasyfork.org/zh-CN/scripts/435357 |
| **OCS 网课助手** | 2,457,585 | 95 | 2026-10-23 | https://greasyfork.org/zh-CN/scripts/457151 |
| 超星学习通｜知到智慧树 网课小助手 | 1,797,386 | **157** | 2026-10-25 | https://greasyfork.org/zh-CN/scripts/488083 |
| 超星学习通满分助手 | 1,741,066 | 24 | 2026-09-22 | https://greasyfork.org/zh-CN/scripts/436994 |
| 超星学习通助手[最强答题] | 950,803 | 11 | 2021-08-31 | https://greasyfork.org/zh-CN/scripts/424924 |
| 减负社区 超星学习通小助手 | 833,013 | 11 | 2025-03-05 | https://greasyfork.org/zh-CN/scripts/462748 |
| ABC 超星学习通｜智慧树网课助手 | 134,217 | 12 | 2026-06-04 | https://greasyfork.org/zh-CN/scripts/517884 |
| 超星学习通+AI自动答题 | 96,560 | 27 | 2024-12-23 | https://greasyfork.org/zh-CN/scripts/462323 |
| 学习通全能增强小帮手 | 11,359 | 28 | 2026-09-25 | https://greasyfork.org/zh-CN/scripts/552437 |
| 学习通学神助手（AI） | 1,179 | 24 | 2026-10-27 | https://greasyfork.org/zh-CN/scripts/585106 |

**读法**：OCS 的日新增（95）与 488083（157）是当前真实活跃度前二；累计安装最高的 Muketool 已经 2 年半没更新（2024-02-03），属于"历史存量"。

### 其他三个平台（GreasyFork 日新增靠前者）

| 平台 | 头部脚本 | 累计安装 | 日新增 | 最近更新 |
|---|---|---|---|---|
| 雨课堂 | OCS 网课助手 | 2,457,585 | 95 | 2026-10-23 |
| 雨课堂 | 雨课堂刷课助手 | 47,616 | 26 | 2026-09-02 |
| 雨课堂 | 雨课堂刷课+刷题助手 | 978 | 8 | 2026-03-08 |
| 智慧树 | 超星学习通｜知到智慧树 网课小助手 | 1,797,386 | 157 | 2026-10-25 |
| 智慧树 | 爱问答助手 | 1,079,211 | 6 | 2026-10-28 |
| 中国大学MOOC | HTML5 视频播放工具（通用倍速，非刷课） | 1,288,348 | 71 | 2025-08-06 |
| 中国大学MOOC | 中国大学MOOC-自动化 | 7 | 1 | 2026-10-22 |

**观察**：雨课堂/智慧树/中国大学MOOC 的专用脚本体量比学习通小 1~2 个数量级（雨课堂头部仅 4.7 万累计），说明**学习通是唯一形成"脚本产业"的平台**，其余平台仍是零散脚本；OCS 靠"一个脚本覆盖六个平台"吃掉了这些长尾。

### ScriptCat（`keyword=学习通`，共 1,969 个脚本，累计安装降序）

| 脚本 | 累计安装 | 今日安装 |
|---|---|---|
| 🐮ABC超星学习通｜智慧树网课助手 | 2,464,483 | — |
| 超星学习通九九助手[AI答题][一键启动][最小化运行] | 2,400,622 | — |
| ChatGPT学习通作业考试助手 | 1,893,436 | — |
| 🥇超星学习通｜知到智慧树 网课小助手 | 1,095,343 | — |
| Easy 网课学习助手 | 350,442 | — |
| 学习通学习助手（免费题库） | 36,441 | **681** |
| BZM超星学习通挂机助手 | 35,399 | — |
| AI六边形（多平台智能答题） | 10,457 | — |

**注**：ScriptCat 的 `today_install` 仅部分脚本返回，故多数留空；`学习通学习助手`（id 5717）今日 681 次安装、累计 3.6 万，是典型"新脚本高速增长"曲线，其描述里已经写明"字体解密、随机延迟作答、随机跳转章节、真实点击"——**新入场者的默认配置就是 L3**，说明对抗门槛已经下放。

---

## 六、空白与机会

1. **computer-use / GUI Agent 完全空白**。11 组关键词、630 个去重结果（437 个与网课主题相关）里，没有一个是"截图→视觉定位→点击"的通用 GUI Agent 形态；全部是 DOM 级或协议级。原因是学习通是 Web/App 双端且风控盯行为，视觉方案的延迟与误点率不划算。**但这也是唯一能同时吃下"Web 改版 + App 端 + 桌面客户端"三端的路子**，谁先做出来谁吃掉长尾。
2. **MCP 化刚起步，且都只做"只读"**：`chaoxing-mcp`（11★，2026-09）、`xuexitong-cli`（18★，2026-09）都把能力限制在查询，刻意不提供提交。**"读 + 建议 + 人工确认"是被验证过的最小风险形态**，值得直接抄。
3. **答题质量无人量化**：没有任何项目给出可复现的正确率基准（题库命中率、AI 正确率、题型分布）。`uxuescript` 的"全 A"事故、`DaRin1403` 的"假成功"都因为没有离线评测集。**谁先建一个"题目+标准答案+解密后题面"的回归集，谁就能真正把正确率做上去**（`tzg-nz` 的 `tests/` 是最接近的雏形）。
4. **跨平台适配是 OCS 的护城河**：单个脚本覆盖 6 平台 + 桌面端，长尾平台（雨课堂/职教云/智慧职教）专用脚本加起来都打不过它。**做多平台适配层的边际收益远高于把单平台做到极致。**

---

## 七、数据说明与局限（务必连同结论一起读）

1. **star 是匿名 API 在 2026-10-28 21:37 的瞬时值**，随时会变；`pushed_at` 只代表"最近一次 push"，不代表"最近一次可用"——很多项目 push 的是 README。
2. **fork 数存在异常**：`lispringing/SuperStar` 433★ / **707 fork**（fork 比 star 还多），高度疑似刷 fork 或镜像转发，不宜作为质量信号。
3. **已归档（archived:true）的三个项目**：`CodFrm/cxmooc-tools`（2,724★，2022 年停更）、`cxOrz/chaoxing-signin`（1,779★）、`bclswl0827/Fuck-ChaoXing`（55★）。归档项目仍在被大量引用/分发，**用之前必须确认接口是否还活着**。
4. **API 限流导致的口径差异**：匿名 API core 限额 60/h 很快耗尽，本报告的仓库元数据全部来自 search 接口返回的完整 repo 对象（与 repos/{owner}/{repo} 字段一致），issue 标题来自 `search/issues`（按创建时间倒序，每仓前 15 条）。**未逐仓核对全部 issue**，只看了最近三个月的高频失效模式。
5. **未能访问的部分**：GreasyFork 搜索页 403（Cloudflare），已用「按站点」页 + 单脚本 JSON 替代，覆盖 chaoxing/yuketang/zhihuishu/icourse163 四站各前 100 条；ScriptCat 的 `today_install` 字段仅部分返回。**没有对任何脚本做实际运行验证**，所有"核心能力"来自 README/官方文档自述，存在夸大可能。
6. **合规提示**：学习通官方已声明以 AI/大数据监控刷课并可通报高校；`DaRin1403`、`tzg-nz`、`Trial` 类项目均在 README 标注"可能警告至开除学籍"。**本报告仅作技术横评，不构成使用建议。**

---

### 附：原始数据文件（同目录）

| 文件 | 内容 |
|---|---|
| `all_repos.tsv` | 630 个去重仓库全字段（star/fork/lang/pushed/created/archived/issues/license/url/desc） |
| `selected_meta.csv` | 165 个入选项目元数据 |
| `raw/q01~q11.json` | 11 组关键词的 GitHub 原始响应 |
| `readmes/*.md` | 30 个项目的 README 原文 |
| `issues/*.json` | 14 个项目的最近 issue 列表 |
| `greasyfork.txt` | GreasyFork 四站点各前 10 条（安装量/日新增/更新时间） |
| `scriptcat_raw.json` | ScriptCat 搜索原始响应（1,969 条） |

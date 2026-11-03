# 架构说明

> 面向要改这个脚本的人。读完应该能回答：它每个 tick 在干什么、为什么视频在 iframe 里也能控制、
> 「完成」到底是怎么判的、以及为什么加了这么多熔断和节流。

## 1. 整体形态

单文件 IIFE（`xuexitong-assistant.user.js`），无构建、无依赖。运行时在**每一个**匹配
`*://*.chaoxing.com/*` 的框架里各跑一份实例，靠 `IS_TOP` 区分顶层与子框架。

```text
┌─ 顶层实例 (IS_TOP) ─────────────────────────────┐
│ 面板 HUD / 配置 / 计数 / 目录跳转 / 跨课         │
│ allDocs() 跨同源 iframe 找 video、audio、题目    │
└──────────┬─────────────────────────────────────┘
           │ postMessage: STATS / WORK_STATS / NEXT / RELOAD
┌──────────▼──────────┐   ┌──────────────────────┐
│ cards iframe        │   │ video iframe          │
│ 任务点 .ans-job-icon│   │ <video> 播放器         │
└─────────────────────┘   └──────────────────────┘
```

**所有权仲裁**：顶层与子框架可能都能看到同一个 `<video>`。子框架每 tick 通过 `STATS` 上报，
顶层把收到的时间记在 `lastChildStatsAt`；只要它在 4 秒内，顶层就**主动不驱动**（`pickLocalVisibleVideo`
直接返回 null）。心跳断了顶层才接手。没有这条规则时，父子两套实例会各自 play/pause，表现为"视频一直在开始/暂停"。

## 2. 每个 tick 做什么

`mainTick()` 每秒执行一次，顺序固定：

| 顺序 | 函数 | 职责 |
|---|---|---|
| 0 | `faceGuardActive()` | 人脸核验探测。命中则暂停视频、**跳过后面所有 tick**，等人处理 |
| 1 | `tryResume()` | 断点续刷：跳回上次小节（每次加载只尝试一次） |
| 2 | `tickVideo()` | 视频进度、倍速上限、拟人化、播放节流、完播与跳转判定 |
| 3 | `tickQuiz()` | 视频弹题作答 |
| 4 | `tickWork()` | 章节测验 / 作业 |
| 5 | `tickDoc()` | 文档 / PPT 等非视频任务点：逐步滚动推进 |
| 6 | `tickAudio()` | 音频任务点：限频播放 |
| 7 | `tickDiag()` | 每 5 秒统计本页任务点类型与题目数，写入面板 |
| 8 | `saveResumePoint()` / `markVisitedCourse()` | 记录断点与「进过哪些课」 |
| 9 | `tryChainOnListPage()` | 课程链在课程列表页的另一半 |
| 10 | `tickEmptySection()` | 空小节（暂无内容）自动跳过，带频率上限 |
| 11 | `tickDaily()` | 平台日上限探测 + 本地计数 |
| 12 | `warmFont()` | 字体解码预热 |

`tickVideo` / `tickDoc` / `tickAudio` 都以 `if (!CFG.enabled) return;` 开头——面板点「暂停」
或抖动熔断后，任何任务点都不得再被驱动。这条曾经漏过，是个真 bug（见 v4.0.0 changelog）。

## 3. 跨 iframe 模型

- `allDocs()`：从 `win.top.document` 与本地 `document` 出发，递归同源 `<iframe>`（深度 ≤ 6），
  返回文档数组。跨域一律 try/catch 跳过。
- 跨文档元素判可见时，`getComputedStyle` 必须用**元素自己的** `ownerDocument.defaultView`；
  用本地 `window` 会拿到错值甚至抛错（v3.0.0 修的就是这个）。
- 新泛雅把播放器放在 `ananas/modules/video/index.html`，**顶层文档里一个 `<video>` 都没有**。
  所以视频查找必须跨文档，否则面板永远"未检测到"。

## 4. 「完成」是怎么判的

判定链（`sectionCompleted`）：

1. 目录当前节点里有 `.icon_Completed` → 完成（旧版权威信号）；
2. 任意文档里有 `.ans-job-finished` → 完成；
3. `jobIconsFinished()`：`.ans-job-icon` 的
   - `aria-label` / `title` 含「未完成 / 未看 / 未学」→ **不算完成**；
   - 含「已完成 / 完成 / 已看」→ 完成；
   - 都没有文案时，**classes 里没有 `ans-job-icon-clear` 即视为完成**（新版实测形态）。

顺序要紧：先判「未完成」，否则 `/完成/` 会把「未完成」也匹配上。

## 5. 存储键（GM storage）

| 键 | 内容 |
|---|---|
| `cfg` | 全部配置（含 `enabled`、倍速、AI Key 等）。熔断时会把 `enabled` 写回 false |
| `bank` | 导入的题库 |
| `resume_v1` | 断点：`{ id: chapterId, at: 时间戳 }` |
| `visitedCourses_v1` | 课程链用：进过的 courseId 集合 |
| `hudCollapsed` | 面板折叠态 |

## 6. 失败模式与防护

每一道防护都对应一次真实的翻车：

| 防护 | 触发条件 | 为什么需要 |
|---|---|---|
| 播放节流 `controlGapMs` | 播放类动作间隔 ≥ 4 秒；合成点击只在前 2 次 | 平台一暂停，每秒抢一次控制权 = 每秒拉锯，最像机器人 |
| 抖动熔断 `flapMaxPerMin` | 60 秒内 play/pause 切换 > 12 次 | 3.2.2 修了具体成因，但任何后续改动都可能重新引入；这是兜底网。**熔断不自动恢复**，否则会变成循环 |
| 空节跳过 `emptyMaxJumps` | 10 分钟最多跳 5 次 | 整章未发布时连环跳同样像机器人 |
| 单端纪律 `singleSession` | 检测到别的标签在播就让路 | 多端并发是平台明确的风控点 |
| 人脸核验 | 命中遮罩即暂停 | 不绕过；绕了既违规也会让任务点被判无效 |
| 断点只跳一次 | `resumeTried` | 反复跳转是风控触发器 |

## 7. 测试策略

单元测试不启动浏览器：用 `vm` + 手搓假 DOM 把脚本跑起来，通过 `__CXAS_DEBUG` 拿内部函数直接驱动。
这样能精确构造"平台把视频暂停了""音频已完成但被暂停""60 秒窗口过期"这类真浏览器里难复现的时序。

浏览器 e2e（`*.e2e.test.js`）需要 Edge + CDP，跑得慢且依赖本机环境，默认不在 CI 里跑。

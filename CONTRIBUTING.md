# 贡献指南

这个项目是单文件油猴脚本（`xuexitong-assistant.user.js`，约 4600 行），没有构建步骤、没有外部依赖。
所有测试也能只用 Node 直接跑。下面是改代码前需要知道的约定。

---

## 1. 环境

| 需要 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（开发机为 v24） | 只用于跑测试，脚本本身在浏览器里运行 |
| 浏览器 | Edge / Chrome + Tampermonkey 或 ScriptCat | 手动验证用 |

```bash
node --check xuexitong-assistant.user.js   # 语法检查
node tests/pure.test.js                    # 跑单个测试
```

## 2. 测试

**新增逻辑必须有单测。** 全量 12 套、403 项断言，任何一套失败都不应提交：

```bash
for t in pure cmap workkind fingerprint daily video-completion scroll smoke doc-face resume-chain ai-quality v4-core; do
  node tests/$t.test.js || echo "FAIL: $t"
done
```

测试套路（见 `tests/doc-face.test.js`、`tests/resume-chain.test.js`）：

- 用 `vm.createContext` 造一个假 `window` / `document`，然后 `runInContext` 把整个用户脚本跑起来；
- 让 `GM_getValue('cfg')` 返回 `{ verbose: true }`，脚本才会挂载 `window.__CXAS_DEBUG`，
  从里面取内部函数（`tickVideo` / `tickDoc` / `tickAudio` / `noteFlapEvent` …）直接驱动；
- 假 DOM 需要按需实现 `querySelector` / `querySelectorAll` / `classList` / `getBoundingClientRect` / `closest`。

**写断言时注意实现细节**，否则容易写成假阳性：

| 坑 | 说明 |
|---|---|
| `Number(x) \|\| 默认值` | 会把合法的 `0` 当 falsy 吃掉。本仓库统一用 `Number.isFinite(x) && x >= 0` 判断 |
| 顶层让位 | 顶层若检测到子框架实例有心跳（`lastChildStatsAt` 在 4 秒内），会主动不驱动视频/音频 |
| 总开关门禁 | `tickVideo` / `tickDoc` / `tickAudio` 都以 `if (!CFG.enabled) return;` 开头 |
| 节流 | 播放类动作受 `controlGapMs`（默认 4000）限制，连调两次不会都生效 |

## 3. 代码约定

- **注释用中文，标识符和 commit message 用英文。**
- 注释写**为什么**，不写"这行在做什么"。尤其是踩过的坑：把当时的错误现象和判据一起写进去，
  否则下一个人（或下一个模型）会把它改回去。
- 选择器一律**多路兜底**，并且注明依据（实测 / 上游源码 / 未证实）。未证实的不要写成默认行为。
- 不要引入构建工具、不要拆成多文件——单文件是这个项目能在 ScriptCat / Tampermonkey 里一键安装的前提。
- **批量改脚本时注意换行符**：仓库文件是 LF（idea 里 checkout 成 CRLF）。用 PowerShell 做多行字符串替换时，
  若脚本里的换行与文件不一致，-replace 会**匹配不到**；更糟的是锚点写宽了会一次吃掉整段代码。
  实际踩过的坑：一次 CRLF 匹配跑偏，把整个 	ickVideo() 函数删掉了。**优先用 dit 工具；
  必须脚本化时用单行锚点，并在替换前断言锚点命中次数恰好为 1。**

## 4. 合规红线（不可协商）

以下功能**不接受** PR，也不要在 issue 里请求：

- 绕过或模拟人脸识别、滑块验证码；
- "秒刷"、直接调用完成接口、伪造心跳或观看时长；
- 拖拽/倍数作弊以骗过平台的时长校验；
- 考试自动交卷、多端并发刷同一账号。

原因不是道德说教，而是**它们已经被验证会失效并且会连累账号**：
绕人脸在 2026-09 已被平台封堵，"直接打 complete"会被判时长≈0 且事后补不回来。
证据与日期见 `research/beyond-v4.md` 与 `research/risk-and-tech.md`。

## 5. Git

- **不擅自 push。** 提交用单次身份参数，不改全局 git config：

```bash
git -c user.name=<name> -c user.email=<email> commit -m "fix: ..."
```

- commit message 用英文，格式 `type: 摘要`，type 取 `feat` / `fix` / `docs` / `test` / `chore`。
- 提交前自检有没有把密钥带进去：

```bash
git diff --cached | grep -Ei "apikey|password|token|private key|sk-"
```

- **不要把 API Key 写进代码或 README**，让它留在浏览器本地存储里。

## 6. 改行为前先想清楚

这个脚本跑在别人的真实账号上，一次错误的行为可能就是一次平台风控。所以：

1. 任何"多做一些动作"的改动，先问一句**它会不会让机器特征更明显**；
2. 新增自动跳转/点击时，**必须带上频率上限**（参考 `emptyMaxJumps`、`flapMaxPerMin`）；
3. 拿不准的选择器，宁可默认不启用，也不要默认乱点。

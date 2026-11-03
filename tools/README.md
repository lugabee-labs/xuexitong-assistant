# tools/ — 辅助脚本

本目录放的是**跑脚本前后用的配套工具**，不参与油猴脚本本体（`xuexitong-assistant.user.js`）的运行。

---

## `start-edge.ps1` — 反节流 Edge 启动器

### 什么场景用

只要你会**离开电脑、但让刷课继续跑**，就该用这个脚本启动浏览器：

- 远程桌面（RDP / 向日葵 / ToDesk / RustDesk）**断开后**继续挂机；
- 把浏览器窗口**最小化**，或让它被别的窗口盖住；
- 双屏/外接显示器**关掉副屏**后继续挂机；
- 锁屏、切到别的虚拟桌面等一切「窗口看不见但还想让它播」的情况。

典型症状：断开远控一会儿回来，视频**黑屏**、面板显示**「已暂停」**，`currentTime` 卡住不动，但
`readyState`、`error` 都正常——这时候点播放也救不回来，只能重开。

### 为什么需要这些参数

断连远控后，Windows 侧没有真实的画面合成输出，会把浏览器窗口报告成「被遮挡」（occluded）。
Chromium 收到这个信号后按「后台页面」处理：**节流定时器**（`setTimeout`/`setInterval` 降到约 1 次/分钟）
并**降级/暂停渲染进程**，媒体解码随之停摆。脚本层再怎么 `play()` 都救不回来。

脚本固定带上的五个参数，逐一对应这条链路：

| 参数 | 作用 |
| --- | --- |
| `--disable-background-timer-throttling` | 不节流后台定时器。脚本的轮询、心跳、进度上报靠的就是它。 |
| `--disable-renderer-backgrounding` | 不把后台标签页的渲染进程降优先级，避免解码线程被饿死。 |
| `--disable-backgrounding-occluded-windows` | 窗口被判为「被遮挡」时，不按后台处理。 |
| `--disable-features=CalculateNativeWinOcclusion` | 直接关掉 Windows 原生遮挡计算这一特性——从源头上不再让系统告诉 Chromium「你被盖住了」。断连 RDP 时最关键的一条。 |
| `--restore-last-session` | 启动时恢复上次会话的标签页，省得每次手动找回课程页面。 |

> 这组参数是实测能缓解问题的组合。它绕过的是**浏览器侧的节流**，不是平台侧的行为——
> 旧版播放器在页面无焦点时会主动 `pause`，那部分仍要靠脚本自己的 `pause` 监听重播兜住。

### 怎么用

```powershell
# 1) 最省事：恢复上次会话，不指定地址
pwsh -NoProfile -File .\tools\start-edge.ps1

# 2) 启动后直接打开指定页面
pwsh -NoProfile -File .\tools\start-edge.ps1 -Url 'https://i.chaoxing.com'

# 3) 只看看会执行什么命令，不真的启动浏览器（预览 / 自检）
pwsh -NoProfile -File .\tools\start-edge.ps1 -Url 'https://i.chaoxing.com' -WhatIf

# 4) Edge 装在非默认位置时手动指定
pwsh -NoProfile -File .\tools\start-edge.ps1 -EdgePath 'D:\Apps\Edge\Application\msedge.exe'
```

参数说明：

- `-Url`（可选）：启动后打开的地址。不传就只靠 `--restore-last-session` 恢复上次会话。
- `-EdgePath`（可选）：`msedge.exe` 完整路径。不传则自动探测：
  注册表 `App Paths\msedge.exe` → `Program Files` → `Program Files (x86)`。
- `-WhatIf`（标准 PowerShell 公共参数）：只打印完整命令行，**不启动浏览器**。

### 已有 Edge 在跑怎么办

脚本检测到 `msedge.exe` 进程时会**警告但不动手**：

> 参数只对「本次新启动的进程」生效。Edge 是单实例程序，新命令通常只是把地址转交给
> 现有进程，参数不会起作用。

正确做法：**手动**关掉所有 Edge 窗口，在任务管理器里确认 `msedge.exe` 全部退出，再运行本脚本。
脚本刻意不杀进程——避免误杀你正在用的窗口和标签页。

### 副作用与局限

- **内存/CPU 占用略高**：后台页面不再被降频、渲染进程保持活跃，比平时更「贪」一点资源。
- **笔记本续航略降**：同上，后台不被休眠。
- **仅本次启动生效**：参数是命令行级的，关掉 Edge 就失效，下次要重新走这个脚本。
  它不写注册表、不改组策略、不动环境变量，卸载 = 删文件。
- **不解决所有停摆**：只绕过浏览器节流。平台侧主动暂停、页面失焦协议、弹题打断等仍由油猴脚本负责。
- **多窗口同时播放会抢 CPU**：遮挡不再降级，多个标签同时播会比平时更吃机器。
- **不做的事**：不结束进程、不修改任何系统设置、不使用 winget、不访问学习通账号。

### 自检

不需要真的开浏览器，用 `-WhatIf` 就能验证语法与参数解析：

```powershell
pwsh -NoProfile -Command "& .\tools\start-edge.ps1 -Url 'https://i.chaoxing.com' -WhatIf"
```

预期输出里能看到 5 个反节流参数逐个列出、完整命令行、以及 `-WhatIf 模式：……未真正启动浏览器`。

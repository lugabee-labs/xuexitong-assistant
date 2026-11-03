<#
.SYNOPSIS
    用一组「反节流」Chromium 参数启动 Microsoft Edge，避免断开远程桌面后刷课停摆。

.DESCRIPTION
    断开远程桌面（RDP / 向日葵 / ToDesk 等）后，Windows 会把浏览器窗口判定为「被遮挡」
    （occluded）。Chromium 随即节流后台定时器并暂停媒体渲染，学习通视频表现为
    黑屏 + 面板「已暂停」，刷课停摆。

    本脚本固定带上以下五个参数启动 Edge（前四个是反节流，最后一个恢复上次会话）：

        --disable-background-timer-throttling
        --disable-renderer-backgrounding
        --disable-backgrounding-occluded-windows
        --disable-features=CalculateNativeWinOcclusion
        --restore-last-session

    只影响本次启动的浏览器进程：不修改注册表、组策略、环境变量或任何系统设置，
    也不会结束任何已有进程。

.NOTES
    工程约定：
      * 本脚本刻意不设置 Set-StrictMode / $ErrorActionPreference 之类的会话级开关，
        避免被 dot-source（. .\tools\start-edge.ps1）时污染调用方会话；
        所有可能失败的地方都用显式 -ErrorAction，硬失败一律 throw。
      * 本脚本不负责结束 Edge 进程：需要干净的单实例时由用户手动关闭。

.PARAMETER Url
    启动后要打开的地址（可选）。不传则只依赖 --restore-last-session 恢复上次会话。

.PARAMETER EdgePath
    msedge.exe 的完整路径。不传则自动探测：
    注册表 App Paths → Program Files → Program Files (x86)。

.EXAMPLE
    pwsh -NoProfile -File .\tools\start-edge.ps1

.EXAMPLE
    pwsh -NoProfile -File .\tools\start-edge.ps1 -Url 'https://i.chaoxing.com'

.EXAMPLE
    # 只打印将要执行的命令行，不启动浏览器（自检 / 预览用）
    pwsh -NoProfile -File .\tools\start-edge.ps1 -Url 'https://i.chaoxing.com' -WhatIf

.EXAMPLE
    # 指定 Edge 路径（装在非默认位置时）
    pwsh -NoProfile -File .\tools\start-edge.ps1 -EdgePath 'D:\Apps\Edge\Application\msedge.exe'
#>

# 注释帮助块必须放在文件最前面，才能被 Get-Help 识别；#Requires 放在其后即可（同样会在执行前生效）
#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # 启动后要打开的地址，可选
    [Parameter(Position = 0)]
    [string]$Url,

    # msedge.exe 路径，可覆盖自动探测结果
    [string]$EdgePath
)

# ---------------------------------------------------------------------------
# 固定的反节流参数。这组是实测有效的，顺序无所谓，但不要随意删减。
# ---------------------------------------------------------------------------
$script:AntiThrottleArguments = @(
    '--disable-background-timer-throttling'
    '--disable-renderer-backgrounding'
    '--disable-backgrounding-occluded-windows'
    '--disable-features=CalculateNativeWinOcclusion'
    '--restore-last-session'
)

function Resolve-EdgeExecutable {
    <#
    .SYNOPSIS
        定位 msedge.exe 的完整路径，找不到就抛错并给出可操作的提示。
    #>
    [CmdletBinding()]
    param(
        [string]$ExplicitPath
    )

    # 1) 用户显式指定：只认文件，不做任何路径猜测
    if ($ExplicitPath) {
        if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $ExplicitPath).ProviderPath
        }
        throw "指定的 -EdgePath 不存在或不是文件：$ExplicitPath"
    }

    # 2) 注册表 App Paths：跟着 Edge 实际安装位置走，最可靠
    $appPathKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
    try {
        $key = Get-Item -LiteralPath $appPathKey -ErrorAction Stop
        # 注册表默认值（未命名值）就是 exe 完整路径
        $fromRegistry = $key.GetValue('')
        if ($fromRegistry -and (Test-Path -LiteralPath $fromRegistry -PathType Leaf)) {
            return $fromRegistry
        }
    } catch {
        # 没有这个注册表键就继续往下探测，不算错误
    }

    # 3) 两个常规安装根目录（64 位优先）。路径带空格，一律用变量拼接，不手写字符串
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    foreach ($root in $roots) {
        $candidate = Join-Path -Path $root -ChildPath 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    throw '未找到 msedge.exe。请用 -EdgePath 显式指定，例如：-EdgePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"'
}

function Get-RunningEdgeProcessCount {
    <#
    .SYNOPSIS
        返回当前在跑的 msedge 进程数（含渲染/GPU 子进程）。只读，不结束任何进程。
    #>
    [CmdletBinding()]
    param()

    @(Get-Process -Name 'msedge' -ErrorAction SilentlyContinue).Count
}

function ConvertTo-CommandLineArgument {
    <#
    .SYNOPSIS
        按 Windows 命令行规则给单个参数补引号：只处理「含空白」和「含双引号」两种情况。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Argument
    )

    if ($Argument -match '[\s"]') {
        return '"' + ($Argument -replace '"', '\"') + '"'
    }
    return $Argument
}

function Wait-EdgeWindowTitle {
    <#
    .SYNOPSIS
        轮询等待 Edge 主窗口出现并返回标题；超时返回 $null（不抛错）。
    #>
    [CmdletBinding()]
    param(
        [int]$TimeoutSeconds = 20
    )

    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([datetime]::UtcNow -lt $deadline) {
        $title = Get-Process -Name 'msedge' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle } |
            Select-Object -First 1 -ExpandProperty MainWindowTitle
        if ($title) {
            return $title
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
Write-Host '=== 反节流 Edge 启动器 ===' -ForegroundColor Cyan

$edgeExe = Resolve-EdgeExecutable -ExplicitPath $EdgePath
Write-Host "Edge 可执行文件：$edgeExe"

# 组装参数：固定反节流参数 + 可选 URL
$argumentList = [System.Collections.Generic.List[string]]::new()
foreach ($item in $script:AntiThrottleArguments) {
    $argumentList.Add($item)
}
if ($Url) {
    $argumentList.Add($Url)
    if ($Url -notmatch '^[a-zA-Z][a-zA-Z0-9+.\-]*://') {
        Write-Host '  提示：-Url 看起来不是完整地址（缺少 http:// 或 https://），Edge 可能把它当成搜索词。' -ForegroundColor Yellow
    }
}

$quotedArguments = @($argumentList | ForEach-Object { ConvertTo-CommandLineArgument -Argument $_ })
$argumentString = $quotedArguments -join ' '
$commandLine = '"' + $edgeExe + '" ' + $argumentString

Write-Host ''
Write-Host "启动参数（$($argumentList.Count) 个）："
foreach ($item in $argumentList) {
    Write-Host "  $item" -ForegroundColor Gray
}
Write-Host ''
Write-Host '完整命令行：'
Write-Host "  $commandLine" -ForegroundColor Yellow

# 已有进程提醒：Chromium 是单实例程序，参数只对真正新建的浏览器进程生效
$runningCount = Get-RunningEdgeProcessCount
if ($runningCount -gt 0) {
    Write-Host ''
    Write-Warning "检测到已有 $runningCount 个 msedge 进程在运行。"
    Write-Host '  · 这些参数只对「本次新启动的进程」生效，已经在跑的 Edge 不会被改变。' -ForegroundColor Yellow
    Write-Host '  · 因为 Edge 是单实例程序，新命令通常只是把地址转交给现有进程，参数不会起作用。' -ForegroundColor Yellow
    Write-Host '  · 建议：手动关闭所有 Edge 窗口（任务管理器里确认 msedge.exe 全部退出）后，再运行本脚本。' -ForegroundColor Yellow
    Write-Host '  · 本脚本不会替你结束任何进程。' -ForegroundColor DarkGray
}

# -WhatIf 走 ShouldProcess，返回 $false 时只打印不启动
$action = '启动 Edge（带反节流参数）'
if (-not $PSCmdlet.ShouldProcess($commandLine, $action)) {
    Write-Host ''
    Write-Host '（-WhatIf 模式：以上为将要执行的命令行，未真正启动浏览器。）' -ForegroundColor DarkGray
    return
}

Write-Host ''
Write-Host '正在启动 Edge ...' -ForegroundColor Green
# -ArgumentList 传单个字符串：引号由本脚本自己处理，避免 PowerShell 再拼接一次
Start-Process -FilePath $edgeExe -ArgumentList $argumentString -ErrorAction Stop

Write-Host '等待 Edge 主窗口出现 ...' -ForegroundColor DarkGray
$mainWindowTitle = Wait-EdgeWindowTitle -TimeoutSeconds 20
if ($mainWindowTitle) {
    Write-Host "Edge 主窗口标题：$mainWindowTitle" -ForegroundColor Green
    Write-Host '请确认标题里是你要刷的课程页面。参数生效后，断开远程桌面也应继续播放。' -ForegroundColor DarkGray
} else {
    Write-Warning '20 秒内没有读到 Edge 主窗口标题。可能窗口还没画出来，或命令被转交给了已有实例。请手动看一下任务栏。'
}

Write-Host ''
Write-Host '提示：验证方式是断开远程桌面 1~2 分钟后回来看面板是否仍显示「播放中」。' -ForegroundColor DarkGray

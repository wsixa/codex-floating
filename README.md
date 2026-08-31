# Codex 桌面悬浮助手

Codex 桌面悬浮助手是一个适用于 Windows 10/11 的本地 Electron 工具。它支持两种连接方式：官方 Codex 登录（持久化 Playwright Chromium 会话）和 CCSwitch 路由同步。CCSwitch 模式通过官方 `codex app-server` 创建、恢复和删除真实 Codex 线程；模型请求仍由 Codex 配置中的 CCSwitch 路由发送。因此悬浮助手、Codex Desktop 和 Codex CLI 看到的是同一套会话。屏幕由 Electron 在本地捕获，上传由当前 Codex 传输层完成。

## 环境要求

- Windows 10 或 Windows 11（需要在已登录的桌面会话中运行）
- Node.js 20 及以上（已使用 Node `22.16.0` 测试）和 npm 10 及以上
- API/CCSwitch 模式：本机已运行 CCSwitch，并安装官方 Codex CLI/Desktop；不需要在助手中填写 API Key
- Playwright 网页模式：Codex/ChatGPT 账号和可交互的桌面会话

## 启动助手

应用连接方式不通过启动参数区分，统一使用同一个启动命令。首次启动默认选择 `CCSwitch API`，之后会记住你在软件内的选择。所有命令都在 PowerShell 中执行，并保持该窗口不要关闭。

1. 确认 CCSwitch 正在运行。你的当前地址是 `http://127.0.0.1:15721`：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:15721/health
```

返回 HTTP `200` 且 JSON 中有 `"status":"healthy"` 才继续。若未运行，先启动 `D:\ccswitch\cc-switch.exe`。

2. 安装项目依赖（首次运行或 `node_modules` 被删除后执行）：

```powershell
Set-Location D:\codex-platform
npm install
# API/CCSwitch 模式可跳过；切换到网页 + Playwright 模式时再执行
npx playwright install chromium
```

如果 `Test-Path .\node_modules\electron\dist\electron.exe` 返回 `False`，再执行 `npx install-electron --no` 下载 Electron 运行时；文件已经存在时不需要重复下载。

3. 启动悬浮助手：

```powershell
Set-Location D:\codex-platform
npm run dev
```

启动脚本会先编译主进程，再启动 Vite 和 Electron。若 `5173` 被占用，它会自动选择 `5174`、`5175` 等下一个端口，并把正确地址传给 Electron。看到 `VITE ... ready` 后，悬浮窗口应出现在屏幕右上方；不要在浏览器中打开 Vite 地址来代替 Electron 窗口。

CCSwitch 模式会连接官方 Codex app-server，不会要求在助手中登录 Codex 网页。窗口状态会显示 Codex 客户端同步，消息输入框顶部的模型下拉框来自官方 app-server；选择模型后会立即保存并重新连接。CCSwitch 内部地址和凭据不会显示在助手中。

在软件中打开 `设置`，通过 `连接方式` 下拉框切换 `CCSwitch API` 与 `官方 Codex 登录`。切换会立即断开旧连接、连接新方式并持久化，不需要重启。官方模式现在是“悬浮窗口外壳 + 官方页面内嵌”：BrowserView 承载官方 Codex 页面，主进程通过现有 Playwright/CDP 连接执行操作，并注入精简 CSS/JS 隐藏侧边栏、顶部栏和右侧面板，只保留官方消息流、输入框和原生交互。历史消息、会话导航、标题和滚动完全由官方页面维护，助手不再复制消息列表或缓存消息。工具栏中的新建、重新连接、打开官方页面、截屏和设置按钮仍通过 IPC/CDP 调用官方能力。BrowserView 只会在页面加载并完成精简注入后挂载；加载失败、超时或渲染进程退出时会立即卸载，因此工具栏和错误信息不会再被空白视图覆盖。Playwright 持久化会话的 Cookie 仅在 Electron 主进程内同步给内嵌页面，不会广播到 renderer 或写入日志。CCSwitch/app-server 仍作为 API 模式的回退路径；模型来源按 `/v1/models` 与 Codex catalog 合并，失败时不影响已建立的会话。

### 切换界面语言

打开悬浮窗的 `设置`，在 `语言` 下选择 `中文` 或 `English`。选择会立即应用并保存到 `%APPDATA%\codex-floating-assistant\config.json`，下次启动会恢复上次选择。语言设置影响助手界面和本地新会话摘要语言，不会翻译 Codex 页面已有标题或发送给模型的用户内容。

4. 生产模式（不启动 Vite 热更新）：

```powershell
Set-Location D:\codex-platform
npm run build
npm start
```

配置文件保存于 `%APPDATA%\codex-floating-assistant\config.json`；CCSwitch 的凭据不会复制到助手配置或日志中，API 地址和密钥状态不会随状态广播返回给悬浮窗渲染进程。

如需连接非本机的 OpenAI 兼容网关，可在启动终端通过 `OPENAI_BASE_URL` 和 `OPENAI_API_KEY` 注入配置；这些字段仍不会在助手界面展示。CCSwitch 本地模式不需要设置它们。

### 连接方式切换

官方模式首次使用时，在设置中选择 `官方 Codex 登录`，点击 `Open Codex` 并在弹出的受控浏览器中手动登录，再点击 `Reconnect`。登录状态保存在 Electron 用户数据目录的 `playwright-profile` 中。以后可以直接在设置中切回 `CCSwitch API`。

`CODEX_TRANSPORT` 不再覆盖配置，即使当前 PowerShell 中残留旧变量，软件内选择仍然优先。CCSwitch 模式支持文本、全屏截图、自定义区域截图和连续截图；`New` 会通过 `thread/start` 创建真实 Codex 线程，`Sessions` 通过 `thread/list` 读取官方历史。应用重启后会用保存的 thread id 恢复上次会话；在 Codex Desktop 或 CLI 中新建、重命名、归档/删除的线程会在助手刷新后同步显示。

开发服务器默认使用 `5173` 端口。如果该端口已被其他程序占用，启动脚本会自动从 `5173` 开始选择下一个可用端口，并将同一端口传给 Electron。也可以在 PowerShell 中手动指定起始端口：

```powershell
$env:VITE_PORT = 5200
npm run dev
```

## 使用助手

- 输入消息后按 `Ctrl+Enter`，或点击发送按钮。
- 输入框左下角的 `+` 是附件入口：可选择 `截取全屏`、`框选区域` 或 `上传文件`。截图会先生成缩略图，普通文件会显示文件名和大小；附件会留在输入框上方的草稿区，确认问题后再点击发送。每次最多 8 个附件，单个文件不超过 15 MB，总大小不超过 20 MB；点击卡片右侧的 `×` 可移除附件。
- 新会话发送第一条文本或截图时，会先在本地同步生成不超过 48 个字符的内容摘要作为会话名称，再执行网络发送；因此名称不会等待模型回复或网页历史侧栏刷新。已有会话名称不会被后续消息反复覆盖。
- 附件菜单中的 `截取全屏` 会捕获主显示器画面，`框选区域` 会暂时隐藏助手并显示全屏选区层；按住鼠标拖动出矩形，松开后生成截图预览，按 `Esc` 或右键可取消。点击发送后图片才会上传到当前 Codex 会话。系统托盘触发的截屏仍保持“截图后立即发送”的快捷操作。
- `New` 会通过 CDP 点击官方新建会话。历史会话和删除/归档等操作直接使用官方页面原生控件，不在助手中渲染副本。
- `Reconnect` 会在页面或浏览器崩溃后重新打开持久化浏览器上下文。`Open Codex` 会将受控页面置于前台，便于登录或排查页面结构问题。
- CCSwitch 模式不打开 Chromium；`Reconnect` 会重新连接官方 app-server 并刷新模型列表，发送失败时会在状态栏显示 Codex/CCSwitch 错误。若 app-server 无法启动，助手会明确提示安装或更新 Codex CLI/Desktop，而不会伪造本地会话。
- 完整窗口标题栏提供原生最小化和退出两个标准按钮。原生最小化会把窗口收回 Windows 任务栏并保留任务栏图标；`×` 会释放资源并完全退出进程，不再隐藏到后台。迷你模式可从系统托盘菜单进入；进入后窗口会变为 260×64 的独立紧凑栏，显示 `迷你/MINI` 标识、连接圆点、展开、最小化和退出按钮；点击展开图标即可返回完整布局。
- 偏好设置会持久化到 Electron `userData` 目录下的 `config.json`。截图入口位于输入框附件菜单和系统托盘，不注册系统级快捷键。

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run smoke:api
npm run perf
$env:RENDERER_ATTACHMENTS = "1"; npm run screenshot
```

需要验证真实 Electron 窗口的最小化和完全退出时，可在一个 PowerShell 窗口启动带 CDP 的开发实例，再在另一个窗口运行冒烟脚本：

```powershell
$env:ELECTRON_CDP_PORT = "9230"
npm run dev
# 另一个 PowerShell 窗口
npm run smoke:electron
```

开发脚本只在设置 `ELECTRON_CDP_PORT` 时开启远程调试端口，普通启动不会暴露该端口。

`smoke` 使用本地模拟 Codex 页面验证页面打开、基于语义定位的输入框/发送按钮检测、图片和普通文件上传、新建对话和历史会话切换，不需要账号凭据。`smoke:api` 使用本地 HTTP 模拟 Responses API 验证文本、图片 data URL、响应链和会话切换，并故意延迟首个响应来确认会话摘要在响应到达前已经可见。`perf` 会针对同一个模拟页面连续发送 20 次上传，并报告适配器/上传路径的 p95 耗时，以及测试工具自身的启动、RSS 和 CPU 样本。`RENDERER_ATTACHMENTS=1 npm run screenshot` 会验证附件菜单、截图缩略图和普通文件卡片。它们不代表完整 Electron 进程、Windows 桌面截图或真实 Codex/API 网络模型延迟的测量结果。

要单独检查迷你模式的 260×64 布局，可先启动 `npm run dev` 或 `npx vite preview --host 127.0.0.1 --port 4173`，再运行：

```powershell
$env:RENDERER_MINI = "1"
npm run screenshot
```

脚本会生成 `output/playwright/renderer-mini.png`，并断言文档没有超出窗口、存在 `迷你/MINI` 标识以及展开按钮可用。

最新一次本地样本（`output/performance/report.json`，Windows `win32 x64`，Chromium headless mock Codex）记录如下：启动耗时 `343 ms`，测试工具空闲 RSS `131.1 MB`，测试工具空闲 CPU `1.5%`，连续 20 次消息发送且失败 `0` 次，上传 p95 为 `51 ms`，平均耗时为 `42 ms`。这些数值仅用于诊断；在已登录的桌面环境中完成实际测量前，不宣称 Electron 和真实 Codex/API 端到端指标已经达标。

## 架构

```
src/
  main/
    main.ts              生命周期、类型化 IPC、状态广播
    window-manager.ts    无边框置顶窗口、迷你模式、窗口边界
    tray-manager.ts      Windows 系统托盘菜单
    capture-service.ts   全屏/区域截图和压缩
    capture-selection.ts 全屏鼠标拖拽选区窗口
    capture-selection-preload.ts 选区窗口的最小化 IPC 桥接
    attachment-service.ts 文件选择、大小校验、图片缩略图和附件 IPC 数据整形
    codex-app-server.ts   官方 Codex app-server JSON-RPC、线程同步、模型与附件输入
    api-service.ts        兼容 Responses API 的独立诊断/回退服务（不作为默认同步通道）
    playwright-service.ts 持久化浏览器上下文生命周期和状态
    official-page-host.ts Electron BrowserView 生命周期、会话同步和精简 CSS/JS 注入
    codex-adapter.ts      Codex 语义化选择器和页面操作
    config-service.ts    默认值、校验、原子化持久化
  preload.ts             隔离上下文中的类型化桥接
  renderer/              React 工具栏壳、API 回退输入和中文/英文语言包
    i18n.ts               中文/英文文案及运行时错误本地化
  shared/types.ts          IPC 契约、状态模型、校验器（含语言配置）
scripts/                    确定性的 Playwright 冒烟/性能脚本
```

## 故障排查和限制

- 如果缺少 Chromium，请运行 `npx playwright install chromium`。
- 如果 Electron 报告 CDN/网络错误，说明 JavaScript 依赖已安装但 Electron 运行时压缩包没有下载完成。下载需要能访问 npm registry 和 GitHub Release CDN（至少 `registry.npmjs.org`、`github.com`、`objects.githubusercontent.com` 的 HTTPS）；可先用 `Test-NetConnection github.com -Port 443` 检查，再在允许下载的网络中重新运行 `npx install-electron --no`。只有 `node_modules/electron/dist/electron.exe` 存在后，`npm start` 才能启动。
- 如果运行后只有空白的 Electron 窗口，先按 `Ctrl+C` 结束旧的 `npm run dev`，再执行下面命令清理仅属于本项目的残留 Electron 进程，然后重新启动：

  ```powershell
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq 'D:\codex-platform\node_modules\electron\dist\electron.exe' } |
    Stop-Process -Force
  npm run dev
  ```

  本项目已默认关闭 Electron GPU 加速，并在 renderer 加载完成后强制显示窗口；启动日志应出现 `window ... visible=true` 或 `VITE ... ready`。内嵌页失败时外壳仍会保持可见，并在底部显示 `Embedded Codex page failed to load`，可以点击重新连接重试。如果仍失败，请检查终端中的 `[official-page] load failed`、`Renderer load failed`、`Preload failed` 或 `GPU process` 行。
- 如果 `5173` 被占用，不需要手动修改代码；启动脚本会自动使用下一个可用端口。也可以先设置 `$env:VITE_PORT = "5200"`。
- 如果状态显示 `Sign in required`，请点击 `Open Codex`，手动完成登录，然后点击 `Reconnect`。日志不会写入凭据、Cookie、Token、完整对话或原始截图。
- 如果使用 CCSwitch 模式并显示 `Codex CLI was not found` 或 app-server 连接错误，请确认官方 Codex Desktop/CLI 已安装、`codex` 命令可用，并确认 CCSwitch 正在运行，然后点击 `Reconnect`。助手设置不会显示 CCSwitch 地址、路由或凭据。
- CCSwitch 模式的请求由官方 app-server 根据 `%USERPROFILE%\.codex\config.toml` 发送；助手不会在界面中显示路由地址或凭据。模型列表通过 app-server 的 `model/list` 读取，使用的是 Codex 当前实际可用的模型，而不是助手源码中的固定名单。app-server 启动时会清理 Codex Desktop 内部终端的临时 session/sandbox 环境变量，确保使用用户的 `%USERPROFILE%\.codex`，不会连接到一次性沙盒会话。
- IPC 只接受受信任的主窗口主框架调用，并在主进程再次校验配置、消息、截图区域和会话 ID；未授权的 renderer/frame 会被拒绝。
- CCSwitch 模式的图片和文件会先写入助手私有的附件目录，再通过 app-server 的 `localImage`/`mention` 输入交给官方 Codex 线程；不会把原图写入日志，也不会把附件路径暴露给渲染进程。若必须操作 Codex 网页，请切换到 `官方 Codex 登录` 并完成网页登录。官方模式的图片和文件都通过 Codex 页面文件控件由 Playwright 上传。
- Codex 可能会改变 DOM 结构。所有选择器都集中在 `src/main/codex-adapter.ts`；如果语义化标签发生变化，请只修改该文件。
- 如果删除按钮提示找不到 Codex 删除控件，通常是页面菜单结构变化或当前账号没有删除权限；确认仍能在 Codex 网页中手动删除后，再更新 `codex-adapter.ts` 的语义定位。
- Windows 隐私设置、显示缩放、远程桌面会话或多显示器布局可能影响截图选区。目前鼠标选区和区域截取以主显示器为准。
- 真实 Codex 上传还包含浏览器/网络和页面渲染耗时。随附的性能样本只测量本地适配器路径，因此不能证明端到端 300 ms 目标已经达成。

## 性能自评估

已测得的冒烟/性能输出记录了确切机器、浏览器模式、样本数量、平均值和 p95。窗口拖动和缩放使用原生 BrowserWindow 行为，不增加轮询循环。空闲 CPU/内存以及真实截图到上传的 p95，必须在 Windows 桌面环境中分别测量；当前样本不能代表 Electron 全进程或真实 API 网络延迟。当前主要瓶颈是 Chromium 启动、Windows 桌面截图编码，以及 API/Codex 上传网络延迟。后续可在目标 Windows 机器上增加 ETW/进程指标，卸载 PNG/JPEG 编码工作，并使用页面级上传进度事件。

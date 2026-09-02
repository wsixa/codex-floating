# Codex 桌面悬浮助手

Windows 本地悬浮窗口，用于连接 Codex Desktop / CLI，发送消息、截图和附件，并同步官方会话与已导入项目。

## 直接下载

从 [GitHub Releases](https://github.com/wsixa/codex-floating/releases) 下载：

- [安装版 EXE](https://github.com/wsixa/codex-floating/releases/latest)：推荐，支持桌面和开始菜单快捷方式
- `Codex-Floating-Assistant-Portable-*.exe`：便携版，无需安装

用户不需要 Node.js、npm 或源码。首次使用前，请确保本机已安装并运行官方 Codex Desktop/CLI；CCSwitch 模式还需要启动 CCSwitch。

## 功能

- CCSwitch API 与官方 Codex 登录两种连接方式
- 与 Codex Desktop/CLI 共享会话、模型和项目
- 项目列表同步、项目切换和按项目创建新会话
- 文本、全屏截图、区域截图和普通文件附件
- 模型选择、思考强度、语言、主题、透明度和置顶设置
- Windows 托盘、自动重连和启动状态恢复

## 从源码运行

需要 Windows 10/11、Node.js 20+ 和 npm 10+：

```powershell
Set-Location D:\codex-platform
npm install
npm run dev
```

生产模式：

```powershell
npm run build
npm start
```

从源码生成 Windows 安装版和便携版：

```powershell
npm run package:win
```

只生成可直接运行的应用目录：

```powershell
npm run package:win:dir
```

构建结果位于 `release` 目录。推送 `v*` 标签后，GitHub Actions 会自动构建并发布 Release 附件。

## 使用说明

1. 打开悬浮窗口，在“设置”中选择连接方式。
2. CCSwitch 模式确认 `http://127.0.0.1:15721` 可用；官方模式登录 Codex Desktop。
3. 在“更多操作”中选择项目。新建会话会使用当前项目目录。
4. 输入消息后点击发送，或使用 `Ctrl+Enter`。

配置保存在 `%APPDATA%\codex-floating-assistant\config.json`。项目同步读取 Codex 的 `~/.codex/.codex-global-state.json`，不会复制登录凭据。

## 开发检查

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

## 下载问题

- GitHub Releases 中没有新附件时，检查对应标签的 Actions 是否成功完成。
- 本地打包若因网络无法下载 Electron 工具失败，可使用 `npm run package:win:dir`，或重新运行 GitHub Actions。
- 若提示找不到 Codex app-server，请安装官方 Codex CLI/Desktop 并点击“重新连接”。

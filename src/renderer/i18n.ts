import type { ConnectionState, Language } from '../shared/types';

export interface UiText {
  language: string;
  languageZh: string;
  languageEn: string;
  brandSub: string;
  status: Record<ConnectionState, string>;
  startupTitle: string;
  startupRestart: string;
  toggleMini: string;
  exitMini: string;
  miniModeLabel: string;
  minimizeWindow: string;
  quitAssistant: string;
  hideAssistant: string;
  reconnect: string;
  openCodex: string;
  loginBanner: string;
  apiAccessBanner: string;
  apiResponse: string;
  user: string;
  messageLabel: string;
  messagePlaceholder: string;
  messageAria: string;
  sendHint: string;
  sending: string;
  capturing: string;
  captureUpload: string;
  captureScreen: string;
  captureRegion: string;
  addAttachment: string;
  attachFullScreen: string;
  attachRegion: string;
  attachFiles: string;
  attachments: string;
  removeAttachment: string;
  messageAttachmentPlaceholder: string;
  sendMessage: string;
  fullScreen: string;
  customRegion: string;
  sessions: string;
  settings: string;
  captureArea: string;
  captureAreaHint: string;
  dragToSelect: string;
  recentSessions: string;
  newConversation: string;
  newConversationTitle: string;
  deleteConversation: string;
  confirmDeleteConversation: string;
  deleteRemoteNotice: string;
  deleteLocalNotice: string;
  deletingConversation: string;
  emptyApiSessions: string;
  emptyWebSessions: string;
  preferences: string;
  transportMode: string;
  officialMode: string;
  ccswitchMode: string;
  officialModeHint: string;
  ccswitchModeHint: string;
  saving: string;
  model: string;
  modelShort: string;
  refreshModels: string;
  modelsLoading: string;
  modelsRefreshed: string;
  modelsEmpty: string;
  modelsUnavailable: string;
  currentModel: string;
  codexUrl: string;
  opacity: string;
  theme: string;
  systemTheme: string;
  darkTheme: string;
  lightTheme: string;
  alwaysOnTop: string;
  launchAtLogin: string;
  apiFooter: string;
  playwrightFooter: string;
  codexPage: string;
  ready: string;
  loading: string;
  unknownError: string;
  moreActions: string;
  dismissError: string;
  closePanel: string;
}

const zhCN: UiText = {
  language: '语言',
  languageZh: '中文',
  languageEn: 'English',
  brandSub: '悬浮',
  status: {
    connected: '已连接',
    connecting: '连接中',
    'login-required': '需要登录',
    'api-key-required': '需要连接',
    disconnected: '未连接',
    error: '连接错误',
  },
  startupTitle: '助手无法启动',
  startupRestart: '请从项目终端关闭并重新启动助手。',
  toggleMini: '进入迷你模式',
  exitMini: '退出迷你模式',
  miniModeLabel: '迷你',
  minimizeWindow: '最小化窗口',
  quitAssistant: '退出助手',
  hideAssistant: '隐藏助手',
  reconnect: '重新连接',
  openCodex: '打开官方 Codex',
  loginBanner: '请在官方 Codex 中完成登录，然后点击重新连接',
  apiAccessBanner: 'API 连接尚未准备好，请确认服务正在运行后重新连接',
  apiResponse: 'API 回复',
  user: '你',
  messageLabel: '发送内容',
  messagePlaceholder: '输入消息，发送给 Codex…',
  messageAria: '发送给 Codex 的消息',
  sendHint: 'Ctrl+Enter 发送',
  sending: '发送中',
  capturing: '截取中',
  captureUpload: '截取屏幕并上传',
  captureScreen: '截屏',
  captureRegion: '区域',
  addAttachment: '添加附件',
  attachFullScreen: '截取全屏',
  attachRegion: '框选区域',
  attachFiles: '上传文件',
  attachments: '个附件',
  removeAttachment: '移除附件',
  messageAttachmentPlaceholder: '输入问题，或直接发送附件…',
  sendMessage: '发送消息',
  fullScreen: '全屏',
  customRegion: '自定义区域',
  sessions: '会话',
  settings: '设置',
  captureArea: '截取范围',
  captureAreaHint: '点击截屏后，在屏幕上拖动鼠标框选',
  dragToSelect: '拖动鼠标框选区域，松开后自动上传；按 Esc 取消',
  recentSessions: '最近会话',
  newConversation: '新建',
  newConversationTitle: '新建会话',
  deleteConversation: '删除会话',
  confirmDeleteConversation: '确定删除这个会话？',
  deleteRemoteNotice: '此操作会同步从 Codex 历史中移除。',
  deleteLocalNotice: '会话由官方 Codex 客户端管理，此操作会同步删除 Codex 线程。',
  deletingConversation: '删除中…',
  emptyApiSessions: '暂无 Codex 会话。点击新建或发送第一条消息。',
  emptyWebSessions: '暂无会话。登录后点击重新连接。',
  preferences: '偏好设置',
  transportMode: '连接方式',
  officialMode: '官方 Codex 登录',
  ccswitchMode: 'CCSwitch API',
  officialModeHint: '使用官方 Codex 页面登录，保留网页会话和 Playwright 自动化。',
  ccswitchModeHint: '连接正在运行的官方 Codex Desktop，共享其会话；请求沿用官方客户端的 CCSwitch 路由。',
  saving: '保存中…',
  model: '模型',
  modelShort: '模型',
  refreshModels: '刷新模型列表',
  modelsLoading: '正在读取模型列表…',
  modelsRefreshed: '模型列表已刷新',
  modelsEmpty: '上游暂未返回模型；配置 CCSwitch 上游后点击刷新。',
  modelsUnavailable: '模型列表暂不可用，将继续使用当前模型。',
  currentModel: '当前配置',
  codexUrl: 'Codex 地址',
  opacity: '透明度',
  theme: '主题',
  systemTheme: '跟随系统',
  darkTheme: '深色',
  lightTheme: '浅色',
  alwaysOnTop: '始终置顶',
  launchAtLogin: '登录时启动',
  apiFooter: 'Codex 客户端同步 · CCSwitch 路由',
  playwrightFooter: '官方 Codex + Playwright',
  codexPage: 'Codex 页面',
  ready: '就绪',
  loading: '正在启动助手…',
  unknownError: '发生未知错误',
  moreActions: '更多操作',
  dismissError: '关闭错误提示',
  closePanel: '关闭面板',
};

const enUS: UiText = {
  language: 'Language',
  languageZh: '中文',
  languageEn: 'English',
  brandSub: 'FLOAT',
  status: {
    connected: 'Connected',
    connecting: 'Connecting',
    'login-required': 'Sign in required',
    'api-key-required': 'Connection required',
    disconnected: 'Disconnected',
    error: 'Connection error',
  },
  startupTitle: 'Assistant could not start',
  startupRestart: 'Close and restart the assistant from the project terminal.',
  toggleMini: 'Enter mini mode',
  exitMini: 'Exit mini mode',
  miniModeLabel: 'MINI',
  minimizeWindow: 'Minimize window',
  quitAssistant: 'Quit assistant',
  hideAssistant: 'Hide assistant',
  reconnect: 'Reconnect',
  openCodex: 'Open official Codex',
  loginBanner: 'Sign in in official Codex, then reconnect',
  apiAccessBanner: 'API connection is not ready. Confirm the service is running and reconnect.',
  apiResponse: 'API response',
  user: 'You',
  messageLabel: 'MESSAGE',
  messagePlaceholder: 'Ask Codex anything…',
  messageAria: 'Message to Codex',
  sendHint: 'Ctrl+Enter to send',
  sending: 'Sending',
  capturing: 'Capturing',
  captureUpload: 'Capture screen and upload',
  captureScreen: 'Screen',
  captureRegion: 'Region',
  addAttachment: 'Add attachment',
  attachFullScreen: 'Capture full screen',
  attachRegion: 'Select screen area',
  attachFiles: 'Upload files',
  attachments: 'attachments',
  removeAttachment: 'Remove attachment',
  messageAttachmentPlaceholder: 'Ask a question, or send the attachments…',
  sendMessage: 'Send message',
  fullScreen: 'Full screen',
  customRegion: 'Custom region',
  sessions: 'Sessions',
  settings: 'Settings',
  captureArea: 'Capture area',
  captureAreaHint: 'Drag on the screen after clicking capture',
  dragToSelect: 'Drag to select an area, release to upload; press Esc to cancel',
  recentSessions: 'Recent sessions',
  newConversation: 'New',
  newConversationTitle: 'New conversation',
  deleteConversation: 'Delete conversation',
  confirmDeleteConversation: 'Delete this conversation?',
  deleteRemoteNotice: 'It will also be removed from Codex history.',
  deleteLocalNotice: 'Threads are managed by the official Codex client; this deletes the Codex thread everywhere.',
  deletingConversation: 'Deleting…',
  emptyApiSessions: 'No Codex threads yet. Create one or send your first message.',
  emptyWebSessions: 'No sessions loaded. Sign in and reconnect.',
  preferences: 'Preferences',
  transportMode: 'Connection mode',
  officialMode: 'Official Codex sign-in',
  ccswitchMode: 'CCSwitch API',
  officialModeHint: 'Use the official Codex page with a persistent signed-in browser session.',
  ccswitchModeHint: 'Attach to the running official Codex Desktop and share its threads; requests use its CCSwitch route.',
  saving: 'Saving…',
  model: 'Model',
  modelShort: 'Model',
  refreshModels: 'Refresh model list',
  modelsLoading: 'Loading model list…',
  modelsRefreshed: 'Model list refreshed',
  modelsEmpty: 'No upstream models returned; configure an upstream in CCSwitch and refresh.',
  modelsUnavailable: 'Model list is unavailable; the current model will remain usable.',
  currentModel: 'Current configuration',
  codexUrl: 'Codex URL',
  opacity: 'Opacity',
  theme: 'Theme',
  systemTheme: 'Follow system',
  darkTheme: 'Dark',
  lightTheme: 'Light',
  alwaysOnTop: 'Always on top',
  launchAtLogin: 'Launch at sign-in',
  apiFooter: 'Codex client sync · CCSwitch route',
  playwrightFooter: 'Official Codex + Playwright',
  codexPage: 'Codex page',
  ready: 'ready',
  loading: 'Starting assistant…',
  unknownError: 'An unknown error occurred',
  moreActions: 'More actions',
  dismissError: 'Dismiss error',
  closePanel: 'Close panel',
};

export function getUiText(language: Language): UiText {
  return language === 'en-US' ? enUS : zhCN;
}

export function localizeRuntimeMessage(message: string, language: Language): string {
  if (language === 'en-US' || !message) return message;
  const exact: Record<string, string> = {
    'Connected to Codex': '已连接到 Codex',
    'Codex Desktop 已连接 · CCSwitch 路由由官方客户端管理': 'Codex Desktop 已连接 · CCSwitch 路由由官方客户端管理',
    '正在连接官方 Codex Desktop…': '正在连接官方 Codex Desktop…',
    '未检测到正在运行的 Codex Desktop CDP。请先打开官方 Codex，再点击重新连接。': '未检测到正在运行的 Codex Desktop CDP。请先打开官方 Codex，再点击重新连接。',
    'API connected': 'API 已连接',
    'Disconnected': '未连接',
    'Not connected': '未连接',
    'API is not connected': 'API 尚未连接',
    'Please sign in in the Codex window': '请在 Codex 窗口登录',
    'API is not connected. Configure an API key and press Reconnect.': 'API 尚未连接，请点击重新连接。',
    'CCSwitch is not connected. Start CCSwitch and press Reconnect.': 'CCSwitch 尚未连接，请启动 CCSwitch 后点击重新连接。',
    'Configure an API key in Settings.': 'API 尚未准备好，请检查连接配置后重新连接。',
    'API mode does not use a Codex browser window.': 'API 模式不使用 Codex 浏览器窗口。',
    'Codex is not connected. Sign in and press Reconnect.': 'Codex 尚未连接，请登录后点击重新连接。',
    'API request timed out after 60 seconds.': 'API 请求在 60 秒后超时。',
    'The API returned an empty response.': 'API 返回了空回复。',
    'Message cannot be empty.': '消息不能为空；请输入内容或添加附件。',
    'No screen capture source is available. Check Windows capture permissions.': '没有可用的屏幕捕获源，请检查 Windows 截屏权限。',
    'Screen capture returned an empty image. Check Windows capture permissions.': '屏幕捕获返回了空图片，请检查 Windows 截屏权限。',
    'Screen capture timed out.': '屏幕捕获超时。',
    'Area selection cancelled.': '已取消区域选择。',
    'Codex message input was not found.': '未找到 Codex 消息输入框。',
    'No attachment control was found on the Codex page.': 'Codex 页面没有找到附件控件。',
    'The upstream returned no models.': '上游没有返回可用模型。',
    'Model list request timed out after 12 seconds.': '读取模型列表在 12 秒后超时。',
    'Model list request cancelled.': '模型列表刷新已取消。',
    'Unable to reach the upstream model service. Check CCSwitch and network settings.': '无法读取上游模型，请检查 CCSwitch 是否运行。',
    'Another operation is already in progress.': '已有操作正在进行，请稍候。',
    'Invalid attachment payload.': '附件数据无效，请重新选择文件。',
    'Invalid capture attachment payload.': '截图附件参数无效，请重试。',
    'Only regular files can be attached.': '只能上传普通文件。',
    'Attachments exceed the 20 MB total limit.': '附件总大小不能超过 20 MB。',
    'Each attachment must be between 1 byte and 15 MB.': '单个附件大小必须在 1 字节到 15 MB 之间。',
    'You can attach up to 8 files at a time.': '一次最多添加 8 个附件。',
  };
  if (exact[message]) return exact[message];
  const connected = message.match(/^CCSwitch route connected \((.+)\)$/);
  if (connected) return `CCSwitch 路由已连接（${connected[1]}）`;
  const uploaded = message.match(/^Capture uploaded in (\d+) ms$/);
  if (uploaded) return `截图已上传，用时 ${uploaded[1]} 毫秒`;
  const httpError = message.match(/^API request failed \((\d+)\)\.?$/);
  if (httpError) return `API 请求失败（${httpError[1]}）`;
  const modelHttpError = message.match(/^Model list request failed \((\d+)\)\.?$/);
  if (modelHttpError) return `模型列表请求失败（${modelHttpError[1]}）`;
  if (/^API request failed \(/i.test(message)) return message.replace(/^API request failed/i, 'API 请求失败');
  if (/^Unable to reach the OpenAI API/i.test(message)) return '无法连接 API，请检查网络或代理设置。';
  if (/^Renderer load failed/i.test(message)) return `助手界面加载失败：${message}`;
  return message;
}

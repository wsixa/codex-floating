import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { CaptureService, compressCapture } from './capture-service';
import { CaptureSelectionService } from './capture-selection';
import { AttachmentService } from './attachment-service';
import { ApiService } from './api-service';
import { CodexAppServerService } from './codex-app-server';
import { CodexDesktopService } from './codex-desktop-service';
import type { CodexSessionService } from './codex-session';
import { ConfigService } from './config-service';
import { PlaywrightService } from './playwright-service';
import { TrayManager } from './tray-manager';
import { WindowManager } from './window-manager';
import { OfficialPageHost } from './official-page-host';
import {
  IPC_CHANNELS,
  isCaptureAndSendInput,
  isCaptureAttachmentInput,
  isApiKeyInput,
  isConfigPatch,
  isConversationId,
  isPlaceholderConversationTitle,
  isSendMessageInput,
  summarizeConversationTitle,
  type AppConfig,
  type ApiModelOption,
  type AppState,
  type AttachmentPayload,
  type CaptureAndSendInput,
  type CaptureAttachmentInput,
  type CaptureRegion,
  type ConfigPatch,
  type ConversationSummary,
  type SendMessageInput,
} from '../shared/types';

// This utility window does not need GPU acceleration. Some Windows images used for
// local development do not ship a compatible GPU DLL, which otherwise makes the
// Electron GPU process fatal before the renderer can paint its first frame.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.disableHardwareAcceleration();

const startedAt = Date.now();
let mainWindow: BrowserWindow | null = null;
let configService: ConfigService;
let windowManager: WindowManager;
let officialPageHost: OfficialPageHost | null = null;
let trayManager: TrayManager;
let captureService: CaptureService;
let captureSelectionService: CaptureSelectionService;
let attachmentService: AttachmentService;
let playwrightService: PlaywrightService;
let apiService: ApiService;
let codexAppServerService: CodexAppServerService;
let codexDesktopService: CodexDesktopService;
let apiSessionService: CodexSessionService;
let state: AppState;
let shuttingDown = false;
let rendererReady = false;
let boundsPersistTimer: ReturnType<typeof setTimeout> | null = null;
let rendererRestartAttempts = 0;
let rendererRestartTimer: ReturnType<typeof setTimeout> | null = null;
let modelRefreshGeneration = 0;
let activeOperation: Promise<unknown> | null = null;
const optimisticConversationTitles = new Map<string, string>();
const optimisticDeletedConversationKeys = new Set<string>();
let activeOptimisticConversationTitle: string | null = null;

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (state) updateState({ lastError: message.slice(0, 500) });
});

function initialState(config: AppConfig): AppState {
  const status = config.mode === 'api'
    ? (apiSessionService ?? codexDesktopService ?? codexAppServerService)?.currentStatus
    : playwrightService?.currentStatus;
  return {
    config,
    connection: status?.state ?? 'disconnected',
    connectionMessage: status?.message ?? 'Starting...',
    page: 'page' in (status ?? {}) ? (status as { page?: AppState['page'] }).page ?? null : null,
    conversations: [],
    activeConversationId: null,
    availableModels: [],
    isCapturing: false,
    isSending: false,
    isDeleting: false,
    lastError: null,
    lastResponse: null,
    startedAt,
  };
}

function broadcast(): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send(IPC_CHANNELS.stateEvent, rendererState());
  } catch {
    // The renderer can disappear during a reload or crash; state will be sent after it comes back.
  }
}

/** Keep CCSwitch endpoint/key metadata out of the renderer state boundary. */
function rendererState(): AppState {
  const config = { ...state.config } as Partial<AppConfig>;
  delete config.apiBaseUrl;
  delete config.apiKeyConfigured;
  return { ...state, config: config as AppConfig };
}

function updateState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  broadcast();
}

function conversationKey(value: string | undefined, baseValue = state.config.codexUrl): string | null {
  if (!value) return null;
  try {
    const base = new URL(baseValue);
    const url = new URL(value, base);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function isNewConversationUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return /\/(?:c|conversation)\/new\/?$/i.test(new URL(value, state.config.codexUrl).pathname);
  } catch {
    return false;
  }
}

function clearOptimisticConversation(value: string | undefined): void {
  if (!value) return;
  optimisticConversationTitles.delete(value);
  const bases = [state.config.codexUrl, state.page?.url, playwrightService?.currentStatus.page?.url, apiSessionService?.currentStatus.page?.url]
    .filter((base): base is string => Boolean(base));
  for (const base of bases) {
    const key = conversationKey(value, base);
    if (key) optimisticConversationTitles.delete(key);
  }
}

function conversationKeysFor(value: string | undefined): string[] {
  if (!value) return [];
  const bases = [state.config.codexUrl, state.page?.url, playwrightService?.currentStatus.page?.url, apiSessionService?.currentStatus.page?.url]
    .filter((base): base is string => Boolean(base));
  return [...new Set([
    value,
    ...bases.map((base) => conversationKey(value, base)).filter((key): key is string => Boolean(key)),
  ])];
}

function markOptimisticallyDeleted(conversation: ConversationSummary): void {
  for (const value of [conversation.id, conversation.url]) {
    for (const key of conversationKeysFor(value)) optimisticDeletedConversationKeys.add(key);
  }
}

function clearOptimisticDeleted(value: string | undefined): void {
  for (const key of conversationKeysFor(value)) optimisticDeletedConversationKeys.delete(key);
}

function filterOptimisticallyDeleted(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.filter((conversation) => {
    if (optimisticDeletedConversationKeys.has(conversation.id) ||
      (conversation.url && optimisticDeletedConversationKeys.has(conversation.url))) return false;
    return ![conversation.id, conversation.url]
      .flatMap((value) => conversationKeysFor(value))
      .some((key) => optimisticDeletedConversationKeys.has(key));
  });
}

function resolveActiveConversationId(): string | null {
  const currentPageUrl = state.config.mode === 'api'
    ? apiSessionService?.currentStatus.page?.url ?? state.page?.url
    : playwrightService?.currentStatus.page?.url ?? state.page?.url;
  if (state.config.mode === 'api' && apiSessionService?.currentConversationId) return apiSessionService.currentConversationId;
  const listed = findCurrentConversationId(state.conversations, currentPageUrl);
  if (listed) return listed;
  if (state.activeConversationId) return state.activeConversationId;
  const pageUrl = currentPageUrl;
  if (!pageUrl) return null;
  try { return new URL(pageUrl).pathname; } catch { return null; }
}

/** Update the visible title before waiting on the API or Codex page. */
function prepareConversationTitle(content: string): void {
  if (state.config.mode === 'api') {
    const service = apiSessionService;
    const conversations = service?.prepareMessageTitle?.(content) ?? state.conversations;
    updateState({ conversations, activeConversationId: service?.currentConversationId ?? state.activeConversationId });
    return;
  }

  const id = resolveActiveConversationId();
  if (!id) return;
  const pageUrl = playwrightService.currentStatus.page?.url ?? state.page?.url;
  const current = state.conversations.find((conversation) => conversationMatches(conversation, id, pageUrl));
  const title = summarizeConversationTitle(content, state.config.language);
  const currentIsPlaceholder = !current || isPlaceholderConversationTitle(current.title);
  activeOptimisticConversationTitle = currentIsPlaceholder ? title : null;
  const effectiveId = current?.id ?? id;
  const keys = [id, effectiveId, current?.url, pageUrl]
    .map((value) => conversationKey(value, pageUrl ?? state.config.codexUrl))
    .filter((key): key is string => Boolean(key));
  if (currentIsPlaceholder) {
    for (const key of keys) optimisticConversationTitles.set(key, title);
  }
  const nextConversation: ConversationSummary = current
    ? { ...current, title: currentIsPlaceholder ? title : current.title }
    : { id: effectiveId, title, url: pageUrl };
  const conversations = [nextConversation, ...state.conversations.filter((conversation) => conversation.id !== effectiveId && conversation.id !== id)];
  updateState({ conversations, activeConversationId: effectiveId });
}

function applyOptimisticConversationTitles(
  conversations: ConversationSummary[],
  activeId = state.activeConversationId,
  pageUrl = state.config.mode === 'api'
    ? apiSessionService?.currentStatus.page?.url ?? state.page?.url
    : playwrightService?.currentStatus.page?.url ?? state.page?.url,
): ConversationSummary[] {
  return conversations.map((conversation) => {
    const keys = [conversation.id, conversation.url]
      .map((value) => conversationKey(value, pageUrl ?? state.config.codexUrl))
      .filter((key): key is string => Boolean(key));
    let title = keys.map((key) => optimisticConversationTitles.get(key)).find((value): value is string => Boolean(value));
    const pageMatches = conversationMatches(conversation, undefined, pageUrl);
    if (!title && activeOptimisticConversationTitle && ((activeId && conversation.id === activeId) || pageMatches)) {
      title = activeOptimisticConversationTitle;
    }
    if (!title) return conversation;
    for (const key of keys) optimisticConversationTitles.set(key, title);
    return { ...conversation, title };
  });
}

function scheduleBoundsPersistence(): void {
  if (boundsPersistTimer) clearTimeout(boundsPersistTimer);
  boundsPersistTimer = setTimeout(() => {
    boundsPersistTimer = null;
    const bounds = windowManager?.getBounds();
    if (!bounds || !configService) return;
    void configService.update({ window: bounds })
      .then((config) => updateState({ config }))
      .catch((error: unknown) => updateState({ lastError: error instanceof Error ? error.message : String(error) }));
  }, 350);
}

function withOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeOperation) {
    const error = new Error('Another operation is already in progress.');
    updateState({ lastError: error.message });
    return Promise.reject(error);
  }
  const task = Promise.resolve().then(operation).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    updateState({ lastError: message.slice(0, 500) });
    throw new Error(message.slice(0, 500));
  });
  activeOperation = task;
  return task.finally(() => {
    if (activeOperation === task) activeOperation = null;
  });
}

function assertTrustedRenderer(event: Electron.IpcMainInvokeEvent): void {
  const window = mainWindow;
  const frame = event.senderFrame;
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !frame || frame !== window.webContents.mainFrame) {
    throw new Error('Unauthorized IPC sender.');
  }
  const frameUrl = frame.url;
  if (frameUrl.startsWith('file://')) return;
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    try {
      if (new URL(frameUrl).origin === new URL(rendererUrl).origin) return;
    } catch {
      // Fall through to the rejection below.
    }
  }
  throw new Error('Unauthorized renderer origin.');
}

function secureHandle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, value: unknown) => unknown): void {
  ipcMain.handle(channel, (event, value) => {
    assertTrustedRenderer(event);
    return handler(event, value);
  });
}

async function refreshConnections(): Promise<void> {
  if (state.config.mode === 'api') {
    const status = apiSessionService?.currentStatus ?? codexAppServerService.currentStatus;
    updateState({ connection: status.state, connectionMessage: status.message, page: status.page ?? null });
    return;
  }
  const status = await playwrightService.refreshStatus();
  updateState({ connection: status.state, connectionMessage: status.message, page: status.page });
}

async function rememberPage(): Promise<void> {
  if (state.config.mode !== 'playwright') return;
  const url = sanitizePageUrl(playwrightService.currentStatus.page?.url);
  if (!url || !/^https?:\/\//i.test(url) || url === state.config.lastPageUrl) return;
  const config = await configService.update({ lastPageUrl: url });
  updateState({ config });
}

async function persistActiveThread(): Promise<void> {
  if (state.config.mode !== 'api' || !configService) return;
  const threadId = apiSessionService?.currentConversationId ?? null;
  if (threadId === state.config.lastThreadId) return;
  const config = await configService.update({ lastThreadId: threadId });
  updateState({ config });
}

function sanitizePageUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const configuredOrigin = new URL(state.config.codexUrl).origin;
    if (url.origin !== configuredOrigin) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|secret|password|passwd|auth|session|code|key)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

async function connectCodex(): Promise<AppState> {
  if (state.config.mode === 'api') {
    officialPageHost?.setVisible(false);
    modelRefreshGeneration += 1;
    await playwrightService.disconnect();
    await apiService.disconnect();
    await codexDesktopService.disconnect();
    await codexAppServerService.disconnect();

    // API/CCSwitch mode is still a Codex client mode: first attach to the
    // official Desktop renderer so the sidebar and composer operate on the
    // exact threads the user sees there. The app-server is a fallback for a
    // closed Desktop client; it uses the same Codex home when no SQLite lock
    // is held by the GUI.
    const desktopStatus = await codexDesktopService.connect(state.config);
    let status = desktopStatus;
    if (desktopStatus.state !== 'connected' && desktopStatus.state !== 'login-required') {
      const appServerStatus = await codexAppServerService.connect(state.config);
      if (appServerStatus.state === 'connected') {
        apiSessionService = codexAppServerService;
        status = appServerStatus;
      } else {
        apiSessionService = codexDesktopService;
        status = {
          state: 'error',
          message: `${desktopStatus.message}；官方 app-server 也不可用：${appServerStatus.message}`,
          page: null,
        };
      }
    } else {
      apiSessionService = codexDesktopService;
    }
    const conversations = applyOptimisticConversationTitles(
      await apiSessionService.listConversations().catch(() => []),
      apiSessionService.currentConversationId,
    );
    updateState({
      connection: status.state,
      connectionMessage: status.message,
      page: status.page ?? null,
      conversations,
      activeConversationId: apiSessionService.currentConversationId ?? conversations[0]?.id ?? null,
      availableModels: [],
      lastError: status.state === 'error' ? status.message : null,
    });
    if (status.state === 'connected') {
      await persistActiveThread().catch(() => undefined);
      void refreshApiModels().catch(() => undefined);
    }
    return state;
  }
  modelRefreshGeneration += 1;
  await apiService.disconnect();
  await codexDesktopService.disconnect();
  await codexAppServerService.disconnect();
  apiSessionService = codexAppServerService;
  // The visible official page is hosted by the floating shell. Playwright
  // remains the automation/control path and keeps its persistent session.
  if (!officialPageHost && mainWindow) officialPageHost = new OfficialPageHost(mainWindow);
  if (officialPageHost) {
    officialPageHost.setVisible(!state.config.miniMode);
    void officialPageHost.load(state.config.lastPageUrl ?? state.config.codexUrl).catch((error: unknown) => {
      updateState({ lastError: `Embedded Codex page failed to load: ${error instanceof Error ? error.message : String(error)}` });
    });
  }
  const status = await playwrightService.connect(state.config);
  updateState({ connection: status.state, connectionMessage: status.message, page: status.page, availableModels: [], lastError: status.state === 'error' ? status.message : null });
  if (status.state === 'connected') {
    await loadConversations().catch(() => undefined);
    await rememberPage().catch(() => undefined);
  }
  return state;
}

async function refreshApiModels(): Promise<ApiModelOption[]> {
  const generation = ++modelRefreshGeneration;
  try {
    const service = apiSessionService;
    if (!service) return [];
    const models = await service.listModels();
    if (generation === modelRefreshGeneration && state.config.mode === 'api') {
      const status = service.currentStatus;
      updateState({ connection: status.state, connectionMessage: status.message, page: status.page ?? null, availableModels: models, lastError: null });
    }
    return models;
  } catch (error) {
    if (generation === modelRefreshGeneration && state.config.mode === 'api') {
      const status = apiSessionService?.currentStatus ?? codexAppServerService.currentStatus;
      updateState({ connection: status.state, connectionMessage: status.message, page: status.page ?? null, lastError: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

async function loadConversations(): Promise<ConversationSummary[]> {
  if (state.config.mode === 'api') {
    const service = apiSessionService;
    if (!service) return [];
    const activeConversationId = service.currentConversationId;
    const titled = applyOptimisticConversationTitles(
      await service.listConversations(),
      activeConversationId,
    );
    const conversations = preserveActiveConversation(filterOptimisticallyDeleted(titled), activeConversationId);
    updateState({ conversations, ...(activeConversationId ? { activeConversationId } : {}) });
    await persistActiveThread().catch(() => undefined);
    return conversations;
  }
  const listedConversations = await playwrightService.listConversations();
  const currentPageUrl = playwrightService.currentStatus.page?.url ?? state.page?.url;
  const activeConversationId = findCurrentConversationId(listedConversations, currentPageUrl) ?? state.activeConversationId;
  const titled = applyOptimisticConversationTitles(listedConversations, activeConversationId, currentPageUrl);
  const conversations = preserveActiveConversation(filterOptimisticallyDeleted(titled), activeConversationId, currentPageUrl);
  updateState({ conversations, ...(activeConversationId ? { activeConversationId } : {}) });
  return conversations;
}

function preserveActiveConversation(
  conversations: ConversationSummary[],
  activeId: string | null,
  pageUrl = state.config.mode === 'api'
    ? apiSessionService?.currentStatus.page?.url ?? state.page?.url
    : playwrightService?.currentStatus.page?.url ?? state.page?.url,
): ConversationSummary[] {
  // History sidebars can briefly omit the active item while navigation settles.
  const local = state.conversations.find((conversation) => conversationMatches(conversation, activeId ?? undefined, pageUrl));
  if (!local || conversations.some((conversation) => conversationMatches(conversation, local.id, pageUrl))) return conversations;
  const title = activeOptimisticConversationTitle ?? local.title;
  return [{ ...local, title }, ...conversations];
}

function conversationMatches(conversation: ConversationSummary, id?: string, pageUrl?: string): boolean {
  if (id && conversation.id === id) return true;
  if (!pageUrl) return false;
  return Boolean(
    (conversation.url && sameConversationUrl(conversation.url, pageUrl)) ||
    sameConversationUrl(conversation.id, pageUrl),
  );
}

function findCurrentConversationId(conversations: ConversationSummary[], currentPageUrl = state.page?.url): string | null {
  if (!currentPageUrl) return null;
  for (const conversation of conversations) {
    if (conversation.id === currentPageUrl || conversationMatches(conversation, undefined, currentPageUrl)) return conversation.id;
  }
  return null;
}

function sameConversationUrl(value: string, current: string): boolean {
  try {
    const target = new URL(value, current);
    const base = new URL(current);
    return target.origin === base.origin && target.pathname === base.pathname;
  } catch {
    return false;
  }
}

async function sendMessage(input: SendMessageInput): Promise<AppState> {
  if (state.isDeleting) throw new Error('Finish deleting the current conversation first.');
  const content = input.text.trim();
  const attachments = attachmentService.validateIncoming(input.attachments ?? []);
  if (!content && attachments.length === 0) throw new Error('Message cannot be empty.');
  const titleContent = content || attachmentTitle(attachments[0], state.config.language);
  // Rename synchronously so the renderer does not wait for the remote reply
  // or the Codex history sidebar to refresh.
  if (titleContent.length <= 30_000) prepareConversationTitle(titleContent);
  updateState({ isSending: true, lastError: null });
  try {
    const response = state.config.mode === 'api'
      ? await apiSessionService.sendMessage(content, attachments)
      : (await playwrightService.sendMessage(content, attachments), null);
    if (response) updateState({ lastResponse: response });
    await refreshConnections();
    // Codex/API can assign the title asynchronously after the first message;
    // refresh the list so the draft label transitions to the generated title.
    await loadConversations().catch(() => undefined);
    return state;
  } catch (error) {
    // Broadcast the API transport state as well as the operation error. This
    // prevents the renderer from showing a stale "connected" dot after a
    // timeout, while ApiService keeps HTTP-level failures retryable.
    await refreshConnections().catch(() => undefined);
    throw error;
  } finally {
    updateState({ isSending: false });
  }
}

function attachmentTitle(attachment: AttachmentPayload | undefined, language: AppConfig['language']): string {
  if (!attachment) return language === 'zh-CN' ? '附件分析' : 'Attachment analysis';
  if (/^codex-capture-/i.test(attachment.name)) return language === 'zh-CN' ? '截图分析' : 'Screenshot analysis';
  return attachment.name;
}

async function captureAttachment(input: CaptureAttachmentInput = {}): Promise<AttachmentPayload> {
  updateState({ isCapturing: true, lastError: null });
  let selectedRegion: CaptureRegion | undefined = input.region;
  let restoreWindow = false;
  try {
    if (input.selectRegion) {
      restoreWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
      if (restoreWindow) mainWindow?.hide();
      const picked = await captureSelectionService.select(state.config.language);
      if (!picked) throw new Error(state.config.language === 'zh-CN' ? '已取消区域选择。' : 'Area selection cancelled.');
      selectedRegion = picked;
    }
    // Hide the assistant for a UI-triggered full-screen capture as well. The
    // next compositor tick is enough for desktopCapturer to observe the hide.
    if (!input.selectRegion && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      restoreWindow = true;
      mainWindow.hide();
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    const raw = selectedRegion ? await captureService.captureRegion(selectedRegion) : await captureService.captureFullScreen();
    return attachmentService.fromCapture(compressCapture(raw, 84));
  } finally {
    if (restoreWindow) windowManager.show();
    updateState({ isCapturing: false });
  }
}

async function captureAndSend(input: CaptureAndSendInput = {}): Promise<AppState> {
  if (state.isDeleting) throw new Error('Finish deleting the current conversation first.');
  const connection = state.config.mode === 'api' ? apiSessionService.currentStatus.state : playwrightService.currentStatus.state;
  const canRetryApi = state.config.mode === 'api' && connection === 'error';
  if (connection !== 'connected' && !canRetryApi) {
    throw new Error(state.config.mode === 'api'
      ? 'API is not connected. Configure an API key and press Reconnect before uploading a capture.'
      : 'Codex is not connected. Sign in and press Reconnect before uploading a capture.');
  }
  const titlePrompt = input.text?.trim() || (state.config.language === 'zh-CN' ? '请分析这张截图。' : 'Please analyze this screenshot.');
  // A capture can take several asynchronous steps; show its conversation title
  // before screen acquisition starts so the rename is visible immediately.
  if (titlePrompt.length <= 30_000) prepareConversationTitle(titlePrompt);
  updateState({ isCapturing: true, isSending: true, lastError: null });
  let selectedRegion: CaptureRegion | undefined = input.region;
  let restoreWindow = false;
  try {
    if (input.selectRegion) {
      restoreWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
      if (restoreWindow) mainWindow?.hide();
      const picked = await captureSelectionService.select(state.config.language);
      if (!picked) throw new Error(state.config.language === 'zh-CN' ? '已取消区域选择。' : 'Area selection cancelled.');
      selectedRegion = picked;
    }
    const captureStarted = performance.now();
    const raw = selectedRegion ? await captureService.captureRegion(selectedRegion) : await captureService.captureFullScreen();
    const capture = compressCapture(raw, 84);
    const response = state.config.mode === 'api'
      ? await apiSessionService.uploadAndSend(capture, input.text)
      : (await playwrightService.uploadAndSend(capture, input.text), null);
    if (response) updateState({ lastResponse: response });
    const elapsed = Math.round(performance.now() - captureStarted);
    updateState({ connectionMessage: `Capture uploaded in ${elapsed} ms`, page: state.config.mode === 'api' ? apiSessionService.currentStatus.page ?? null : playwrightService.currentStatus.page });
    await refreshConnections();
    await loadConversations().catch(() => undefined);
    return state;
  } finally {
    if (restoreWindow) windowManager.show();
    updateState({ isCapturing: false, isSending: false });
  }
}

async function deleteConversation(id: string): Promise<AppState> {
  if (state.isSending || state.isCapturing || state.isDeleting) throw new Error('Finish the current operation before deleting a conversation.');
  const known = state.conversations.find((conversation) => conversation.id === id);
  if (!known) throw new Error('Conversation is no longer available in the current history.');
  const deletingActive = state.activeConversationId === id;
  activeOptimisticConversationTitle = null;
  updateState({ isDeleting: true, lastError: null });

  try {
    if (state.config.mode === 'api') {
      const conversations = await apiSessionService.deleteConversation(id, known.url);
      markOptimisticallyDeleted(known);
      updateState({
        conversations: filterOptimisticallyDeleted(conversations),
        activeConversationId: apiSessionService.currentConversationId,
        ...(deletingActive ? { lastResponse: null } : {}),
      });
      await persistActiveThread().catch(() => undefined);
      return state;
    }

    await playwrightService.deleteConversation(id, known.url);
    markOptimisticallyDeleted(known);
    const remainingLocal = state.conversations.filter((conversation) => !conversationMatches(conversation, id, known.url));
    updateState({
      conversations: remainingLocal,
      ...(deletingActive ? { activeConversationId: null, lastResponse: null } : {}),
    });
    await refreshConnections();
    // Deleting the active web conversation can navigate Codex to the next
    // history item or /c/new. Persist that destination so a restart never
    // restores the removed conversation URL.
    await rememberPage().catch(() => undefined);
    await loadConversations().catch(() => undefined);
    return state;
  } finally {
    updateState({ isDeleting: false });
  }
}

function registerIpc(): void {
  secureHandle(IPC_CHANNELS.getState, () => rendererState());
  secureHandle(IPC_CHANNELS.updateConfig, (_event, value: unknown) => withOperation(async () => {
    if (!isConfigPatch(value)) throw new Error('Invalid configuration patch.');
    const patch = value as ConfigPatch;
    const config = await configService.update(patch);
    if (patch.window) {
      const bounds = windowManager.getBounds();
      if (bounds && mainWindow) mainWindow.setBounds({ ...bounds, ...config.window });
    }
    if (patch.opacity !== undefined) windowManager.setOpacity(config.opacity);
    if (patch.alwaysOnTop !== undefined) windowManager.setAlwaysOnTop(config.alwaysOnTop);
    if (patch.language !== undefined) trayManager.setLanguage(config.language);
    if (patch.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
    updateState({ config });
    if (patch.mode !== undefined || patch.codexUrl !== undefined || patch.apiBaseUrl !== undefined) {
      await connectCodex();
    } else if (patch.apiModel !== undefined && state.config.mode === 'api') {
      if (apiSessionService === codexDesktopService) {
        await apiSessionService.setModel?.(config.apiModel);
      } else {
        // The app-server captures the model in its active configuration, so
        // reconnect it when a model changes while Desktop CDP is unavailable.
        await connectCodex();
      }
    }
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.setApiKey, (_event, value: unknown) => withOperation(async () => {
    if (!isApiKeyInput(value)) throw new Error('Invalid API key payload.');
    const config = await configService.setApiKey(value.apiKey);
    updateState({ config, lastError: null });
    if (config.mode === 'api') await connectCodex();
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.clearApiKey, () => withOperation(async () => {
    const config = await configService.clearApiKey();
    updateState({ config });
    if (config.mode === 'api') await connectCodex();
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.sendMessage, (_event, value: unknown) => {
    if (!isSendMessageInput(value)) throw new Error('Invalid message payload.');
    return withOperation(async () => {
      await sendMessage(value);
      return rendererState();
    });
  });
  secureHandle(IPC_CHANNELS.captureAndSend, (_event, value: unknown) => {
    if (!isCaptureAndSendInput(value)) throw new Error('Invalid capture payload.');
    return withOperation(async () => {
      await captureAndSend(value);
      return rendererState();
    });
  });
  secureHandle(IPC_CHANNELS.captureAttachment, (_event, value: unknown) => {
    if (!isCaptureAttachmentInput(value)) throw new Error('Invalid capture attachment payload.');
    return withOperation(() => captureAttachment(value));
  });
  secureHandle(IPC_CHANNELS.pickFiles, () => withOperation(() => attachmentService.pickFiles()));
  secureHandle(IPC_CHANNELS.newConversation, () => withOperation(async () => {
    activeOptimisticConversationTitle = null;
    const previousPageUrl = playwrightService?.currentStatus.page?.url ?? state.page?.url;
    if (state.config.mode === 'playwright' && isNewConversationUrl(previousPageUrl)) {
      clearOptimisticConversation(previousPageUrl);
      clearOptimisticDeleted(previousPageUrl);
      clearOptimisticConversation(state.activeConversationId ?? undefined);
      clearOptimisticDeleted(state.activeConversationId ?? undefined);
    }
    if (state.config.mode === 'api') {
      await apiSessionService.newConversation();
    } else {
      await playwrightService.newConversation();
      await rememberPage();
      const nextPageUrl = playwrightService.currentStatus.page?.url;
      if (isNewConversationUrl(nextPageUrl)) {
        clearOptimisticConversation(nextPageUrl);
        clearOptimisticDeleted(nextPageUrl);
        updateState({ conversations: state.conversations.filter((conversation) => !conversationMatches(conversation, undefined, nextPageUrl)) });
      }
    }
    updateState({ activeConversationId: null, lastResponse: null });
    const conversations = await loadConversations().catch(() => []);
    if (state.config.mode === 'api') {
      updateState({ activeConversationId: apiSessionService.currentConversationId ?? conversations[0]?.id ?? null });
      await persistActiveThread().catch(() => undefined);
    }
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.listConversations, () => withOperation(loadConversations));
  secureHandle(IPC_CHANNELS.listModels, () => withOperation(async () => {
    if (state.config.mode !== 'api') return [];
    return refreshApiModels();
  }));
  secureHandle(IPC_CHANNELS.switchConversation, (_event, value: unknown) => withOperation(async () => {
    if (!isConversationId(value)) throw new Error('Invalid conversation id.');
    const known = state.conversations.find((conversation) => conversation.id === value);
    activeOptimisticConversationTitle = null;
    if (state.config.mode === 'playwright' && (isNewConversationUrl(known?.url) || Boolean(known && isPlaceholderConversationTitle(known.title)))) {
      clearOptimisticConversation(value);
      clearOptimisticConversation(known?.url);
    }
    if (state.config.mode === 'api') {
      await apiSessionService.switchConversation(value, known?.url);
      await persistActiveThread().catch(() => undefined);
    } else {
      await playwrightService.switchConversation(value, known?.url);
      await rememberPage();
    }
    updateState({ activeConversationId: value });
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.deleteConversation, (_event, value: unknown) => withOperation(async () => {
    if (!isConversationId(value)) throw new Error('Invalid conversation id.');
    await deleteConversation(value);
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.reconnect, () => withOperation(async () => {
    await connectCodex();
    return rendererState();
  }));
  secureHandle(IPC_CHANNELS.minimizeWindow, () => {
    windowManager.minimize();
  });
  secureHandle(IPC_CHANNELS.quit, () => {
    app.quit();
  });
  secureHandle(IPC_CHANNELS.toggleMiniMode, async () => {
    const miniMode = windowManager.toggleMiniMode();
    officialPageHost?.setVisible(!miniMode);
    const config = await configService.update({ miniMode, window: windowManager.getBounds() ?? undefined });
    updateState({ config });
    return rendererState();
  });
  secureHandle(IPC_CHANNELS.toggleVisibility, () => windowManager.toggleVisibility());
  secureHandle(IPC_CHANNELS.openCodex, () => withOperation(() => {
    if (state.config.mode === 'api') {
      if (codexDesktopService.currentStatus.state !== 'connected' && codexDesktopService.currentStatus.state !== 'login-required') {
        return connectCodex().then(() => codexDesktopService.openCodex?.());
      }
      return codexDesktopService.openCodex?.() ?? Promise.resolve();
    }
    return playwrightService.openCodex();
  }));
  secureHandle(IPC_CHANNELS.openSettings, () => withOperation(async () => {
    if (state.config.mode === 'playwright') return playwrightService.openSettings();
    if (apiSessionService === codexDesktopService) return codexDesktopService.openSettings();
    await windowManager.show();
  }));
  secureHandle(IPC_CHANNELS.openModelMenu, () => withOperation(async () => {
    if (state.config.mode === 'playwright') return playwrightService.openModelMenu();
    if (apiSessionService === codexDesktopService) return codexDesktopService.openModelMenu();
    await refreshApiModels();
  }));
}

function triggerCapture(): Promise<AppState> {
  return withOperation(() => captureAndSend({ text: 'Please analyze this screenshot.' }));
}

async function createApplication(): Promise<void> {
  console.log('[main] createApplication start', { rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null });
  configService = new ConfigService();
  const config = await configService.load();
  windowManager = new WindowManager();
  trayManager = new TrayManager();
  captureService = new CaptureService();
  captureSelectionService = new CaptureSelectionService();
  attachmentService = new AttachmentService(() => mainWindow);
  playwrightService = new PlaywrightService(path.join(app.getPath('userData'), 'playwright-profile'));
  // Keep the legacy HTTP service available for diagnostics/tests, but the
  // running assistant uses the official app-server so its threads are shared
  // with Codex Desktop and the CLI.
  apiService = new ApiService();
  codexAppServerService = new CodexAppServerService({
    cwd: process.cwd(),
    attachmentDirectory: path.join(app.getPath('userData'), 'codex-attachments'),
  });
  codexDesktopService = new CodexDesktopService();
  apiSessionService = codexAppServerService;
  state = initialState(config);
  app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
  mainWindow = windowManager.create(config, () => broadcast());
  mainWindow.on('move', scheduleBoundsPersistence);
  mainWindow.on('resize', scheduleBoundsPersistence);
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererReady = false;
    updateState({ lastError: `Floating window renderer stopped (${details.reason}).` });
    const window = windowManager.current;
    if (!window || window.isDestroyed() || shuttingDown) return;
    if (rendererRestartAttempts >= 3) {
      updateState({ lastError: 'The assistant UI could not be restarted after 3 attempts. Restart the app from the terminal.' });
      windowManager.show();
      return;
    }
    const delay = Math.min(4_000, 250 * (2 ** rendererRestartAttempts));
    rendererRestartAttempts += 1;
    if (rendererRestartTimer) clearTimeout(rendererRestartTimer);
    rendererRestartTimer = setTimeout(() => {
      rendererRestartTimer = null;
      try {
        window.reload();
      } catch (error) {
        updateState({ lastError: `Renderer reload failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }, delay);
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    rendererReady = false;
    const message = error instanceof Error ? error.message : String(error);
    updateState({ lastError: `Preload failed (${preloadPath}): ${message.slice(0, 400)}` });
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // ERR_ABORTED is emitted for an intentional reload/navigation and is not a
    // renderer failure that should replace the UI with the error page.
    if (errorCode === -3) return;
    rendererReady = false;
    const message = `Renderer load failed (${errorCode}): ${errorDescription} [${validatedURL}]`;
    updateState({ lastError: message.slice(0, 500) });
    if (!validatedURL.startsWith('data:')) windowManager.showLoadError(message, state?.config.language ?? 'zh-CN');
  });
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    rendererRestartAttempts = 0;
    if (rendererRestartTimer) clearTimeout(rendererRestartTimer);
    rendererRestartTimer = null;
    // Some Windows compositor/runtime combinations do not emit ready-to-show
    // consistently. Showing after the document is loaded prevents a silently
    // hidden assistant.
    windowManager.show();
    broadcast();
  });
  registerIpc();
  try {
    await windowManager.load(mainWindow, process.env.ELECTRON_RENDERER_URL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({ lastError: `Unable to load the assistant UI: ${message.slice(0, 400)}` });
    windowManager.show();
    throw error;
  }
  trayManager.create({
    toggleVisibility: () => windowManager.toggleVisibility(),
    minimize: () => windowManager.minimize(),
    toggleMiniMode: () => {
      const miniMode = windowManager.toggleMiniMode();
      void configService.update({ miniMode, window: windowManager.getBounds() ?? undefined })
        .then((next) => updateState({ config: next }))
        .catch((error: unknown) => updateState({ lastError: error instanceof Error ? error.message : String(error) }));
    },
    capture: () => { void triggerCapture().catch(() => undefined); },
    reconnect: () => { void connectCodex().catch(() => undefined); },
    quit: () => app.quit(),
  }, config.language);
  playwrightService.onStatus((status) => {
    updateState({ connection: status.state, connectionMessage: status.message, page: status.page });
    void rememberPage().catch((error: unknown) => {
      updateState({ lastError: error instanceof Error ? error.message : String(error) });
    });
  });
  codexAppServerService.onStatus((status) => {
    if (state.config.mode !== 'api' || apiSessionService !== codexAppServerService) return;
    updateState({ connection: status.state, connectionMessage: status.message, page: status.page ?? null });
  });
  codexAppServerService.onThreadsChanged(() => {
    if (state.config.mode !== 'api' || apiSessionService !== codexAppServerService) return;
    void loadConversations().catch((error: unknown) => {
      updateState({ lastError: error instanceof Error ? error.message : String(error) });
    });
  });
  codexDesktopService.onStatus((status) => {
    if (state.config.mode !== 'api' || apiSessionService !== codexDesktopService) return;
    updateState({ connection: status.state, connectionMessage: status.message, page: status.page ?? null });
  });
  codexDesktopService.onThreadsChanged(() => {
    if (state.config.mode !== 'api' || apiSessionService !== codexDesktopService) return;
    void loadConversations().catch((error: unknown) => {
      updateState({ lastError: error instanceof Error ? error.message : String(error) });
    });
  });
  await connectCodex();
  console.log('[main] createApplication complete', { visible: mainWindow?.isVisible(), bounds: mainWindow?.getBounds() });
}

app.on('ready', () => {
  console.log('[main] app ready');
  void createApplication().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[main] createApplication failed', message);
    if (state) updateState({ lastError: message });
  });
});

app.on('window-all-closed', () => {
  // The tray keeps the assistant alive on Windows; quit only when explicitly requested.
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (boundsPersistTimer) clearTimeout(boundsPersistTimer);
  boundsPersistTimer = null;
  if (rendererRestartTimer) clearTimeout(rendererRestartTimer);
  rendererRestartTimer = null;
  event.preventDefault();
  const bounds = windowManager?.getBounds();
  void (async () => {
    try {
      if (bounds) await configService.update({ window: bounds });
      trayManager?.destroy();
      captureSelectionService?.dispose();
      await playwrightService?.disconnect();
      await apiService?.disconnect();
      await codexDesktopService?.disconnect();
      await codexAppServerService?.disconnect();
      officialPageHost?.dispose();
      officialPageHost = null;
    } finally {
      app.exit(0);
    }
  })();
});

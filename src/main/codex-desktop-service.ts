import { chromium, type Browser, type Page } from 'playwright';
import type {
  ApiModelOption,
  AppConfig,
  AttachmentPayload,
  CapturePayload,
  ConversationSummary,
} from '../shared/types';
import { isPlaceholderConversationTitle, summarizeConversationTitle } from '../shared/types';
import { CodexAdapter } from './codex-adapter';
import type { CodexSessionService, CodexSessionStatus } from './codex-session';

const CONNECT_TIMEOUT_MS = 4_000;
const PROBE_TIMEOUT_MS = 650;
const DEFAULT_CDP_PORTS = Array.from({ length: 12 }, (_value, index) => 9229 + index);

/**
 * Connects to an already-running official Codex Desktop renderer over CDP.
 * This service is deliberately non-owning: the assistant may inspect and
 * operate the page, but it must never close the user's Codex application.
 */
export class CodexDesktopService implements CodexSessionService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private adapter: CodexAdapter | null = null;
  private config: AppConfig | null = null;
  private status: CodexSessionStatus = { state: 'disconnected', message: 'Codex Desktop 未连接', page: null };
  private activeThreadId: string | null = null;
  private conversations: ConversationSummary[] = [];
  private pendingTitle: string | null = null;
  private statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private conversationRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private draftConversationId: string | null = null;
  private readonly statusListeners = new Set<(status: CodexSessionStatus) => void>();
  private readonly threadListeners = new Set<() => void>();

  get currentStatus(): CodexSessionStatus {
    return { ...this.status, page: this.status.page ? { ...this.status.page } : null };
  }

  get currentConversationId(): string | null {
    return this.activeThreadId;
  }

  onStatus(listener: (status: CodexSessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onThreadsChanged(listener: () => void): () => void {
    this.threadListeners.add(listener);
    return () => this.threadListeners.delete(listener);
  }

  async connect(config: AppConfig): Promise<CodexSessionStatus> {
    await this.disconnect();
    this.config = config;
    this.setStatus({ state: 'connecting', message: '正在连接官方 Codex Desktop…', page: null });

    const failures: string[] = [];
    for (const endpoint of await discoverEndpoints()) {
      let candidate: Browser | null = null;
      try {
        candidate = await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
        const page = await this.selectCodexPage(candidate);
        if (!page) {
          failures.push('CDP 页面不是 Codex Desktop');
          await closeBrowserConnection(candidate);
          candidate = null;
          continue;
        }
        this.browser = candidate;
        this.page = page;
        this.adapter = new CodexAdapter(page);
        this.attachPageListeners(page);
        candidate.on('disconnected', () => {
          if (this.browser === candidate) this.markDisconnected('Codex Desktop 已关闭或 CDP 连接已断开。');
        });
        const pageState = await this.adapter.readPageState();
        if (!pageState.inputAvailable) throw new Error('Codex Desktop composer is unavailable.');
        await this.refreshActiveConversationId();
        await this.refreshConversations().catch(() => undefined);
        this.setStatus({
          state: pageState.loggedIn ? 'connected' : 'login-required',
          message: pageState.loggedIn
            ? 'Codex Desktop 已连接 · CCSwitch 路由由官方客户端管理'
            : 'Codex Desktop 已打开，但需要先登录。',
          page: pageState,
        });
        return this.currentStatus;
      } catch (error) {
        failures.push(formatDesktopError(error));
        if (candidate) await closeBrowserConnection(candidate);
      }
    }

    this.browser = null;
    this.page = null;
    this.adapter = null;
    const detail = failures.find((value) => value && !/not a Codex Desktop/i.test(value));
    this.setStatus({
      state: 'error',
      message: detail && !/^CDP endpoint not found/i.test(detail)
        ? detail
        : '未检测到正在运行的 Codex Desktop CDP。请先打开官方 Codex，再点击重新连接。',
      page: null,
    });
    return this.currentStatus;
  }

  async disconnect(): Promise<void> {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer);
    this.statusRefreshTimer = null;
    if (this.conversationRefreshTimer) clearTimeout(this.conversationRefreshTimer);
    this.conversationRefreshTimer = null;
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.adapter = null;
    this.config = null;
    this.activeThreadId = null;
    this.conversations = [];
    this.pendingTitle = null;
    this.draftConversationId = null;
    // Browser.close() on a connectOverCDP browser detaches Playwright's
    // transport; it does not close the remote Electron application.
    if (browser) await closeBrowserConnection(browser);
    if (this.status.state !== 'error') {
      this.setStatus({ state: 'disconnected', message: 'Codex Desktop 未连接', page: null });
    }
  }

  async refreshStatus(): Promise<CodexSessionStatus> {
    if (!this.adapter) return this.currentStatus;
    try {
      const pageState = await this.adapter.readPageState();
      await this.refreshActiveConversationId();
      this.setStatus({
        state: pageState.loggedIn ? 'connected' : 'login-required',
        message: pageState.loggedIn
          ? 'Codex Desktop 已连接 · CCSwitch 路由由官方客户端管理'
          : 'Codex Desktop 已打开，但需要先登录。',
        page: pageState,
      });
    } catch (error) {
      this.markDisconnected(formatDesktopError(error));
    }
    return this.currentStatus;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const adapter = this.requireAdapter();
    const listed = await adapter.listConversations();
    await this.refreshActiveConversationId();
    this.conversations = this.mergeDraftConversation(applyPendingTitle(listed, this.pendingTitle, this.activeThreadId));
    return this.conversations.map((item) => ({ ...item }));
  }

  async newConversation(): Promise<void> {
    await this.requireAdapter().startNewConversation();
    this.draftConversationId = `desktop-draft:${Date.now()}`;
    this.activeThreadId = this.draftConversationId;
    this.pendingTitle = null;
    this.conversations = this.mergeDraftConversation(this.conversations);
    this.emitThreadsChanged();
  }

  async switchConversation(id: string, knownUrl?: string): Promise<void> {
    if (id === this.draftConversationId && id === this.activeThreadId) return;
    await this.requireAdapter().switchConversation(id, knownUrl);
    this.activeThreadId = id;
    this.draftConversationId = null;
    this.pendingTitle = null;
    await this.refreshConversations().catch(() => undefined);
    await this.refreshStatus();
  }

  async deleteConversation(id: string, knownUrl?: string): Promise<ConversationSummary[]> {
    if (id === this.draftConversationId) {
      this.draftConversationId = null;
      this.activeThreadId = null;
      this.pendingTitle = null;
      this.conversations = this.conversations.filter((item) => item.id !== id);
      this.emitThreadsChanged();
      return this.conversations.map((item) => ({ ...item }));
    }
    await this.requireAdapter().deleteConversation(id, knownUrl);
    await this.refreshActiveConversationId();
    this.pendingTitle = null;
    await this.refreshConversations().catch(() => undefined);
    await this.refreshStatus();
    return this.conversations.map((item) => ({ ...item }));
  }

  prepareMessageTitle(content: string): ConversationSummary[] {
    if (!this.activeThreadId) return this.conversations.map((item) => ({ ...item }));
    const current = this.conversations.find((item) => item.id === this.activeThreadId);
    if (!current || isPlaceholderConversationTitle(current.title)) {
      this.pendingTitle = summarizeConversationTitle(content, this.config?.language ?? 'zh-CN');
      this.conversations = applyPendingTitle(this.conversations, this.pendingTitle, this.activeThreadId);
      this.emitThreadsChanged();
    }
    return this.conversations.map((item) => ({ ...item }));
  }

  async sendMessage(text: string, attachments: AttachmentPayload[]): Promise<void> {
    await this.requireAdapter().sendMessage(text, attachments);
    // The official client generates its final thread title after the first
    // user turn. Refresh shortly after the DOM update so the mini UI follows
    // the same title without blocking the send operation.
    this.scheduleConversationRefresh();
    await this.refreshStatus();
  }

  async uploadAndSend(capture: CapturePayload, text?: string): Promise<void> {
    await this.requireAdapter().uploadAndSend(capture, text);
    this.scheduleConversationRefresh();
    await this.refreshStatus();
  }

  async listModels(): Promise<ApiModelOption[]> {
    const models = await this.requireAdapter().listModels();
    return models
      .map((id) => ({ id: normalizeDesktopModelId(id) }))
      .filter((model, index, all) => model.id.length > 0 && all.findIndex((candidate) => candidate.id === model.id) === index);
  }

  async setModel(id: string): Promise<void> {
    await this.requireAdapter().selectModel(id);
    await this.refreshStatus();
  }

  async openSettings(): Promise<void> {
    await this.requireAdapter().openSettings();
  }

  async openModelMenu(): Promise<void> {
    await this.requireAdapter().openModelMenu();
  }

  async openCodex(): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed()) throw new Error('Codex Desktop is not connected.');
    await page.bringToFront();
  }

  private async selectCodexPage(browser: Browser): Promise<Page | null> {
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((candidate) => !candidate.isClosed());
    const preferred = pages
      .filter((candidate) => candidate.url() === 'app://-/index.html')
      .sort((a, b) => Number(b.url().includes('initialRoute')) - Number(a.url().includes('initialRoute')));
    for (const candidate of [...preferred, ...pages]) {
      if (candidate.url().includes('initialRoute=%2Favatar-overlay')) continue;
      if (await candidate.locator('[data-codex-composer]').count().catch(() => 0) > 0) return candidate;
    }
    return null;
  }

  private attachPageListeners(page: Page): void {
    page.on('close', () => {
      if (this.page === page) this.markDisconnected('Codex Desktop 页面已关闭。');
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.scheduleStatusRefresh();
    });
  }

  private async refreshConversations(): Promise<void> {
    if (!this.adapter) return;
    const listed = await this.adapter.listConversations();
    await this.refreshActiveConversationId();
    this.conversations = this.mergeDraftConversation(applyPendingTitle(listed, this.pendingTitle, this.activeThreadId));
    this.emitThreadsChanged();
  }

  private async refreshActiveConversationId(): Promise<void> {
    if (!this.page) return;
    const selected = this.page.locator('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-selected="true"]').first();
    const id = await selected.getAttribute('data-app-action-sidebar-thread-id').catch(() => null);
    if (id?.trim()) {
      // While a Desktop draft is opening, the sidebar can keep the previous
      // row selected for a few frames. Preserve the draft until Codex assigns
      // the newly sent turn a real thread ID.
      if (this.draftConversationId && this.activeThreadId === this.draftConversationId) return;
      const previousDraft = this.draftConversationId;
      this.activeThreadId = id.trim();
      if (previousDraft && previousDraft !== this.activeThreadId) this.draftConversationId = null;
      return;
    }
    if (!this.draftConversationId) this.activeThreadId = null;
  }

  private scheduleConversationRefresh(): void {
    if (this.conversationRefreshTimer) clearTimeout(this.conversationRefreshTimer);
    this.conversationRefreshTimer = setTimeout(() => {
      this.conversationRefreshTimer = null;
      void this.refreshConversations().catch(() => undefined);
    }, 350);
  }

  private scheduleStatusRefresh(): void {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer);
    this.statusRefreshTimer = setTimeout(() => {
      this.statusRefreshTimer = null;
      void this.refreshStatus();
    }, 250);
  }

  private requireAdapter(): CodexAdapter {
    if (!this.adapter || !this.page || this.page.isClosed()) {
      throw new Error('Codex Desktop 未连接，请打开官方 Codex 后点击重新连接。');
    }
    return this.adapter;
  }

  private mergeDraftConversation(conversations: ConversationSummary[]): ConversationSummary[] {
    const draftId = this.draftConversationId;
    if (!draftId || conversations.some((item) => item.id === draftId)) return conversations;
    return [{ id: draftId, title: this.pendingTitle || 'New conversation' }, ...conversations];
  }

  private markDisconnected(message: string): void {
    this.browser = null;
    this.page = null;
    this.adapter = null;
    this.setStatus({ state: 'disconnected', message: message.slice(0, 500), page: null });
  }

  private setStatus(status: CodexSessionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(this.currentStatus);
  }

  private emitThreadsChanged(): void {
    for (const listener of this.threadListeners) listener();
  }
}

/** Convert Desktop display labels into the stable IDs persisted by Codex. */
export function normalizeDesktopModelId(value: string): string {
  const label = value.trim().replace(/\s+/gu, ' ').slice(0, 256);
  const version = label.match(/^(?:gpt[-_ ]*)?(5(?:\.\d+)?)(?:[-_ ]+(sol|terra|luna))?$/iu);
  if (!version) return label;
  const family = version[1];
  const variant = version[2]?.toLowerCase();
  return `gpt-${family}${variant ? `-${variant}` : ''}`;
}

async function discoverEndpoints(): Promise<string[]> {
  const explicit = process.env.CODEX_DESKTOP_CDP_URL?.trim();
  if (explicit) return [explicit];
  const configuredPort = process.env.CODEX_DESKTOP_CDP_PORT?.trim() || process.env.ELECTRON_CDP_PORT?.trim();
  const ports = configuredPort && /^\d{2,5}$/.test(configuredPort)
    ? [Number(configuredPort), ...DEFAULT_CDP_PORTS.filter((port) => port !== Number(configuredPort))]
    : DEFAULT_CDP_PORTS;
  const endpoints: string[] = [];
  for (const port of ports) {
    const endpoint = `http://127.0.0.1:${port}`;
    if (await probeEndpoint(endpoint)) endpoints.push(endpoint);
  }
  return endpoints;
}

async function probeEndpoint(endpoint: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(`${endpoint}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function closeBrowserConnection(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // A remote desktop can disappear while the CDP transport is closing.
  }
}

function applyPendingTitle(
  conversations: ConversationSummary[],
  pendingTitle: string | null,
  activeId: string | null,
): ConversationSummary[] {
  if (!pendingTitle || !activeId) return conversations.map((item) => ({ ...item }));
  return conversations.map((item) => item.id === activeId && isPlaceholderConversationTitle(item.title)
    ? { ...item, title: pendingTitle }
    : { ...item });
}

function formatDesktopError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return '连接 Codex Desktop 超时。';
  if (/composer is unavailable/i.test(message)) return 'Codex Desktop 页面尚未准备好，请稍后重试。';
  return message.replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]').slice(0, 500);
}

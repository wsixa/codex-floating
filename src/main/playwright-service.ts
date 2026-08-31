import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright';
import fs from 'node:fs';
import type { AppConfig, AttachmentPayload, CapturePayload, ConversationSummary, ConnectionState, PageState } from '../shared/types';
import { CodexAdapter } from './codex-adapter';

export interface PlaywrightStatus {
  state: ConnectionState;
  message: string;
  page: PageState | null;
}

export class PlaywrightService {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private adapter: CodexAdapter | null = null;
  private statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private status: PlaywrightStatus = { state: 'disconnected', message: 'Not connected', page: null };
  private disconnectListeners = new Set<(status: PlaywrightStatus) => void>();

  constructor(private readonly profileDir: string) {}

  get currentStatus(): PlaywrightStatus {
    return { ...this.status, page: this.status.page ? { ...this.status.page } : null };
  }

  onStatus(listener: (status: PlaywrightStatus) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async connect(config: AppConfig): Promise<PlaywrightStatus> {
    await this.disconnect();
    this.setStatus({ state: 'connecting', message: 'Opening Codex in a persistent browser profile...', page: null });
    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        executablePath: resolveBrowserExecutable(),
        viewport: null,
        acceptDownloads: false,
        args: [
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
          '--disable-features=CalculateNativeWinOcclusion',
        ],
      });
      this.context.on('close', () => this.markDisconnected('Browser context closed.'));
      const pages = this.context.pages();
      const expectedOrigin = new URL(config.codexUrl).origin;
      this.page = pages.find((candidate) => {
        try { return new URL(candidate.url()).origin === expectedOrigin; } catch { return false; }
      }) ?? pages[0] ?? await this.context.newPage();
      this.page.on('close', () => {
        if (this.page?.isClosed()) this.markDisconnected('Codex page closed.');
      });
      const targetUrl = restorePageUrl(config.codexUrl, config.lastPageUrl);
      await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.page.emulateMedia({ reducedMotion: 'reduce' }).catch(() => undefined);
      await this.page.addStyleTag({ content: '*,:before,:after{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;scroll-behavior:auto!important;}' }).catch(() => undefined);
      this.adapter = new CodexAdapter(this.page);
      this.page.on('framenavigated', (frame) => {
        if (frame === this.page?.mainFrame()) this.scheduleStatusRefresh();
      });
      const pageState = await this.adapter.readPageState();
      this.setStatus({
        state: pageState.loggedIn ? 'connected' : 'login-required',
        message: pageState.loggedIn ? 'Connected to Codex' : 'Please sign in in the Codex window',
        page: pageState,
      });
    } catch (error) {
      await this.disconnect();
      const message = formatPlaywrightError(error);
      this.setStatus({ state: 'error', message, page: null });
    }
    return this.currentStatus;
  }

  async disconnect(): Promise<void> {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer);
    this.statusRefreshTimer = null;
    this.adapter = null;
    this.page = null;
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => undefined);
    if (this.status.state !== 'error') this.setStatus({ state: 'disconnected', message: 'Disconnected', page: null });
  }

  /**
   * Return cookies from the persistent Playwright session for the embedded
   * BrowserView. Cookie values stay in the main process and are never sent to
   * the React renderer or written to logs.
   */
  async getSessionCookies(url?: string): Promise<Cookie[]> {
    if (!this.context) return [];
    return this.context.cookies(url);
  }

  async refreshStatus(): Promise<PlaywrightStatus> {
    if (!this.adapter) return this.currentStatus;
    try {
      const page = await this.adapter.readPageState();
      this.setStatus({ state: page.loggedIn ? 'connected' : 'login-required', message: page.loggedIn ? 'Connected to Codex' : 'Please sign in in the Codex window', page });
    } catch (error) {
      this.markDisconnected(formatPlaywrightError(error));
    }
    return this.currentStatus;
  }

  private scheduleStatusRefresh(): void {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer);
    this.statusRefreshTimer = setTimeout(() => {
      this.statusRefreshTimer = null;
      void this.refreshStatus();
    }, 250);
  }

  async sendText(text: string): Promise<void> {
    const adapter = this.requireAdapter();
    await adapter.sendText(text);
    await this.refreshStatus();
  }

  async uploadAndSend(capture: CapturePayload, text?: string): Promise<void> {
    const adapter = this.requireAdapter();
    await adapter.uploadAndSend(capture, text);
    await this.refreshStatus();
  }

  async sendMessage(text: string, attachments: AttachmentPayload[]): Promise<void> {
    const adapter = this.requireAdapter();
    await adapter.sendMessage(text, attachments);
    await this.refreshStatus();
  }

  async newConversation(): Promise<void> {
    await this.requireAdapter().startNewConversation();
    await this.refreshStatus();
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.requireAdapter().listConversations();
  }

  async switchConversation(id: string, url?: string): Promise<void> {
    await this.requireAdapter().switchConversation(id, url);
    await this.refreshStatus();
  }

  async deleteConversation(id: string, url?: string): Promise<void> {
    await this.requireAdapter().deleteConversation(id, url);
    await this.refreshStatus();
  }

  async openCodex(): Promise<void> {
    if (!this.page || this.page.isClosed()) throw new Error('Codex browser is not connected.');
    await this.page.bringToFront();
  }

  async openSettings(): Promise<void> {
    await this.requireAdapter().openSettings();
  }

  async openModelMenu(): Promise<void> {
    await this.requireAdapter().openModelMenu();
  }

  private requireAdapter(): CodexAdapter {
    if (!this.adapter || !this.page || this.page.isClosed()) {
      throw new Error('Codex is not connected. Open Codex and press Reconnect.');
    }
    return this.adapter;
  }

  private setStatus(status: PlaywrightStatus): void {
    this.status = status;
    for (const listener of this.disconnectListeners) listener(this.currentStatus);
  }

  private markDisconnected(message: string): void {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer);
    this.statusRefreshTimer = null;
    this.adapter = null;
    this.page = null;
    this.context = null;
    this.setStatus({ state: 'disconnected', message, page: null });
  }
}

function resolveBrowserExecutable(): string | undefined {
  const configured = process.env.CODEX_BROWSER_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  if (process.platform !== 'win32') return undefined;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function restorePageUrl(baseUrl: string, lastPageUrl: string | null): string {
  if (!lastPageUrl) return baseUrl;
  try {
    const base = new URL(baseUrl);
    const last = new URL(lastPageUrl);
    return last.origin === base.origin ? last.toString() : baseUrl;
  } catch {
    return baseUrl;
  }
}

function formatPlaywrightError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable doesn't exist|browserType\.launch/i.test(message)) {
    return 'Chromium is not installed. Run "npx playwright install chromium" once.';
  }
  if (/timeout/i.test(message)) return 'Codex did not respond before the timeout.';
  return message.slice(0, 400);
}

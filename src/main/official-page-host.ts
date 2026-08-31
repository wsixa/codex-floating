import { BrowserView, type BrowserWindow, type WebContents } from 'electron';
import type { Cookie } from 'playwright';

const TOOLBAR_HEIGHT = 48;
const LOAD_TIMEOUT_MS = 20_000;
type ViewBounds = { x: number; y: number; width: number; height: number };

/** CSS/JS injected into the official Codex page rendered inside the shell. */
export const OFFICIAL_PAGE_COMPACT_SCRIPT = `(() => {
  const styleId = 'codex-floating-compact-style';
  const css = [
    ':root { --codex-floating-shell-offset: 0px; }',
    'html, body { width: 100% !important; min-height: 100%; overflow: hidden !important; }',
    '#app-shell-sidebar, aside[data-app-shell-left-panel-appearance], [data-app-action-sidebar], [data-app-shell-sidebar], [data-app-action-sidebar-thread-row] { display: none !important; }',
    'nav[aria-label*="sidebar" i], [data-app-shell-sidebar-trigger] { display: none !important; }',
    '[data-panel-side="right"], [data-side-panel="right"], [data-testid="right-panel"], [data-testid="inspector"], [data-app-shell-right-panel] { display: none !important; }',
    '[data-app-shell-unified-tab-strip] > :first-child, [data-app-action-titlebar], [data-app-shell-titlebar], [data-testid="top-bar"], [data-testid="title-bar"] { display: none !important; }',
    'main, [role="main"] { width: 100% !important; max-width: none !important; margin: 0 !important; }',
    '[data-codex-composer] { position: sticky !important; bottom: 0 !important; }',
  ].join('');
  let style = document.getElementById(styleId);
  if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style); }
  style.textContent = css;
  document.documentElement.dataset.codexFloatingCompact = 'true';
  if (!window.__codexFloatingCompactObserver) {
    window.__codexFloatingCompactObserver = new MutationObserver(() => {
      const current = document.getElementById(styleId);
      if (current && current.textContent !== css) current.textContent = css;
    });
    window.__codexFloatingCompactObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;

declare global {
  interface Window {
    __codexFloatingCompactObserver?: MutationObserver;
  }
}

/** Owns the embedded official page without owning its session or credentials. */
export class OfficialPageHost {
  private readonly view: BrowserView;
  private window: BrowserWindow | null;
  private compactScript: string | null = null;
  private attached = false;
  private visible = false;
  private loaded = false;
  private disposed = false;
  private loadGeneration = 0;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    });
    this.view.setBackgroundColor('#11161d');
    this.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      this.loaded = false;
      this.detach();
      console.error(`[official-page] load failed (${errorCode}): ${errorDescription}`);
    });
    this.view.webContents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.detach();
      console.error(`[official-page] renderer stopped: ${details.reason}`);
    });
    this.view.webContents.on('did-finish-load', () => {
      if (this.disposed || this.view.webContents.isDestroyed()) return;
      // Full navigations replace the injected style. Re-apply it before the
      // view is exposed so a navigation can never flash the full app chrome.
      void this.injectCompactMode();
    });
    window.on('resize', () => this.updateBounds());
    window.on('move', () => this.updateBounds());
    window.on('closed', () => this.dispose());
  }

  async load(url: string, cookies: readonly Cookie[] = []): Promise<void> {
    const target = validatePageUrl(url);
    const generation = ++this.loadGeneration;
    this.loaded = false;
    this.compactScript = null;
    this.detach();
    try {
      await this.syncCookies(cookies, target);
      const documentReady = waitForDocumentReady(this.view.webContents, LOAD_TIMEOUT_MS, `Timed out loading ${target}.`);
      try {
        const loadPromise = this.view.webContents.loadURL(target);
        // Keep the rejection handler attached when DOM readiness wins the
        // race; Electron may reject the original navigation later.
        void loadPromise.catch(() => undefined);
        await Promise.race([loadPromise, documentReady.promise]);
      } finally {
        documentReady.cancel();
      }
      if (generation !== this.loadGeneration || this.disposed) return;
      await this.injectCompactMode();
      if (generation !== this.loadGeneration || this.disposed) return;
      this.loaded = true;
      if (this.visible) this.attach();
    } catch (error) {
      if (generation === this.loadGeneration) {
        this.loaded = false;
        this.detach();
      }
      throw error;
    }
  }

  async injectCompactMode(): Promise<void> {
    if (this.view.webContents.isDestroyed()) return;
    try {
      await this.view.webContents.executeJavaScript(OFFICIAL_PAGE_COMPACT_SCRIPT, true);
      this.compactScript = OFFICIAL_PAGE_COMPACT_SCRIPT;
    } catch {
      // A navigation can destroy the execution context between did-finish-load
      // and this call. The next load/navigation will try again.
    }
  }

  async execute(script: string): Promise<unknown> {
    if (this.view.webContents.isDestroyed()) return undefined;
    return this.view.webContents.executeJavaScript(script, true);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.detach();
      return;
    }
    if (this.loaded) this.attach();
  }

  dispose(): void {
    const window = this.window;
    this.window = null;
    this.disposed = true;
    this.visible = false;
    this.loaded = false;
    this.loadGeneration += 1;
    if (window && !window.isDestroyed()) this.detach(window);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }

  private updateBounds(): void {
    if (!this.window || this.window.isDestroyed() || !this.attached) return;
    this.view.setBounds(this.bounds());
    if (this.compactScript) void this.injectCompactMode();
  }

  private attach(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || this.disposed || !this.visible || !this.loaded) return;
    if (!this.attached) {
      window.addBrowserView(this.view);
      this.attached = true;
    }
    this.view.setBackgroundColor('#11161d');
    this.view.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
    this.view.setBounds(this.bounds());
  }

  private async syncCookies(cookies: readonly Cookie[], fallbackUrl: string): Promise<void> {
    if (this.view.webContents.isDestroyed() || cookies.length === 0) return;
    const target = new URL(fallbackUrl);
    await Promise.all(cookies.map(async (cookie) => {
      const domain = cookie.domain.replace(/^\./u, '');
      if (!domain) return;
      const scheme = cookie.secure ? 'https:' : target.protocol;
      const url = `${scheme}//${domain}${cookie.path || '/'}`;
      await this.view.webContents.session.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
        sameSite: mapSameSite(cookie.sameSite),
      }).catch(() => undefined);
    }));
  }

  private detach(owner = this.window): void {
    if (!this.attached) return;
    if (owner && !owner.isDestroyed()) owner.removeBrowserView(this.view);
    this.attached = false;
  }

  private bounds(): ViewBounds {
    const { width, height } = this.window?.getContentBounds() ?? { width: 0, height: 0 };
    return { x: 0, y: TOOLBAR_HEIGHT, width: Math.max(0, width), height: Math.max(0, height - TOOLBAR_HEIGHT) };
  }
}

function validatePageUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) Codex pages can be embedded.');
    return url.toString();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid Codex page URL.');
  }
}

function waitForDocumentReady(
  webContents: WebContents,
  milliseconds: number,
  message: string,
): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ready: () => void = () => undefined;
  const cancel = () => {
    webContents.removeListener('dom-ready', ready);
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const promise = new Promise<void>((resolve, reject) => {
    ready = () => {
      cancel();
      resolve();
    };
    timer = setTimeout(() => {
      cancel();
      reject(new Error(message));
    }, milliseconds);
    // Do not keep the Electron main process alive solely for an abandoned load.
    timer.unref?.();
    webContents.once('dom-ready', ready);
  });
  return { promise, cancel };
}

function mapSameSite(value: Cookie['sameSite']): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (value === 'None') return 'no_restriction';
  if (value === 'Strict') return 'strict';
  if (value === 'Lax') return 'lax';
  return 'unspecified';
}

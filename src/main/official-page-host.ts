import { BrowserView, type BrowserWindow } from 'electron';

/** CSS/JS injected into the official Codex page rendered inside the shell. */
export const OFFICIAL_PAGE_COMPACT_SCRIPT = `(() => {
  const styleId = 'codex-floating-compact-style';
  const css = [
    ':root { --codex-floating-shell-offset: 0px; }',
    'html, body { min-height: 100%; overflow: hidden !important; }',
    '[data-app-action-sidebar], [data-app-action-sidebar-thread-row] { display: none !important; }',
    'aside[aria-label*="sidebar" i], nav[aria-label*="sidebar" i], [data-testid*="sidebar" i] { display: none !important; }',
    '[data-panel-side="right"], [data-side-panel="right"], [data-testid*="right-panel" i], [data-testid*="inspector" i] { display: none !important; }',
    '[data-app-action-titlebar], [data-testid*="top-bar" i], [data-testid*="header" i], [role="banner"] { display: none !important; }',
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
    window.addBrowserView(this.view);
    this.updateBounds();
    window.on('resize', () => this.updateBounds());
    window.on('move', () => this.updateBounds());
    window.on('closed', () => this.dispose());
  }

  async load(url: string): Promise<void> {
    await this.view.webContents.loadURL(url);
    await this.injectCompactMode();
  }

  async injectCompactMode(): Promise<void> {
    if (this.view.webContents.isDestroyed()) return;
    await this.view.webContents.executeJavaScript(OFFICIAL_PAGE_COMPACT_SCRIPT, true).catch(() => undefined);
    this.compactScript = OFFICIAL_PAGE_COMPACT_SCRIPT;
  }

  async execute(script: string): Promise<unknown> {
    if (this.view.webContents.isDestroyed()) return undefined;
    return this.view.webContents.executeJavaScript(script, true);
  }

  setVisible(visible: boolean): void {
    this.view.setBounds(this.bounds());
    this.view.setBackgroundColor('#11161d');
    this.view.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
    if (!visible) this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  dispose(): void {
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.removeBrowserView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }

  private updateBounds(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.view.setBounds(this.bounds());
    if (this.compactScript) void this.injectCompactMode();
  }

  private bounds(): { x: number; y: number; width: number; height: number } {
    const { width, height } = this.window?.getContentBounds() ?? { width: 0, height: 0 };
    const top = 48;
    return { x: 0, y: top, width: Math.max(0, width), height: Math.max(0, height - top) };
  }
}

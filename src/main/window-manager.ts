import { app, BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import { OPACITY_MAX, OPACITY_MIN, type AppConfig, type Language, type WindowBounds } from '../shared/types';

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;

export class WindowManager {
  private window: BrowserWindow | null = null;
  private allowClose = false;
  private rendererOrigin: string | null = null;

  constructor() {
    app.on('before-quit', () => { this.allowClose = true; });
  }

  create(config: AppConfig, onReady?: () => void): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const bounds = this.normalizeBounds(config.window);
    this.window = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      // An opaque native surface is considerably more reliable on Windows
      // machines where Chromium compositing or GPU DLLs are unavailable. The
      // renderer still controls the visual opacity and rounded content.
      transparent: false,
      resizable: true,
      movable: true,
      alwaysOnTop: config.alwaysOnTop,
      skipTaskbar: false,
      // Keep the native background hidden until the renderer has completed
      // its first load. The main process also shows it from did-finish-load as
      // a fallback for Windows builds that omit ready-to-show.
      show: false,
      backgroundColor: '#11161d',
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Electron 44 cannot launch this renderer reliably in a sandboxed
        // preload on some Windows builds. Isolation and Node integration remain
        // enabled/disabled respectively; the preload exposes only typed IPC.
        sandbox: false,
        spellcheck: true,
      },
    });
    this.window.setOpacity(config.opacity);
    this.window.setAlwaysOnTop(config.alwaysOnTop, 'floating');
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    this.window.webContents.on('will-navigate', (event, url) => {
      let allowed = url.startsWith('file:') || url.startsWith('data:text/html');
      if (!allowed && this.rendererOrigin) {
        try { allowed = new URL(url).origin === this.rendererOrigin; } catch { allowed = false; }
      }
      if (!allowed) event.preventDefault();
    });
    this.window.on('closed', () => { this.window = null; });
    this.window.on('show', () => console.log('[window] show', this.window?.getBounds()));
    this.window.on('hide', () => console.log('[window] hide'));
    this.window.on('close', (event) => {
      if (!this.allowClose) {
        event.preventDefault();
        // A native close request (the title-bar X, Alt+F4, or the taskbar
        // close command) is an explicit exit request. Keep the close event
        // cancellable while the main process releases Playwright, tray state,
        // and the tray, then let the app terminate through its normal quit
        // lifecycle instead of silently hiding in the background.
        app.quit();
      }
    });
    this.window.once('ready-to-show', () => {
      console.log('[window] ready-to-show');
      this.window?.show();
      onReady?.();
    });
    console.log('[window] created', this.window.getBounds(), 'visible=', this.window.isVisible());
    return this.window;
  }

  load(window: BrowserWindow, rendererUrl?: string): Promise<void> {
    if (rendererUrl) {
      try { this.rendererOrigin = new URL(rendererUrl).origin; } catch { this.rendererOrigin = null; }
    } else {
      this.rendererOrigin = null;
    }
    return rendererUrl ? window.loadURL(rendererUrl) : window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  showLoadError(message: string, language: Language = 'zh-CN'): void {
    const window = this.current;
    if (!window) return;
    const safeMessage = escapeHtml(message.slice(0, 800));
    const heading = language === 'zh-CN' ? '助手界面加载失败' : 'Assistant UI could not load';
    const title = language === 'zh-CN' ? 'Codex 悬浮助手' : 'Codex Floating Assistant';
    const html = `<!doctype html><html lang="${language === 'zh-CN' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;min-height:100%;font-family:Segoe UI,Microsoft YaHei UI,system-ui,sans-serif;background:#11161d;color:#e7edf3}main{margin:0;padding:22px;min-height:100vh;box-sizing:border-box;border:1px solid #5b3038;border-radius:10px;background:#171e27}h1{margin:0 0 10px;font-size:15px;color:#f3a8ae}p{margin:0;color:#c6a4a8;font-size:12px;line-height:1.5;word-break:break-word}</style></head><body><main><h1>${heading}</h1><p>${safeMessage}</p></main></body></html>`;
    this.rendererOrigin = null;
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => undefined)
      .finally(() => this.show());
  }

  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  setAlwaysOnTop(value: boolean): void {
    this.current?.setAlwaysOnTop(value, 'floating');
  }

  setOpacity(value: number): void {
    this.current?.setOpacity(Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, value)));
  }

  toggleMiniMode(): boolean {
    // Retained as a compatibility no-op for older callers. Mini mode is
    // retired and the native window always remains in full mode.
    return false;
  }

  toggleVisibility(): boolean {
    const window = this.current;
    if (!window) return false;
    if (window.isVisible() && !window.isMinimized()) { window.hide(); return false; }
    if (window.isMinimized()) window.restore();
    window.showInactive();
    return true;
  }

  show(): void {
    const window = this.current;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    console.log('[window] explicit show', window.getBounds(), 'visible=', window.isVisible());
  }
  hide(): void { this.current?.hide(); }

  minimize(): void {
    const window = this.current;
    if (!window || window.isMinimized()) return;
    window.minimize();
  }

  getBounds(): WindowBounds | null {
    const window = this.current;
    if (!window) return null;
    const { x, y, width, height } = window.getBounds();
    return { x, y, width, height };
  }

  destroy(): void {
    const window = this.current;
    if (window) {
      this.allowClose = true;
      window.destroy();
    }
    this.window = null;
  }

  private normalizeBounds(bounds: WindowBounds): WindowBounds {
    const displays = screen.getAllDisplays();
    const display = displays.find((candidate) => {
      if (bounds.x === undefined || bounds.y === undefined) return false;
      return candidate.workArea.x <= bounds.x && candidate.workArea.x + candidate.workArea.width > bounds.x &&
        candidate.workArea.y <= bounds.y && candidate.workArea.y + candidate.workArea.height > bounds.y;
    }) ?? screen.getPrimaryDisplay();
    const width = Math.min(Math.max(bounds.width, MIN_WIDTH), display.workArea.width);
    const height = Math.min(Math.max(bounds.height, MIN_HEIGHT), display.workArea.height);
    const defaultX = display.workArea.x + display.workArea.width - width - 28;
    const defaultY = display.workArea.y + 28;
    const requestedX = bounds.x ?? defaultX;
    const requestedY = bounds.y ?? defaultY;
    const x = Math.min(Math.max(requestedX, display.workArea.x), display.workArea.x + display.workArea.width - width);
    const y = Math.min(Math.max(requestedY, display.workArea.y), display.workArea.y + display.workArea.height - height);
    return { x, y, width, height };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

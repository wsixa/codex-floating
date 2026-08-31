import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { IPC_CHANNELS, isCaptureRegion, type CaptureRegion, type Language } from '../shared/types';

const SELECTION_TIMEOUT = 120_000;

interface PendingSelection {
  resolve: (region: CaptureRegion | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns the transparent, full-display mouse selection window. */
export class CaptureSelectionService {
  private overlay: BrowserWindow | null = null;
  private pending: PendingSelection | null = null;

  constructor() {
    ipcMain.on(IPC_CHANNELS.captureSelectionComplete, this.handleComplete);
    ipcMain.on(IPC_CHANNELS.captureSelectionCancel, this.handleCancel);
  }

  async select(language: Language): Promise<CaptureRegion | null> {
    if (this.pending) return null;
    const display = screen.getPrimaryDisplay();
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'capture-selection-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.overlay = overlay;
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.on('closed', () => {
      if (this.overlay === overlay) {
        this.overlay = null;
        this.finish(null);
      }
    });

    const result = new Promise<CaptureRegion | null>((resolve) => {
      const timer = setTimeout(() => this.finish(null), SELECTION_TIMEOUT);
      this.pending = { resolve, timer };
    });
    overlay.webContents.on('did-finish-load', () => {
      if (this.overlay !== overlay || overlay.isDestroyed()) return;
      overlay.show();
      overlay.focus();
    });
    overlay.webContents.on('did-fail-load', () => this.finish(null));
    const html = createSelectionDocument(language);
    void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => this.finish(null));
    return result;
  }

  dispose(): void {
    ipcMain.removeListener(IPC_CHANNELS.captureSelectionComplete, this.handleComplete);
    ipcMain.removeListener(IPC_CHANNELS.captureSelectionCancel, this.handleCancel);
    this.finish(null);
  }

  private readonly handleComplete = (event: Electron.IpcMainEvent, value: unknown): void => {
    const overlay = this.overlay;
    if (!overlay || event.sender !== overlay.webContents || !isCaptureRegion(value)) return;
    this.finish({
      x: Math.round(value.x),
      y: Math.round(value.y),
      width: Math.round(value.width),
      height: Math.round(value.height),
    });
  };

  private readonly handleCancel = (event: Electron.IpcMainEvent): void => {
    if (this.overlay && event.sender === this.overlay.webContents) this.finish(null);
  };

  private finish(region: CaptureRegion | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    const overlay = this.overlay;
    this.overlay = null;
    if (overlay && !overlay.isDestroyed()) {
      // Hide synchronously before resolving so desktopCapturer cannot include
      // the selection border in the image captured on the next tick.
      overlay.hide();
      overlay.close();
    }
    pending.resolve(region);
  }
}

function createSelectionDocument(language: Language): string {
  const isChinese = language === 'zh-CN';
  const instruction = isChinese
    ? '按住鼠标拖动选择区域 · 松开完成 · Esc 取消'
    : 'Drag to select an area · Release to capture · Esc to cancel';
  const tooSmall = isChinese ? '选择范围太小，请重新拖动' : 'Selection is too small. Drag again.';
  return `<!doctype html>
<html lang="${isChinese ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
  body { cursor: crosshair; user-select: none; }
  #instruction { position: fixed; top: 22px; left: 50%; transform: translateX(-50%); padding: 9px 14px; color: #f2f7f8; background: rgba(13, 20, 24, .88); border: 1px solid rgba(194, 220, 224, .34); border-radius: 7px; box-shadow: 0 8px 24px rgba(0,0,0,.3); font-size: 13px; pointer-events: none; white-space: nowrap; }
  #selection { position: fixed; display: none; border: 2px solid #8ee6b7; background: rgba(142, 230, 183, .12); box-shadow: 0 0 0 99999px rgba(4, 10, 13, .58); pointer-events: none; }
  #size { position: absolute; left: 0; top: 100%; margin-top: 7px; padding: 3px 6px; color: #dff9ea; background: #163d2d; border-radius: 4px; font: 11px/1.2 "Segoe UI", system-ui, sans-serif; white-space: nowrap; }
  #notice { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); display: none; padding: 10px 14px; color: #fff; background: rgba(116, 45, 53, .94); border-radius: 6px; font-size: 12px; pointer-events: none; }
</style>
</head>
<body>
  <div id="instruction">${instruction}</div>
  <div id="selection"><span id="size"></span></div>
  <div id="notice">${tooSmall}</div>
<script>
(() => {
  const bridge = window.captureSelection;
  const selection = document.getElementById('selection');
  const size = document.getElementById('size');
  const notice = document.getElementById('notice');
  let start = null;
  let dragging = false;
  let noticeTimer = 0;
  const point = (event) => ({
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
  });
  const rectangle = (a, b) => ({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
  });
  const render = (rect) => {
    selection.style.display = 'block';
    selection.style.left = rect.x + 'px';
    selection.style.top = rect.y + 'px';
    selection.style.width = rect.width + 'px';
    selection.style.height = rect.height + 'px';
    size.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
  };
  const showTooSmall = () => {
    notice.style.display = 'block';
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { notice.style.display = 'none'; }, 1100);
  };
  const cancel = () => bridge?.cancel();
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel(); });
  document.addEventListener('contextmenu', (event) => { event.preventDefault(); cancel(); });
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || dragging) return;
    dragging = true;
    start = point(event);
    document.body.setPointerCapture?.(event.pointerId);
    render({ ...start, width: 0, height: 0 });
  });
  document.addEventListener('pointermove', (event) => {
    if (!dragging || !start) return;
    render(rectangle(start, point(event)));
  });
  document.addEventListener('pointerup', (event) => {
    if (!dragging || !start) return;
    const rect = rectangle(start, point(event));
    dragging = false;
    start = null;
    if (rect.width < 8 || rect.height < 8) { selection.style.display = 'none'; showTooSmall(); return; }
    bridge?.complete(rect);
  });
})();
</script>
</body>
</html>`;
}

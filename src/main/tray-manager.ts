import { Menu, nativeImage, Tray } from 'electron';
import type { Language } from '../shared/types';

export interface TrayActions {
  toggleVisibility: () => void;
  minimize: () => void;
  toggleMiniMode: () => void;
  capture: () => void;
  reconnect: () => void;
  quit: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private actions: TrayActions | null = null;
  private language: Language = 'zh-CN';

  create(actions: TrayActions, language: Language = 'zh-CN'): void {
    if (this.tray) return;
    this.actions = actions;
    this.language = language;
    const source = nativeImage.createFromDataURL(`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="2" width="28" height="28" rx="8" fill="#8be9b6"/><path d="M16 7l2.1 6.1L24 15l-5.9 2.1L16 23l-2.1-5.9L8 15l5.9-1.9z" fill="#102018"/></svg>')}`);
    // Windows notification icons are more reliable when passed as a small
    // raster image instead of an SVG-backed NativeImage.
    const icon = source.isEmpty() ? nativeImage.createEmpty() : source.resize({ width: 16, height: 16 });
    this.tray = new Tray(icon);
    this.tray.on('click', actions.toggleVisibility);
    this.rebuildMenu();
  }

  setLanguage(language: Language): void {
    this.language = language;
    this.rebuildMenu();
  }

  destroy(): void { this.tray?.destroy(); this.tray = null; this.actions = null; }

  private rebuildMenu(): void {
    if (!this.tray || !this.actions) return;
    const zh = this.language === 'zh-CN';
    this.tray.setToolTip(zh ? 'Codex 悬浮助手' : 'Codex Floating Assistant');
    const actions = this.actions;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: zh ? '显示 / 隐藏' : 'Show / Hide', click: actions.toggleVisibility },
      { label: zh ? '最小化到任务栏' : 'Minimize to taskbar', click: actions.minimize },
      { label: zh ? '迷你模式' : 'Mini mode', click: actions.toggleMiniMode },
      { type: 'separator' },
      { label: zh ? '截屏并发送' : 'Capture and send', click: actions.capture },
      { label: zh ? '重新连接 Codex' : 'Reconnect Codex', click: actions.reconnect },
      { type: 'separator' },
      { label: zh ? '退出' : 'Quit', click: actions.quit },
    ]));
  }
}

import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeWebContents {
    readonly session = { cookies: { set: vi.fn(async () => undefined) } };
    readonly listeners = new Map<string, Listener[]>();
    loadURL = vi.fn(async () => undefined);
    executeJavaScript = vi.fn(async () => undefined);
    setVisualZoomLevelLimits = vi.fn(async () => undefined);
    close = vi.fn();

    isDestroyed(): boolean { return false; }
    on(event: string, listener: Listener): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    once(event: string, listener: Listener): void {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      this.on(event, wrapped);
    }
    removeListener(event: string, listener: Listener): void {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((value) => value !== listener));
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeBrowserView {
    readonly webContents = new FakeWebContents();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  }

  const views: FakeBrowserView[] = [];
  return {
    BrowserView: class extends FakeBrowserView {
      constructor() {
        super();
        views.push(this);
      }
    },
    views,
  };
});

vi.mock('electron', () => ({ BrowserView: electronMock.BrowserView }));

import type { BrowserWindow } from 'electron';
import { OFFICIAL_PAGE_COMPACT_SCRIPT, OfficialPageHost } from './official-page-host';

function createWindow(): BrowserWindow & { addBrowserView: ReturnType<typeof vi.fn>; removeBrowserView: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 420, height: 640 }),
    isDestroyed: () => false,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined as never;
    },
  } as unknown as BrowserWindow & { addBrowserView: ReturnType<typeof vi.fn>; removeBrowserView: ReturnType<typeof vi.fn> };
}

describe('official page compact injection', () => {
  it('hides surrounding chrome while keeping the official composer visible', () => {
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('data-app-action-sidebar');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('#app-shell-sidebar');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('data-app-shell-unified-tab-strip');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('right-panel');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('[data-codex-composer]');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toMatch(/data-codex-composer[^']*display:\s*none/i);
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toContain('[role="banner"]');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toContain('[data-testid*="header"');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toContain('[data-testid*="sidebar"');
  });

  it('does not cover the shell until the official page has loaded', async () => {
    electronMock.views.length = 0;
    const window = createWindow();
    const host = new OfficialPageHost(window);

    host.setVisible(true);
    expect(window.addBrowserView).not.toHaveBeenCalled();

    await host.load('https://chatgpt.com/codex');
    expect(window.addBrowserView).toHaveBeenCalledTimes(1);
    expect(electronMock.views[0]?.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 48, width: 420, height: 592 });

    host.setVisible(false);
    expect(window.removeBrowserView).toHaveBeenCalledTimes(1);
  });

  it('keeps the shell visible when the embedded page fails to load', async () => {
    electronMock.views.length = 0;
    const window = createWindow();
    const host = new OfficialPageHost(window);
    const view = electronMock.views[0];
    view?.webContents.loadURL.mockRejectedValueOnce(new Error('network unavailable'));

    host.setVisible(true);
    await expect(host.load('https://chatgpt.com/codex')).rejects.toThrow('network unavailable');
    expect(window.addBrowserView).not.toHaveBeenCalled();
  });
});

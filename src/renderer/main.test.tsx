// @vitest-environment jsdom
import { act } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../shared/types';

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    config: {
      mode: 'api',
      language: 'zh-CN',
      codexUrl: 'https://chatgpt.com/codex',
      lastPageUrl: null,
      lastThreadId: null,
      selectedProjectId: null,
      apiBaseUrl: 'http://127.0.0.1:15721/v1',
      apiModel: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      apiKeyConfigured: true,
      window: { width: 430, height: 640 },
      opacity: 0.96,
      alwaysOnTop: true,
      miniMode: false,
      theme: 'dark',
      launchAtLogin: false,
    },
    connection: 'connected',
    connectionMessage: '已连接',
    page: null,
    project: null,
    conversations: [],
    activeConversationId: null,
    availableModels: [{ id: 'gpt-5.6-sol' }],
    isCapturing: false,
    isSending: false,
    isDeleting: false,
    lastError: null,
    lastResponse: null,
    startedAt: Date.now(),
    ...overrides,
  };
}

const state = createState();
const sendMessage = vi.fn(async () => state);
const toggleAlwaysOnTop = vi.fn(async () => state);
const stateListeners = new Set<(next: AppState) => void>();

beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.codexAssistant = {
    getState: async () => state,
    onState: (listener: (next: AppState) => void) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    setOfficialPageOverlayOpen: async () => undefined,
    sendMessage,
    toggleAlwaysOnTop,
  } as unknown as typeof window.codexAssistant;
  // Importing the module runs the renderer bootstrap and mounts <App />.
  await act(async () => {
    await import('./main');
  });
});

beforeEach(() => {
  sendMessage.mockClear();
  toggleAlwaysOnTop.mockClear();
});

async function emitState(next: AppState): Promise<void> {
  await act(async () => {
    stateListeners.forEach((listener) => listener(next));
  });
}

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector('textarea');
  if (!element) throw new Error('Composer textarea is missing.');
  return element;
}

async function typeMessage(value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Textarea value setter is missing.');
  await act(async () => {
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(init: KeyboardEventInit = {}, composing = false): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  if (composing) Object.defineProperty(event, 'isComposing', { value: true });
  await act(async () => {
    textarea().dispatchEvent(event);
  });
  return event;
}

describe('composer Enter behaviour', () => {
  it('sends the message on plain Enter and prevents the newline', async () => {
    await typeMessage('你好 Codex');
    const event = await pressEnter();
    expect(event.defaultPrevented).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ text: '你好 Codex', attachments: [] });
  });

  it('does not send on Ctrl+Enter and keeps the default newline', async () => {
    await typeMessage('第一行');
    const event = await pressEnter({ ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send on Meta+Enter and keeps the default newline', async () => {
    await typeMessage('first line');
    const event = await pressEnter({ metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send while an IME composition is active', async () => {
    await typeMessage('正在输入');
    const event = await pressEnter({}, true);
    expect(event.defaultPrevented).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send an empty message on Enter', async () => {
    await typeMessage('   ');
    const event = await pressEnter();
    expect(event.defaultPrevented).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('always-on-top pin button', () => {
  function pinButton(): HTMLButtonElement {
    const element = document.querySelector<HTMLButtonElement>('.toolbar-actions .pin-toggle');
    if (!element) throw new Error('Pin toggle button is missing.');
    return element;
  }

  it('calls toggleAlwaysOnTop when clicked', async () => {
    await act(async () => {
      pinButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggleAlwaysOnTop).toHaveBeenCalledTimes(1);
  });

  it('reflects appState.config.alwaysOnTop via aria-pressed', async () => {
    expect(pinButton().getAttribute('aria-pressed')).toBe('true');
    await emitState(createState({ config: { ...state.config, alwaysOnTop: false } }));
    expect(pinButton().getAttribute('aria-pressed')).toBe('false');
    expect(pinButton().classList.contains('is-active')).toBe(false);
    await emitState(createState({ config: { ...state.config, alwaysOnTop: true } }));
    expect(pinButton().getAttribute('aria-pressed')).toBe('true');
    expect(pinButton().classList.contains('is-active')).toBe(true);
  });
});

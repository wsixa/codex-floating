import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter, modelMenuLabel } from './codex-adapter';

describe('model menu parsing', () => {
  it('keeps model choices and removes reasoning controls', () => {
    expect(modelMenuLabel('5.6 Sol')).toBe('5.6 Sol');
    expect(modelMenuLabel('GPT-5.5')).toBe('GPT-5.5');
    expect(modelMenuLabel('高级')).toBeNull();
    expect(modelMenuLabel('极高')).toBeNull();
    expect(modelMenuLabel('最高')).toBeNull();
    expect(modelMenuLabel('Reasoning effort')).toBeNull();
    expect(modelMenuLabel('High')).toBeNull();
    expect(modelMenuLabel('xhigh')).toBeNull();
  });
});

describe('Desktop conversation detection', () => {
  it('uses a short timeout while the selected row is being replaced', async () => {
    const getAttribute = vi.fn(async () => null);
    const page = {
      url: () => 'app://-/index.html',
      locator: () => ({ first: () => ({ getAttribute }) }),
    } as unknown as Page;

    await expect(new CodexAdapter(page).currentDesktopConversationId()).resolves.toBeNull();
    expect(getAttribute).toHaveBeenCalledWith('data-app-action-sidebar-thread-id', { timeout: 700 });
  });
});

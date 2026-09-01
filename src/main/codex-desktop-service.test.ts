import { describe, expect, it, vi } from 'vitest';
import { CodexDesktopService, normalizeDesktopModelId } from './codex-desktop-service';

describe('desktop model IDs', () => {
  it('normalizes display labels to stable Codex model IDs', () => {
    expect(normalizeDesktopModelId('5.6 Sol')).toBe('gpt-5.6-sol');
    expect(normalizeDesktopModelId('5.6 Terra')).toBe('gpt-5.6-terra');
    expect(normalizeDesktopModelId('GPT-5.5')).toBe('gpt-5.5');
    expect(normalizeDesktopModelId('custom-model')).toBe('custom-model');
  });
});

describe('Desktop draft synchronization', () => {
  it('does not let a stale existing selection replace a new draft', async () => {
    const service = new CodexDesktopService();
    const currentDesktopConversationId = vi.fn()
      .mockResolvedValueOnce('local:old-thread')
      .mockResolvedValueOnce('local:new-thread');
    const harness = service as unknown as {
      adapter: {
        currentDesktopConversationId: typeof currentDesktopConversationId;
        isDesktopHomeConversation(): Promise<boolean>;
      };
      page: { isClosed(): boolean };
      activeThreadId: string | null;
      draftConversationId: string | null;
      draftExistingThreadIds: Set<string> | null;
      refreshActiveConversationId(): Promise<void>;
    };
    harness.adapter = {
      currentDesktopConversationId,
      isDesktopHomeConversation: async () => false,
    };
    harness.page = { isClosed: () => false };
    harness.activeThreadId = 'desktop-draft:test';
    harness.draftConversationId = 'desktop-draft:test';
    harness.draftExistingThreadIds = new Set(['local:old-thread']);

    await harness.refreshActiveConversationId();
    expect(harness.activeThreadId).toBe('desktop-draft:test');
    expect(harness.draftConversationId).toBe('desktop-draft:test');

    await harness.refreshActiveConversationId();
    expect(harness.activeThreadId).toBe('local:new-thread');
    expect(harness.draftConversationId).toBeNull();
  });

  it('coalesces concurrent sidebar list refreshes', async () => {
    const service = new CodexDesktopService();
    const listConversations = vi.fn(async () => [{ id: 'local:one', title: 'One' }]);
    const harness = service as unknown as {
      adapter: {
        listConversations: typeof listConversations;
        currentDesktopConversationId(): Promise<string | null>;
      };
      page: { isClosed(): boolean };
    };
    harness.adapter = {
      listConversations,
      currentDesktopConversationId: async () => 'local:one',
    };
    harness.page = { isClosed: () => false };

    await Promise.all([service.listConversations(), service.listConversations()]);
    expect(listConversations).toHaveBeenCalledTimes(1);
  });
});

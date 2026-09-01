import { describe, expect, it } from 'vitest';
import { CodexAppServerService, type AppServerTransport } from './codex-app-server';
import type { AppConfig } from '../shared/types';

const config: AppConfig = {
  mode: 'api',
  language: 'zh-CN',
  codexUrl: 'https://chatgpt.com/codex',
  lastPageUrl: null,
  lastThreadId: null,
  apiBaseUrl: 'http://127.0.0.1:15721/v1',
  apiModel: 'gpt-5.6-sol',
  apiKeyConfigured: false,
  shortcut: 'Ctrl+Shift+Alt+S',
  window: { width: 430, height: 640 },
  opacity: 0.96,
  alwaysOnTop: true,
  miniMode: false,
  theme: 'system',
  launchAtLogin: false,
};

class FakeTransport implements AppServerTransport {
  private onMessage: ((message: unknown) => void) | null = null;
  private nextThread = 1;
  private hideNextStartedThreadFromList = false;
  private readonly threads = new Map<string, { id: string; name: string | null; preview: string; updatedAt: number }>();

  async start(onMessage: (message: unknown) => void): Promise<void> { this.onMessage = onMessage; }
  async stop(): Promise<void> { this.onMessage = null; }

  send(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return;
    const method = message.method;
    const params = message.params as Record<string, unknown> | undefined;
    if (method === 'initialize') {
      this.reply(message.id, { codexHome: 'C:\\Users\\test\\.codex', platformFamily: 'windows', platformOs: 'windows', userAgent: 'test' });
    } else if (method === 'thread/list') {
      const values = [...this.threads.values()];
      const data = this.hideNextStartedThreadFromList ? values.slice(0, -1) : values;
      this.hideNextStartedThreadFromList = false;
      this.reply(message.id, { data, nextCursor: null, backwardsCursor: null });
    } else if (method === 'thread/start') {
      const id = `thread-${this.nextThread++}`;
      const thread = { id, name: null, preview: '', updatedAt: Date.now() / 1000 };
      this.threads.set(id, thread);
      this.hideNextStartedThreadFromList = true;
      this.reply(message.id, { thread: { ...thread, turns: [] }, model: 'gpt-5.6-sol', modelProvider: 'custom', cwd: 'D:\\codex-platform', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } });
    } else if (method === 'thread/resume') {
      const thread = this.threads.get(String(params?.threadId));
      this.reply(message.id, { thread: { ...thread, turns: [] }, model: 'gpt-5.6-sol', modelProvider: 'custom', cwd: 'D:\\codex-platform', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } });
    } else if (method === 'thread/name/set') {
      const thread = this.threads.get(String(params?.threadId));
      if (thread) thread.name = String(params?.name ?? '');
      this.reply(message.id, {});
      this.notify('thread/name/updated', { threadId: params?.threadId, threadName: thread?.name });
    } else if (method === 'turn/start') {
      const threadId = String(params?.threadId);
      const turn = { id: 'turn-1', status: 'inProgress', items: [] };
      this.reply(message.id, { turn });
      setTimeout(() => {
        this.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'item-1', delta: '同步回复' });
        this.notify('turn/completed', { threadId, turn: { id: turn.id, status: 'completed', items: [{ type: 'agentMessage', text: '同步回复', phase: 'final_answer' }] } });
      }, 0);
    } else if (method === 'model/list') {
      this.reply(message.id, { data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', hidden: false }], nextCursor: null });
    } else if (method === 'thread/delete') {
      this.threads.delete(String(params?.threadId));
      this.reply(message.id, {});
    } else {
      this.reply(message.id, {});
    }
  }

  private reply(id: number, result: unknown): void { queueMicrotask(() => this.onMessage?.({ id, result })); }
  private notify(method: string, params: unknown): void { queueMicrotask(() => this.onMessage?.({ method, params })); }
}

describe('CodexAppServerService', () => {
  it('keeps a newly created thread active when the first list refresh is stale', async () => {
    const service = new CodexAppServerService({
      cwd: 'D:\\codex-platform',
      attachmentDirectory: 'D:\\codex-platform\\output\\test-attachments',
      transportFactory: async () => new FakeTransport(),
    });
    await service.connect(config);
    await service.newConversation();
    const id = service.currentConversationId;
    expect(id).toMatch(/^thread-/);
    await service.listConversations();
    expect(service.currentConversationId).toBe(id);
    await service.disconnect();
  });

  it('uses official thread ids and synchronizes create, send, list, model, and delete', async () => {
    const service = new CodexAppServerService({
      cwd: 'D:\\codex-platform',
      attachmentDirectory: 'D:\\codex-platform\\output\\test-attachments',
      transportFactory: async () => new FakeTransport(),
    });
    await expect(service.connect(config)).resolves.toMatchObject({ state: 'connected' });
    await service.newConversation();
    const id = service.currentConversationId;
    expect(id).toMatch(/^thread-/);
    expect(service.prepareMessageTitle('检查同步标题')[0]?.title).toBe('检查同步标题');
    await expect(service.sendMessage('检查同步标题', [])).resolves.toBe('同步回复');
    await expect(service.listModels()).resolves.toEqual([{ id: 'gpt-5.6-sol' }]);
    await expect(service.deleteConversation(id!)).resolves.toEqual([]);
    await service.disconnect();
  });
});

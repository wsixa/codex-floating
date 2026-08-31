import path from 'node:path';
import { CodexAppServerService } from '../src/main/codex-app-server';
import type { AppConfig } from '../src/shared/types';

/** Read-only local smoke check for the official app-server. */
async function main(): Promise<void> {
  const config: AppConfig = {
    mode: 'api',
    language: 'zh-CN',
    codexUrl: 'https://chatgpt.com/codex',
    lastPageUrl: null,
    lastThreadId: null,
    apiBaseUrl: 'http://127.0.0.1:15721/v1',
    apiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-sol',
    apiKeyConfigured: false,
    window: { width: 430, height: 640 },
    opacity: 0.96,
    alwaysOnTop: true,
    miniMode: false,
    theme: 'system',
    launchAtLogin: false,
  };
  const service = new CodexAppServerService({
    cwd: process.cwd(),
    attachmentDirectory: path.join(process.cwd(), 'output', 'smoke-attachments'),
  });
  const status = await service.connect(config);
  const conversations = status.state === 'connected' ? await service.listConversations() : [];
  const models = status.state === 'connected' ? await service.listModels().catch(() => []) : [];
  console.log(JSON.stringify({
    state: status.state,
    message: status.message,
    threadCount: conversations.length,
    activeThreadId: service.currentConversationId,
    modelCount: models.length,
  }, null, 2));
  await service.disconnect();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

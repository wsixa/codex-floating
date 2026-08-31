import { CodexDesktopService } from '../src/main/codex-desktop-service';
import { defaultConfig } from '../src/main/config-service';

/** Read-only smoke check against an already-running official Codex Desktop. */
async function main(): Promise<void> {
  const service = new CodexDesktopService();
  const status = await service.connect({ ...defaultConfig(), mode: 'api' });
  const conversations = status.state === 'connected' || status.state === 'login-required'
    ? await service.listConversations().catch(() => [])
    : [];
  const models = status.state === 'connected'
    ? await service.listModels().catch(() => [])
    : [];
  console.log(JSON.stringify({
    state: status.state,
    message: status.message,
    pageUrl: status.page?.url ?? null,
    composerAvailable: status.page?.inputAvailable ?? false,
    threadCount: conversations.length,
    activeThreadId: service.currentConversationId,
    modelCount: models.length,
    models: models.slice(0, 32),
  }, null, 2));
  await service.disconnect();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});


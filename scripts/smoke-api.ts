import { createServer } from 'node:http';
import { ApiService } from '../src/main/api-service';
import type { AppConfig } from '../src/shared/types';

async function main(): Promise<void> {
  let requestCount = 0;
  let modelRequestCount = 0;
  let previousResponseId: string | undefined;
  let releaseFirstResponse: () => void = () => undefined;
  let firstRequestSeenResolve: (() => void) | null = null;
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequestSeen = new Promise<void>((resolve) => { firstRequestSeenResolve = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    if (request.url?.endsWith('/models')) {
      modelRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-model', owned_by: 'smoke-upstream' }, { id: 'mock-vision' }] }));
      return;
    }
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    requestCount += 1;
    if (requestCount === 1) {
      firstRequestSeenResolve?.();
      await firstResponseGate;
    }
    if (requestCount > 1 && body.previous_response_id !== previousResponseId) throw new Error('Response chain was not preserved.');
    const id = `mock-response-${requestCount}`;
    previousResponseId = id;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id, output_text: `mock answer ${requestCount}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start API mock server.');
  const config: AppConfig = {
    mode: 'api',
    language: 'zh-CN',
    codexUrl: 'https://chatgpt.com/codex',
    lastPageUrl: null,
    lastThreadId: null,
    selectedProjectId: null,
    apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiModel: 'mock-model',
    reasoningEffort: 'high',
    apiKeyConfigured: true,
    window: { width: 430, height: 640 },
    opacity: 0.96,
    alwaysOnTop: true,
    miniMode: false,
    theme: 'system',
    launchAtLogin: false,
  };
  try {
    // Keep this deterministic mock independent from the developer's live
    // Codex model catalog; catalog loading is covered by ApiService tests.
    const service = new ApiService(async () => []);
    if ((await service.connect(config, 'sk-smoke')).state !== 'connected') throw new Error('API service did not connect.');
    const models = await service.listModels();
    if (models.length !== 2 || models[0].id !== 'mock-model') throw new Error('Model list request failed.');
    const firstMessage = service.sendText('hello from a delayed request');
    await firstRequestSeen;
    const immediateSessions = await service.listConversations();
    if (immediateSessions[0]?.title !== 'hello from a delayed request') {
      throw new Error('Conversation title was not updated before the response arrived.');
    }
    releaseFirstResponse?.();
    if (await firstMessage !== 'mock answer 1') throw new Error('Text request failed.');
    if (await service.uploadAndSend({ buffer: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 1, height: 1, capturedAt: 1 }, 'inspect') !== 'mock answer 2') throw new Error('Image request failed.');
    const sessions = await service.listConversations();
    await service.newConversation();
    const nextSessions = await service.listConversations();
    if (nextSessions[0]?.title !== 'New conversation') throw new Error('New API conversation did not keep its draft title.');
    const draftSession = nextSessions[0];
    if (!draftSession || (await service.deleteConversation(draftSession.id)).some((session) => session.id === draftSession.id)) {
      throw new Error('API conversation deletion did not update the local session list.');
    }
    await service.switchConversation(sessions[0].id);
    console.log(JSON.stringify({ ok: true, responseRequests: requestCount, modelRequests: modelRequestCount, models: models.map((model) => model.id), sessions: nextSessions.length }, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

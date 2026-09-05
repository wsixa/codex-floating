import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService, loadCodexModelCatalog, parseCodexModelCatalog, parseModelList } from './api-service';
import type { AppConfig } from '../shared/types';

const config: AppConfig = {
  mode: 'api',
  language: 'zh-CN',
  codexUrl: 'https://chatgpt.com/codex',
  lastPageUrl: null,
  lastThreadId: null,
  selectedProjectId: null,
  apiBaseUrl: 'https://api.openai.com/v1',
  apiModel: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  apiKeyConfigured: true,
  window: { width: 430, height: 640 },
  opacity: 0.96,
  alwaysOnTop: true,
  miniMode: false,
  theme: 'system',
  launchAtLogin: false,
};

// Keep transport tests independent from the host user's live Codex catalog;
// catalog parsing/loading is covered explicitly below.
const createTestService = () => new ApiService(async () => []);

describe('ApiService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends text and chains the next request without exposing the key to the payload', async () => {
    const requests: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push({ init });
      return new Response(JSON.stringify({ id: `resp-${requests.length}`, output_text: `answer ${requests.length}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const service = createTestService();
    expect((await service.connect(config, 'sk-test-secret')).state).toBe('connected');
    await expect(service.listConversations()).resolves.toEqual([
      expect.objectContaining({ title: 'New conversation' }),
    ]);
    const firstMessage = service.sendText('hello');
    // The title is available while the network request is still pending.
    await expect(service.listConversations()).resolves.toEqual([
      expect.objectContaining({ title: 'hello' }),
    ]);
    await expect(firstMessage).resolves.toBe('answer 1');
    await expect(service.listConversations()).resolves.toEqual([
      expect.objectContaining({ title: 'hello' }),
    ]);
    await expect(service.uploadAndSend({ buffer: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 1, height: 1, capturedAt: 1 }, 'look')).resolves.toBe('answer 2');
    await expect(service.listConversations()).resolves.toEqual([
      expect.objectContaining({ title: 'hello' }),
    ]);
    const firstBody = JSON.parse(String(requests[0].init?.body)) as Record<string, unknown>;
    const secondBody = JSON.parse(String(requests[1].init?.body)) as Record<string, unknown>;
    expect(firstBody).not.toHaveProperty('apiKey');
    expect(secondBody.previous_response_id).toBe('resp-1');
    expect(JSON.stringify(secondBody)).toContain('data:image/png;base64,AQID');
    expect(JSON.stringify(secondBody)).not.toContain('sk-test-secret');
  });

  it('encodes non-image attachments as Responses input_file parts', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'file-response', output_text: 'file answer' }), { status: 200 });
    }));
    const service = createTestService();
    await service.connect(config, 'sk-test-secret');
    const data = new Uint8Array([0x68, 0x69]);
    await expect(service.sendMessage('inspect this document', [{ id: 'doc-1', name: 'notes.txt', mimeType: 'text/plain', size: data.byteLength, data }])).resolves.toBe('file answer');
    const input = body?.input as Array<{ content?: Array<Record<string, unknown>> }>;
    const content = input[0]?.content ?? [];
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' }),
    ]));
  });

  it('reports a missing key without making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = createTestService();
    expect((await service.connect(config, null)).state).toBe('api-key-required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes local API conversations and selects the next available session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'response-1', output_text: 'answer' }), { status: 200 })));
    const service = createTestService();
    await service.connect(config, 'sk-test-secret');
    await service.sendText('keep this session');
    const first = (await service.listConversations())[0];
    if (!first) throw new Error('Expected an API conversation.');
    await service.newConversation();
    const draft = (await service.listConversations())[0];
    if (!draft || draft.id === first.id) throw new Error('Expected a second API conversation.');
    await expect(service.deleteConversation(draft.id)).resolves.toEqual([
      expect.objectContaining({ id: first.id, title: 'keep this session' }),
    ]);
    expect(service.currentConversationId).toBe(first.id);
    await expect(service.deleteConversation(first.id)).resolves.toEqual([]);
    expect(service.currentConversationId).toBeNull();
  });

  it('allows the CCSwitch local proxy to send without a provider key', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let authorization = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'proxy-response', output_text: 'proxy answer' }), { status: 200 });
    }));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    expect((await service.connect(proxyConfig, 'sk-should-not-be-forwarded')).state).toBe('connected');
    await expect(service.sendText('hello proxy')).resolves.toBe('proxy answer');
    expect(authorization).toBe('Bearer PROXY_MANAGED');
    await expect(service.sendText('second proxy message')).resolves.toBe('proxy answer');
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).not.toHaveProperty('previous_response_id');
    expect(requestBodies[1]).not.toHaveProperty('previous_response_id');
    expect((requestBodies[1].input as unknown[])).toHaveLength(3);
  });

  it('retries without previous_response_id when a compatible HTTP gateway rejects it', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      if (body.previous_response_id) {
        return new Response(JSON.stringify({ error: { message: 'previous_response_id is only supported on Responses WebSocket v2' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ id: `response-${requestBodies.length}`, output_text: 'fallback answer' }), { status: 200 });
    }));
    const service = createTestService();
    expect((await service.connect(config, 'sk-test-secret')).state).toBe('connected');
    await service.sendText('first');
    await expect(service.sendText('second')).resolves.toBe('fallback answer');
    expect(requestBodies[1]).toHaveProperty('previous_response_id');
    expect(requestBodies[2]).not.toHaveProperty('previous_response_id');
    expect((requestBodies[2].input as unknown[]).length).toBe(3);
  });

  it('keeps an HTTP-level API error retryable instead of reporting CCSwitch disconnected', async () => {
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/responses')) {
        requestCount += 1;
        if (requestCount === 1) return new Response(JSON.stringify({ error: { message: 'model rejected this input' } }), { status: 400 });
        return new Response(JSON.stringify({ id: 'retry-response', output_text: 'retry succeeded' }), { status: 200 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.sendText('first attempt')).rejects.toThrow('model rejected this input');
    expect(service.currentStatus.state).toBe('connected');
    await expect(service.sendText('retry attempt')).resolves.toBe('retry succeeded');
  });

  it('allows a retry after a transient CCSwitch transport failure', async () => {
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/responses')) {
        requestCount += 1;
        if (requestCount === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ id: 'transport-retry-response', output_text: 'transport retry succeeded' }), { status: 200 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.sendText('network attempt')).rejects.toThrow('Unable to reach the OpenAI API');
    expect(service.currentStatus.state).toBe('error');
    await expect(service.sendText('network retry')).resolves.toBe('transport retry succeeded');
    expect(service.currentStatus.state).toBe('connected');
  });

  it('loads and sanitizes the upstream model catalog', async () => {
    let requestedUrl = '';
    let authorization = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requestedUrl = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ data: [
        { id: 'gpt-5.6-sol', owned_by: 'upstream' },
        { id: 'gpt-5.6-sol', owned_by: 'duplicate' },
        { model_name: '  gpt-5.5  ' },
        { id: 'bad\u0000model' },
        { display_name: 'missing-id' },
      ] }), { status: 200 });
    }));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    expect((await service.connect(proxyConfig, null)).state).toBe('connected');
    await expect(service.listModels()).resolves.toEqual([
      { id: 'gpt-5.6-sol', ownedBy: 'upstream' },
      { id: 'gpt-5.5' },
    ]);
    expect(requestedUrl).toBe('http://127.0.0.1:15721/v1/models');
    expect(authorization).toBe('Bearer PROXY_MANAGED');
  });

  it('accepts a plain model array from compatible gateways', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(['model-a', { id: 'model-b' }]), { status: 200 })));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://localhost:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.listModels()).resolves.toEqual([{ id: 'model-a' }, { id: 'model-b' }]);
  });

  it('falls back to id when a model entry has an empty slug', () => {
    expect(parseModelList({ data: [{ slug: ' ', id: 'fallback-model' }] })).toEqual([{ id: 'fallback-model' }]);
  });

  it('merges live Codex catalog models when CCSwitch returns only a partial list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gateway-model' }] }), { status: 200 })));
    const service = new ApiService(async () => [{ id: 'catalog-model' }, { id: 'gateway-model' }]);
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.listModels()).resolves.toEqual([{ id: 'gateway-model' }, { id: 'catalog-model' }]);
  });

  it('merges the local Codex catalog for a direct remote API and deduplicates slug/id variants', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'models/gateway-model', owned_by: 'remote' },
      { id: 'remote-only' },
    ] }), { status: 200 })));
    const service = new ApiService(async () => [
      { id: 'gateway-model' },
      { id: 'catalog-only' },
    ]);
    await service.connect(config, 'sk-test-secret');
    await expect(service.listModels()).resolves.toEqual([
      { id: 'gateway-model', ownedBy: 'remote' },
      { id: 'remote-only' },
      { id: 'catalog-only' },
    ]);
  });

  it('keeps an empty catalog usable when CCSwitch has no upstream models yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.listModels()).resolves.toEqual([]);
    expect(service.currentStatus.state).toBe('connected');
  });

  it('parses Codex catalog slugs without exposing catalog instructions', () => {
    expect(parseCodexModelCatalog({
      models: [
        { slug: ' catalog-model ', display_name: 'Friendly name', base_instructions: 'do not return this' },
        { slug: 'catalog-model' },
        { id: 'fallback-id' },
        { slug: 'hidden-model', visibility: 'hidden' },
        { slug: 'not-api-model', supported_in_api: false },
        { slug: '' },
        { display_name: 'missing-slug' },
      ],
    })).toEqual([
      { id: 'catalog-model' },
      { id: 'fallback-id' },
      { id: 'hidden-model' },
      { id: 'not-api-model' },
    ]);
  });

  it('loads and merges multiple Codex catalog files, newest file first', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-catalog-test-'));
    const catalogs = path.join(root, 'model-catalogs');
    await fs.mkdir(catalogs);
    await fs.writeFile(path.join(catalogs, 'older.json'), JSON.stringify({ models: [{ slug: 'older-model' }, { slug: 'shared-model' }] }));
    await fs.writeFile(path.join(catalogs, 'newer.json'), JSON.stringify({ models: [{ slug: 'new-model' }, { slug: 'shared-model' }] }));
    const now = Date.now() / 1000;
    await fs.utimes(path.join(catalogs, 'older.json'), now - 10, now - 10);
    await fs.utimes(path.join(catalogs, 'newer.json'), now, now);
    await expect(loadCodexModelCatalog(root)).resolves.toEqual([
      { id: 'new-model' },
      { id: 'shared-model' },
      { id: 'older-model' },
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('honors model_catalog_json from Codex config when the catalog directory is absent', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-catalog-test-'));
    const catalogPath = path.join(root, 'relay-catalog.json');
    await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'configured-model' }] }));
    await fs.writeFile(path.join(root, 'config.toml'), `model_catalog_json = "${catalogPath.replaceAll('\\\\', '/')}"\n`);
    await expect(loadCodexModelCatalog(root)).resolves.toEqual([{ id: 'configured-model' }]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('supports the legacy CCSwitch catalog filename at CODEX_HOME root', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-legacy-catalog-test-'));
    await fs.writeFile(path.join(root, 'cc-switch-model-catalog.json'), JSON.stringify({ models: [{ slug: 'legacy-model' }] }));
    await expect(loadCodexModelCatalog(root)).resolves.toEqual([{ id: 'legacy-model' }]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps the API session usable when the optional model catalog cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503 });
      }
      return new Response(JSON.stringify({ id: 'response-after-catalog-error', output_text: 'still usable' }), { status: 200 });
    }));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.listModels()).rejects.toThrow('upstream unavailable');
    expect(service.currentStatus.state).toBe('connected');
    await expect(service.sendText('use configured model')).resolves.toBe('still usable');
  });

  it('uses the cached Codex catalog when CCSwitch model discovery is temporarily offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const service = new ApiService(async () => [{ id: 'cached-model' }]);
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.listModels()).resolves.toEqual([{ id: 'cached-model' }]);
    expect(service.currentStatus.state).toBe('connected');
  });

  it('marks the API unavailable when the model catalog cannot reach CCSwitch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    await expect(service.listModels()).rejects.toThrow('Unable to reach the upstream model service');
    expect(service.currentStatus.state).toBe('error');
  });

  it('does not let an intentional catalog cancellation overwrite a reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const service = createTestService();
    const proxyConfig = { ...config, apiBaseUrl: 'http://127.0.0.1:15721/v1', apiKeyConfigured: false };
    await service.connect(proxyConfig, null);
    const pending = service.listModels();
    await Promise.resolve();
    await service.connect(proxyConfig, null);
    await expect(pending).rejects.toThrow('Model list request cancelled');
    expect(service.currentStatus.state).toBe('connected');
  });
});

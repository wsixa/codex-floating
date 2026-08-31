import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ApiModelOption,
  AppConfig,
  AttachmentPayload,
  ConnectionState,
  ConversationSummary,
  PageState,
} from '../shared/types';
import { isPlaceholderConversationTitle, NEW_CONVERSATION_TITLE, summarizeConversationTitle } from '../shared/types';

const RPC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const MAX_THREAD_PAGES = 10;
const MAX_MODEL_PAGES = 10;

export interface CodexAppServerStatus {
  state: ConnectionState;
  message: string;
  page?: PageState | null;
}

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface RpcErrorShape {
  code?: unknown;
  message?: unknown;
}

interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string;
  updatedAt?: number;
  cwd?: string;
}

interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: { message?: string } | null;
  items?: Array<{ type?: string; text?: string; phase?: string | null }>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface PendingTurn {
  threadId: string;
  turnId: string | null;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerTransport {
  start(onMessage: (message: unknown) => void, onClose: (error: Error) => void): Promise<void>;
  send(message: RpcRequest | RpcNotification | RpcResponse): void;
  stop(): Promise<void>;
}

export type AppServerTransportFactory = () => Promise<AppServerTransport>;

export interface CodexAppServerOptions {
  cwd: string;
  attachmentDirectory: string;
  transportFactory?: AppServerTransportFactory;
}

/**
 * Talks to the official Codex app-server. Threads created here are persisted
 * in the same CODEX_HOME used by Codex Desktop and the CLI.
 */
export class CodexAppServerService {
  private transport: AppServerTransport | null = null;
  private config: AppConfig | null = null;
  private status: CodexAppServerStatus = { state: 'disconnected', message: 'Codex client is not connected' };
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private pendingTurn: PendingTurn | null = null;
  private readonly threads = new Map<string, CodexThread>();
  private readonly loadedThreadIds = new Set<string>();
  private activeThreadId: string | null = null;
  private pendingThreadName: string | null = null;
  private codexHome: string | null = null;
  private codexWatcher: fs.FSWatcher | null = null;
  private watcherRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<ConversationSummary[]> | null = null;
  private readonly statusListeners = new Set<(status: CodexAppServerStatus) => void>();
  private readonly threadListeners = new Set<() => void>();

  constructor(private readonly options: CodexAppServerOptions) {}

  get currentStatus(): CodexAppServerStatus {
    return { ...this.status };
  }

  get currentConversationId(): string | null {
    return this.activeThreadId;
  }

  onStatus(listener: (status: CodexAppServerStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onThreadsChanged(listener: () => void): () => void {
    this.threadListeners.add(listener);
    return () => this.threadListeners.delete(listener);
  }

  async connect(config: AppConfig): Promise<CodexAppServerStatus> {
    await this.disconnect();
    this.config = config;
    this.setStatus('connecting', 'Connecting to the Codex desktop session store...');
    try {
      this.transport = this.options.transportFactory
        ? await this.options.transportFactory()
        : new StdioAppServerTransport(await resolveCodexExecutable());
      await this.transport.start(
        (message) => this.handleMessage(message),
        (error) => this.handleTransportClose(error),
      );
      const initialized = asRecord(await this.request('initialize', {
        clientInfo: {
          name: 'codex-floating-assistant',
          title: 'Codex Floating Assistant',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }));
      this.notify('initialized');
      this.codexHome = typeof initialized?.codexHome === 'string' ? initialized.codexHome : null;
      await this.refreshThreads();
      const preferredThread = config.lastThreadId && this.threads.has(config.lastThreadId)
        ? config.lastThreadId
        : this.sortedThreads()[0]?.id ?? null;
      this.activeThreadId = preferredThread;
      this.startCodexHomeWatcher();
      this.setStatus('connected', 'Connected to Codex Desktop');
    } catch (error) {
      const message = formatAppServerError(error);
      await this.stopTransport();
      this.setStatus('error', message);
    }
    return this.currentStatus;
  }

  async disconnect(): Promise<void> {
    this.stopCodexHomeWatcher();
    this.rejectAllPending(new Error('Codex app-server disconnected.'));
    await this.stopTransport();
    this.config = null;
    this.threads.clear();
    this.loadedThreadIds.clear();
    this.activeThreadId = null;
    this.pendingThreadName = null;
    this.codexHome = null;
    if (this.status.state !== 'error') this.setStatus('disconnected', 'Codex client is not connected');
  }

  async listConversations(): Promise<ConversationSummary[]> {
    await this.refreshThreads();
    return this.conversationSummaries();
  }

  async newConversation(): Promise<void> {
    const config = this.requireConfig();
    const result = asRecord(await this.request('thread/start', {
      cwd: this.options.cwd,
      model: config.apiModel,
      ephemeral: false,
      approvalPolicy: 'never',
      threadSource: 'codex-floating-assistant',
      sessionStartSource: 'clear',
    }));
    const thread = parseThread(result?.thread);
    if (!thread) throw new Error('Codex did not return the new thread.');
    this.threads.set(thread.id, thread);
    this.loadedThreadIds.add(thread.id);
    this.activeThreadId = thread.id;
    this.pendingThreadName = null;
    this.emitThreadsChanged();
  }

  async switchConversation(id: string): Promise<void> {
    if (!this.threads.has(id)) await this.refreshThreads();
    if (!this.threads.has(id)) throw new Error('The Codex conversation is no longer available.');
    await this.resumeThread(id);
    this.activeThreadId = id;
    this.pendingThreadName = null;
    this.emitThreadsChanged();
  }

  async deleteConversation(id: string): Promise<ConversationSummary[]> {
    if (!this.threads.has(id)) await this.refreshThreads();
    if (!this.threads.has(id)) throw new Error('The Codex conversation is no longer available.');
    await this.request('thread/delete', { threadId: id });
    this.threads.delete(id);
    this.loadedThreadIds.delete(id);
    if (this.activeThreadId === id) this.activeThreadId = this.sortedThreads()[0]?.id ?? null;
    this.emitThreadsChanged();
    return this.conversationSummaries();
  }

  /** Update the UI immediately; sendMessage persists the same name first. */
  prepareMessageTitle(content: string): ConversationSummary[] {
    const active = this.activeThreadId ? this.threads.get(this.activeThreadId) : null;
    if (!active) return this.conversationSummaries();
    const currentTitle = threadTitle(active);
    if (isPlaceholderConversationTitle(currentTitle) || !active.name?.trim()) {
      const title = summarizeConversationTitle(content, this.config?.language ?? 'zh-CN');
      active.name = title;
      active.updatedAt = Date.now() / 1000;
      this.pendingThreadName = title;
      this.emitThreadsChanged();
    }
    return this.conversationSummaries();
  }

  async sendMessage(text: string, attachments: AttachmentPayload[]): Promise<string> {
    const config = this.requireConfig();
    if (!this.activeThreadId) await this.newConversation();
    const threadId = this.activeThreadId;
    if (!threadId) throw new Error('Codex did not create a conversation.');
    await this.resumeThread(threadId);
    if (this.pendingThreadName) {
      const name = this.pendingThreadName;
      await this.request('thread/name/set', { threadId, name });
      if (this.pendingThreadName === name) this.pendingThreadName = null;
    }

    const input: Array<Record<string, unknown>> = [];
    const prompt = text.trim();
    if (prompt) input.push({ type: 'text', text: prompt, text_elements: [] });
    for (const attachment of attachments) {
      const attachmentPath = await this.persistAttachment(threadId, attachment);
      input.push(attachment.mimeType.toLowerCase().startsWith('image/')
        ? { type: 'localImage', path: attachmentPath }
        : { type: 'mention', name: attachment.name, path: attachmentPath });
    }
    if (input.length === 0) throw new Error('Message cannot be empty.');

    const completion = this.createTurnWaiter(threadId);
    try {
      const result = asRecord(await this.request('turn/start', {
        threadId,
        input,
        model: config.apiModel,
        approvalPolicy: 'never',
      }));
      const turn = parseTurn(result?.turn);
      if (!turn) throw new Error('Codex did not start the turn.');
      if (this.pendingTurn?.threadId === threadId) this.pendingTurn.turnId = turn.id;
      const response = await completion;
      await this.refreshThreads().catch(() => undefined);
      return response;
    } catch (error) {
      this.rejectPendingTurn(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async uploadAndSend(capture: { buffer: Uint8Array; mimeType: string; width: number; height: number; capturedAt: number }, text?: string): Promise<string> {
    const extension = capture.mimeType === 'image/png' ? 'png' : 'jpg';
    const data = new Uint8Array(capture.buffer);
    return this.sendMessage(text ?? '', [{
      id: `capture-${capture.capturedAt}`,
      name: `codex-capture-${capture.capturedAt}.${extension}`,
      mimeType: capture.mimeType,
      size: data.byteLength,
      data,
      width: capture.width,
      height: capture.height,
    }]);
  }

  async listModels(): Promise<ApiModelOption[]> {
    this.requireTransport();
    const models: ApiModelOption[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const result = asRecord(await this.request('model/list', { cursor, limit: 100, includeHidden: false }));
      for (const value of Array.isArray(result?.data) ? result.data : []) {
        const model = asRecord(value);
        const id = typeof model?.model === 'string' ? model.model.trim() : typeof model?.id === 'string' ? model.id.trim() : '';
        if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id) || model?.hidden === true) continue;
        seen.add(id);
        models.push({ id });
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return models;
  }

  private async refreshThreads(): Promise<ConversationSummary[]> {
    this.requireTransport();
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.fetchThreads().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async fetchThreads(): Promise<ConversationSummary[]> {
    const next = new Map<string, CodexThread>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const result = asRecord(await this.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
      }));
      for (const value of Array.isArray(result?.data) ? result.data : []) {
        const thread = parseThread(value);
        if (thread) next.set(thread.id, thread);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    // Preserve a synchronous optimistic name until app-server confirms it.
    if (this.activeThreadId && this.pendingThreadName) {
      const thread = next.get(this.activeThreadId);
      if (thread) thread.name = this.pendingThreadName;
    }
    this.threads.clear();
    for (const [id, thread] of next) this.threads.set(id, thread);
    if (this.activeThreadId && !this.threads.has(this.activeThreadId)) this.activeThreadId = this.sortedThreads()[0]?.id ?? null;
    this.emitThreadsChanged();
    return this.conversationSummaries();
  }

  private async resumeThread(id: string): Promise<void> {
    if (this.loadedThreadIds.has(id)) return;
    const result = asRecord(await this.request('thread/resume', { threadId: id, excludeTurns: true }));
    const thread = parseThread(result?.thread);
    if (!thread) throw new Error('Codex could not resume the conversation.');
    this.threads.set(thread.id, thread);
    this.loadedThreadIds.add(thread.id);
  }

  private conversationSummaries(): ConversationSummary[] {
    return this.sortedThreads().map((thread) => ({ id: thread.id, title: threadTitle(thread) }));
  }

  private sortedThreads(): CodexThread[] {
    return [...this.threads.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  private request(method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    const transport = this.requireTransport();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        transport.send({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.requireTransport().send({ method, ...(params === undefined ? {} : { params }) });
  }

  private handleMessage(message: unknown): void {
    const record = asRecord(message);
    if (!record) return;
    if ((typeof record.id === 'number' || typeof record.id === 'string') && typeof record.method !== 'string') {
      this.handleResponse(record as unknown as RpcResponse);
      return;
    }
    if (typeof record.method !== 'string') return;
    if (typeof record.id === 'number' || typeof record.id === 'string') {
      this.handleServerRequest(record.id, record.method);
      return;
    }
    this.handleNotification(record.method, record.params);
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);
    if (response.error) {
      const message = sanitizeErrorMessage(response.error.message || `Codex request failed: ${pending.method}`);
      pending.reject(new Error(message));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const values = asRecord(params);
    if (method === 'item/agentMessage/delta' && values && typeof values.threadId === 'string' && typeof values.delta === 'string') {
      if (this.pendingTurn?.threadId === values.threadId) this.pendingTurn.text += values.delta;
      return;
    }
    if (method === 'turn/completed' && values && typeof values.threadId === 'string') {
      const turn = parseTurn(values.turn);
      if (turn) this.completeTurn(values.threadId, turn);
      return;
    }
    if (method === 'thread/name/updated' && values && typeof values.threadId === 'string') {
      const thread = this.threads.get(values.threadId);
      if (thread) thread.name = typeof values.threadName === 'string' ? values.threadName : null;
      if (values.threadId === this.activeThreadId) this.pendingThreadName = null;
      this.emitThreadsChanged();
      return;
    }
    if (method === 'thread/deleted' && values && typeof values.threadId === 'string') {
      this.threads.delete(values.threadId);
      this.loadedThreadIds.delete(values.threadId);
      if (this.activeThreadId === values.threadId) this.activeThreadId = this.sortedThreads()[0]?.id ?? null;
      this.emitThreadsChanged();
      return;
    }
    if (method === 'thread/started' || method === 'thread/archived' || method === 'thread/unarchived') {
      this.scheduleWatcherRefresh();
    }
  }

  private handleServerRequest(id: number | string, method: string): void {
    const result = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
      ? { decision: 'decline' }
      : method === 'execCommandApproval' || method === 'applyPatchApproval'
        ? { decision: 'denied' }
        : method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : method === 'mcpServer/elicitation/request'
            ? { action: 'decline', content: null, _meta: null }
            : method === 'item/tool/call'
              ? { contentItems: [], success: false }
              : null;
    if (result) {
      this.transport?.send({ id, result } as RpcResponse);
      return;
    }
    this.transport?.send({
      id,
      error: { code: -32601, message: 'This request requires the full Codex client.' },
    } as RpcResponse);
  }

  private createTurnWaiter(threadId: string): Promise<string> {
    if (this.pendingTurn) throw new Error('Another Codex turn is already running.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingTurn?.threadId === threadId) {
          const turnId = this.pendingTurn.turnId;
          this.pendingTurn = null;
          if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        }
        reject(new Error('Codex turn timed out after 5 minutes.'));
      }, TURN_TIMEOUT_MS);
      this.pendingTurn = { threadId, turnId: null, text: '', resolve, reject, timer };
    });
  }

  private completeTurn(threadId: string, turn: CodexTurn): void {
    const pending = this.pendingTurn;
    if (!pending || pending.threadId !== threadId || (pending.turnId && pending.turnId !== turn.id)) return;
    clearTimeout(pending.timer);
    this.pendingTurn = null;
    if (turn.status === 'failed') {
      pending.reject(new Error(sanitizeErrorMessage(turn.error?.message || 'Codex turn failed.')));
      return;
    }
    if (turn.status === 'interrupted') {
      pending.reject(new Error('Codex turn was interrupted.'));
      return;
    }
    const completedText = extractTurnText(turn);
    pending.resolve((completedText || pending.text).trim());
  }

  private rejectPendingTurn(error: Error): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTurn = null;
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.rejectPendingTurn(error);
  }

  private async persistAttachment(threadId: string, attachment: AttachmentPayload): Promise<string> {
    const safeThreadId = threadId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
    const safeName = attachment.name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'attachment.bin';
    const directory = path.join(this.options.attachmentDirectory, safeThreadId);
    await fsp.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${Date.now()}-${randomSuffix()}-${safeName}`);
    await fsp.writeFile(filePath, attachment.data, { flag: 'wx' });
    return filePath;
  }

  private startCodexHomeWatcher(): void {
    this.stopCodexHomeWatcher();
    if (!this.codexHome) return;
    try {
      this.codexWatcher = fs.watch(this.codexHome, (_event, fileName) => {
        const name = String(fileName ?? '');
        if (/^(?:session_index\.jsonl|state_.*\.sqlite|thread_history_.*\.sqlite)/i.test(name)) this.scheduleWatcherRefresh();
      });
      this.codexWatcher.on('error', () => this.stopCodexHomeWatcher());
    } catch {
      this.codexWatcher = null;
    }
  }

  private scheduleWatcherRefresh(): void {
    if (!this.transport || this.status.state !== 'connected') return;
    if (this.watcherRefreshTimer) clearTimeout(this.watcherRefreshTimer);
    this.watcherRefreshTimer = setTimeout(() => {
      this.watcherRefreshTimer = null;
      void this.refreshThreads().catch(() => undefined);
    }, 500);
  }

  private stopCodexHomeWatcher(): void {
    if (this.watcherRefreshTimer) clearTimeout(this.watcherRefreshTimer);
    this.watcherRefreshTimer = null;
    this.codexWatcher?.close();
    this.codexWatcher = null;
  }

  private async stopTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.stop().catch(() => undefined);
  }

  private handleTransportClose(error: Error): void {
    if (!this.transport) return;
    this.transport = null;
    this.stopCodexHomeWatcher();
    this.rejectAllPending(error);
    this.setStatus('disconnected', sanitizeErrorMessage(error.message));
  }

  private requireTransport(): AppServerTransport {
    if (!this.transport) throw new Error('Codex Desktop is not connected. Press Reconnect.');
    return this.transport;
  }

  private requireConfig(): AppConfig {
    this.requireTransport();
    if (!this.config) throw new Error('Codex Desktop is not connected. Press Reconnect.');
    return this.config;
  }

  private setStatus(state: ConnectionState, message: string): void {
    this.status = { state, message };
    for (const listener of this.statusListeners) listener(this.currentStatus);
  }

  private emitThreadsChanged(): void {
    for (const listener of this.threadListeners) listener();
  }
}

class StdioAppServerTransport implements AppServerTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stopping = false;
  private stderrTail = '';

  constructor(private readonly executable: string) {}

  async start(onMessage: (message: unknown) => void, onClose: (error: Error) => void): Promise<void> {
    if (this.child) throw new Error('Codex app-server is already running.');
    this.stopping = false;
    const child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: process.cwd(),
      env: appServerEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      if (this.stdoutBuffer.byteLength > MAX_RPC_LINE_BYTES) {
        onClose(new Error('Codex app-server sent an oversized response.'));
        void this.stop();
        return;
      }
      while (true) {
        const newline = this.stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = this.stdoutBuffer.subarray(0, newline).toString('utf8').trim();
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line) as unknown);
        } catch {
          // Ignore non-protocol stdout without echoing potentially sensitive content.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(/\s+/g, ' ').trim();
      if (text) this.stderrTail = sanitizeErrorMessage(text).slice(-800);
    });
    child.once('error', (error) => onClose(new Error(`Unable to start Codex app-server: ${error.message}`)));
    child.once('exit', (code, signal) => {
      this.child = null;
      if (!this.stopping) {
        const detail = this.stderrTail ? ` ${this.stderrTail}` : '';
        onClose(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'}).${detail}`));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex app-server did not start in time.')), 10_000);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  send(message: RpcRequest | RpcNotification | RpcResponse): void {
    if (!this.child || !this.child.stdin.writable) throw new Error('Codex app-server is not writable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1_500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

/**
 * The assistant can itself be launched from a Codex-managed terminal. Those
 * terminals carry sandbox/session variables that make a child app-server use
 * the disposable `CodexSandboxOffline` home instead of the user's desktop
 * Codex store. Strip only those orchestration variables and keep the normal
 * user CODEX_HOME (or the Windows default) so threads are genuinely shared.
 */
function appServerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    'CODEX_CI',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_PERMISSION_PROFILE',
  ]) delete environment[key];
  if (!environment.CODEX_HOME?.trim()) environment.CODEX_HOME = path.join(os.homedir(), '.codex');
  return environment;
}

async function resolveCodexExecutable(): Promise<string> {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured) {
    await fsp.access(configured, fs.constants.X_OK);
    return configured;
  }
  if (process.platform !== 'win32') return 'codex';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    const versions = await fsp.readdir(binRoot, { withFileTypes: true });
    const candidates = await Promise.all(versions.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const filePath = path.join(binRoot, entry.name, 'codex.exe');
      try {
        const stats = await fsp.stat(filePath);
        return { filePath, mtimeMs: stats.mtimeMs };
      } catch {
        return null;
      }
    }));
    const newest = candidates.filter((value): value is { filePath: string; mtimeMs: number } => value !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (newest) return newest.filePath;
  } catch {
    // PATH resolution below supports CLI and CCSwitch-managed installations.
  }
  return 'codex';
}

function parseThread(value: unknown): CodexThread | null {
  const thread = asRecord(value);
  if (!thread || typeof thread.id !== 'string' || !thread.id || thread.id.length > 512) return null;
  return {
    id: thread.id,
    name: typeof thread.name === 'string' ? thread.name.slice(0, 500) : null,
    preview: typeof thread.preview === 'string' ? thread.preview.slice(0, 500) : '',
    updatedAt: typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0,
    cwd: typeof thread.cwd === 'string' ? thread.cwd : undefined,
  };
}

function parseTurn(value: unknown): CodexTurn | null {
  const turn = asRecord(value);
  if (!turn || typeof turn.id !== 'string' || !['completed', 'interrupted', 'failed', 'inProgress'].includes(String(turn.status))) return null;
  const error = asRecord(turn.error);
  return {
    id: turn.id,
    status: turn.status as CodexTurn['status'],
    error: error ? { message: typeof error.message === 'string' ? error.message : undefined } : null,
    items: Array.isArray(turn.items) ? turn.items.map((item) => {
      const record = asRecord(item);
      return {
        type: typeof record?.type === 'string' ? record.type : undefined,
        text: typeof record?.text === 'string' ? record.text : undefined,
        phase: typeof record?.phase === 'string' ? record.phase : null,
      };
    }) : [],
  };
}

function extractTurnText(turn: CodexTurn): string {
  const messages = (turn.items ?? []).filter((item) => item.type === 'agentMessage' && typeof item.text === 'string');
  const finalMessages = messages.filter((item) => item.phase === 'final_answer');
  return (finalMessages.length > 0 ? finalMessages : messages).map((item) => item.text).join('\n').trim();
}

function threadTitle(thread: CodexThread): string {
  const name = thread.name?.replace(/\s+/g, ' ').trim();
  if (name) return truncateTitle(name);
  const preview = thread.preview?.replace(/\s+/g, ' ').trim();
  return preview ? truncateTitle(preview) : NEW_CONVERSATION_TITLE;
}

function truncateTitle(value: string): string {
  const characters = Array.from(value);
  return characters.length <= 80 ? value : `${characters.slice(0, 79).join('')}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .slice(0, 500);
}

function formatAppServerError(error: unknown): string {
  const record = asRecord(error);
  const rpcError = asRecord(record?.error) as RpcErrorShape | null;
  const message = error instanceof Error
    ? error.message
    : typeof rpcError?.message === 'string'
      ? rpcError.message
      : String(error);
  if (/ENOENT|not recognized|cannot find/i.test(message)) {
    return 'Codex CLI was not found. Install or update Codex Desktop, then press Reconnect.';
  }
  return sanitizeErrorMessage(message);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

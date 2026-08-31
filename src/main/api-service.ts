import { isPlaceholderConversationTitle, NEW_CONVERSATION_TITLE, summarizeConversationTitle, type ApiModelOption, type AppConfig, type AttachmentPayload, type CapturePayload, type ConnectionState, type ConversationSummary } from '../shared/types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REQUEST_TIMEOUT = 60_000;
const MODEL_LIST_TIMEOUT = 12_000;
const MAX_TEXT = 30_000;
const LOCAL_PROXY_BEARER = 'PROXY_MANAGED';
const MAX_HISTORY_MESSAGES = 24;
const MAX_MODELS = 512;
const CODEX_MODEL_CATALOG_DIRECTORY = 'model-catalogs';
const LEGACY_MODEL_CATALOG_FILES = ['cc-switch-model-catalog.json', 'model-catalog.json'] as const;
const MAX_MODEL_CATALOG_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_PATH_LENGTH = 2048;

interface ApiStatus {
  state: ConnectionState;
  message: string;
}

interface ApiConversation {
  id: string;
  title: string;
  responseId: string | null;
  updatedAt: number;
  isDraft: boolean;
  history: ApiInputMessage[];
}

interface InputTextPart {
  type: 'input_text';
  text: string;
}

interface InputImagePart {
  type: 'input_image';
  image_url: string;
}

interface InputFilePart {
  type: 'input_file';
  filename: string;
  file_data: string;
}

type InputPart = InputTextPart | InputImagePart | InputFilePart;
type ApiInputMessage =
  | { role: 'user'; content: InputPart[] }
  // Use input_text for replayed assistant turns; this is accepted by both
  // OpenAI Responses and CCSwitch-compatible HTTP gateways.
  | { role: 'assistant'; content: InputTextPart[] };

interface ApiResponse {
  id?: string;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

export type ModelCatalogLoader = () => Promise<ApiModelOption[]>;

interface ApiModelRecord {
  slug?: unknown;
  id?: unknown;
  name?: unknown;
  model?: unknown;
  model_name?: unknown;
  model_id?: unknown;
  modelId?: unknown;
  owned_by?: unknown;
  ownedBy?: unknown;
  supported_in_api?: unknown;
  visibility?: unknown;
}

export class ApiService {
  constructor(private readonly modelCatalogLoader: ModelCatalogLoader = defaultModelCatalogLoader) {}

  private config: AppConfig | null = null;
  private apiKey: string | null = null;
  private status: ApiStatus = { state: 'disconnected', message: 'API is not connected' };
  private readonly conversations = new Map<string, ApiConversation>();
  private activeConversationId: string | null = null;
  private modelRequestController: AbortController | null = null;
  // CCSwitch's HTTP Responses route rejects previous_response_id. This flag
  // is also learned dynamically for other compatible gateways.
  private previousResponseUnsupported = false;

  get currentStatus(): ApiStatus {
    return { ...this.status };
  }

  get currentConversationId(): string | null {
    return this.activeConversationId;
  }

  async connect(config: AppConfig, apiKey: string | null): Promise<ApiStatus> {
    this.modelRequestController?.abort();
    this.modelRequestController = null;
    this.config = config;
    this.apiKey = isLocalProxy(config.apiBaseUrl) ? null : apiKey;
    this.previousResponseUnsupported = isCcswitchProxy(config.apiBaseUrl);
    if (!apiKey && !isLocalProxy(config.apiBaseUrl)) {
      this.setStatus('api-key-required', 'Configure an API key in Settings.');
      return this.currentStatus;
    }
    try {
      const baseUrl = new URL(config.apiBaseUrl);
      if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(baseUrl.hostname))) {
        throw new Error('API base URL must use HTTPS (or localhost HTTP).');
      }
      this.ensureConversation();
      this.setStatus('connected', 'API connected');
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : 'API configuration is invalid.');
    }
    return this.currentStatus;
  }

  async disconnect(): Promise<void> {
    this.modelRequestController?.abort();
    this.modelRequestController = null;
    this.config = null;
    this.apiKey = null;
    this.previousResponseUnsupported = false;
    this.setStatus('disconnected', 'API is not connected');
  }

  async sendText(text: string): Promise<string> {
    const value = text.trim();
    if (!value) throw new Error('Message cannot be empty.');
    if (value.length > MAX_TEXT) throw new Error('Message is too long (30,000 characters maximum).');
    return this.sendMessage(value, []);
  }

  async uploadAndSend(capture: CapturePayload, text?: string): Promise<string> {
    return this.sendMessage(text ?? '', [captureAttachment(capture)]);
  }

  async sendMessage(text: string, attachments: AttachmentPayload[]): Promise<string> {
    const prompt = text.trim();
    if (prompt.length > MAX_TEXT) throw new Error('Message is too long (30,000 characters maximum).');
    if (!prompt && attachments.length === 0) throw new Error('Message cannot be empty.');
    const parts: InputPart[] = attachments.map((attachment) => attachmentToInputPart(attachment));
    if (prompt) parts.unshift({ type: 'input_text', text: prompt.slice(0, MAX_TEXT) });
    const title = prompt || attachmentTitle(attachments[0], this.config?.language ?? 'zh-CN');
    this.prepareMessageTitle(title);
    return this.request(parts, title);
  }

  async newConversation(): Promise<void> {
    const id = `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.conversations.set(id, { id, title: NEW_CONVERSATION_TITLE, responseId: null, updatedAt: this.nextConversationTimestamp(), isDraft: true, history: [] });
    this.activeConversationId = id;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.conversationSummaries();
  }

  /** Rename/reorder the active conversation before the remote request starts. */
  prepareMessageTitle(content: string): ConversationSummary[] {
    const conversation = this.ensureConversation();
    if (isPlaceholderConversationTitle(conversation.title)) {
      conversation.title = summarizeConversationTitle(content, this.config?.language ?? 'zh-CN');
      conversation.isDraft = false;
    }
    conversation.updatedAt = this.nextConversationTimestamp();
    return this.conversationSummaries();
  }

  private conversationSummaries(): ConversationSummary[] {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((conversation) => ({ id: conversation.id, title: conversation.title }));
  }

  async switchConversation(id: string): Promise<void> {
    if (!this.conversations.has(id)) throw new Error('API conversation is no longer available.');
    this.activeConversationId = id;
  }

  /**
   * Remove a locally maintained Responses conversation. Compatible Responses
   * gateways do not expose a portable conversation-delete endpoint, so the
   * API transport can only remove the assistant's local response chain.
   */
  async deleteConversation(id: string): Promise<ConversationSummary[]> {
    if (!this.conversations.delete(id)) throw new Error('API conversation is no longer available.');
    if (this.activeConversationId === id) {
      this.activeConversationId = [...this.conversations.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
    }
    return this.conversationSummaries();
  }

  /**
   * Read the model catalog from the active upstream. The renderer only receives
   * sanitized ids, never the endpoint, authorization header, or raw response.
   */
  async listModels(): Promise<ApiModelOption[]> {
    const config = this.config;
    if (!config || (!this.apiKey && !isLocalProxy(config.apiBaseUrl))) {
      throw new Error(isLocalProxy(config?.apiBaseUrl ?? '')
        ? 'CCSwitch is not connected. Start CCSwitch and press Reconnect.'
        : 'API is not connected. Configure an API key and press Reconnect.');
    }
    const endpoint = `${config.apiBaseUrl.replace(/\/$/, '')}/models`;
    this.modelRequestController?.abort();
    const controller = new AbortController();
    // A model catalog is optional for compatible gateways. Keep an already
    // established API session connected when only this auxiliary endpoint
    // fails; the user can continue using the configured model and refresh the
    // catalog later.
    const wasConnected = this.status.state === 'connected';
    this.modelRequestController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MODEL_LIST_TIMEOUT);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { authorization: this.authorizationHeader() },
        signal: controller.signal,
      });
      let data: unknown = null;
      try { data = await response.json(); } catch { /* handled as an empty/invalid catalog below */ }
      if (!response.ok) {
        const message = extractApiError(data) ?? `Model list request failed (${response.status}).`;
        throw new Error(sanitizeApiError(message));
      }
      const models = parseModelList(data);
      // CCSwitch intentionally returns an empty or partial OpenAI-compatible
      // /models response for some provider routes. Codex itself keeps the
      // effective model list in read-only JSON catalog files under
      // %USERPROFILE%\.codex\model-catalogs. Merge that catalog for local
      // routes so models visible in Codex remain selectable here as well.
      // Only validated model IDs leave this process; credentials, provider
      // settings, and the catalog's instruction text are never read.
      const localModels = await this.loadCodexModelsForConfig(config);
      const effectiveModels = mergeModelLists(models, localModels);
      this.setStatus('connected', 'API connected');
      return effectiveModels;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      // A local CCSwitch route can still be useful when its optional
      // /models endpoint is unavailable. In that case, fall back to the
      // current Codex catalog, but never hide an intentional cancellation.
      // A timeout is a transport failure and can still be recovered from a
      // local catalog. A plain AbortError without the timeout marker is an
      // intentional cancellation caused by reconnect/disconnect and must
      // continue to reject promptly.
      if ((timedOut || !aborted) && isLocalProxy(config.apiBaseUrl)) {
        const localModels = await this.loadCodexModelsForConfig(config);
        if (localModels.length > 0) {
          this.setStatus('connected', 'API connected');
          return localModels;
        }
      }
      const message = aborted
        ? (timedOut ? 'Model list request timed out after 12 seconds.' : 'Model list request cancelled.')
        : error instanceof Error && error.message === 'fetch failed'
          ? 'Unable to reach the upstream model service. Check CCSwitch and network settings.'
          : error instanceof Error ? error.message : String(error);
      const transportFailure = timedOut || /fetch failed|Unable to reach the upstream model service/i.test(message);
      if (!wasConnected || transportFailure) this.setStatus('error', message.slice(0, 500));
      throw new Error(message.slice(0, 500));
    } finally {
      clearTimeout(timeout);
      if (this.modelRequestController === controller) this.modelRequestController = null;
    }
  }

  private async request(parts: InputPart[], title: string): Promise<string> {
    const hasConfiguredTransport = Boolean(this.config && (this.apiKey || isLocalProxy(this.config.apiBaseUrl)));
    const canRetryAfterError = this.status.state === 'error' && hasConfiguredTransport;
    if (!this.config || !hasConfiguredTransport || (this.status.state !== 'connected' && !canRetryAfterError)) {
      throw new Error(this.requestUnavailableMessage());
    }
    const conversation = this.ensureConversation();
    const currentInput: ApiInputMessage = { role: 'user', content: parts };
    const usePreviousResponse = Boolean(conversation.responseId) && !this.previousResponseUnsupported;
    const body: Record<string, unknown> = {
      model: this.config.apiModel,
      input: usePreviousResponse ? [currentInput] : [...conversation.history, currentInput],
    };
    if (usePreviousResponse && conversation.responseId) body.previous_response_id = conversation.responseId;
    const endpoint = `${this.config.apiBaseUrl.replace(/\/$/, '')}/responses`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      let response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: this.authorizationHeader(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let data = await response.json() as ApiResponse;
      const errorMessage = data.error?.message ?? `API request failed (${response.status}).`;
      // Some gateways expose HTTP Responses but only support
      // previous_response_id on WebSocket v2. Retry once with local history.
      if (!response.ok && usePreviousResponse && isPreviousResponseUnsupportedError(errorMessage)) {
        this.previousResponseUnsupported = true;
        const fallbackBody: Record<string, unknown> = {
          model: this.config.apiModel,
          input: [...conversation.history, currentInput],
        };
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: this.authorizationHeader(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(fallbackBody),
          signal: controller.signal,
        });
        data = await response.json() as ApiResponse;
      }
      if (!response.ok) throw new Error(sanitizeApiError(data.error?.message ?? `API request failed (${response.status}).`));
      const answer = extractOutputText(data);
      if (!answer) throw new Error('The API returned an empty response.');
      conversation.responseId = typeof data.id === 'string' ? data.id : conversation.responseId;
      conversation.history.push(currentInput, { role: 'assistant', content: [{ type: 'input_text', text: answer }] });
      if (conversation.history.length > MAX_HISTORY_MESSAGES) {
        conversation.history.splice(0, conversation.history.length - MAX_HISTORY_MESSAGES);
      }
      if (conversation.isDraft || isPlaceholderConversationTitle(conversation.title)) {
        conversation.title = summarizeConversationTitle(title, this.config?.language ?? 'zh-CN');
        conversation.isDraft = false;
      }
      conversation.updatedAt = this.nextConversationTimestamp();
      this.setStatus('connected', 'API connected');
      return answer.slice(0, 50_000);
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'API request timed out after 60 seconds.'
        : error instanceof Error && error.message === 'fetch failed'
          ? 'Unable to reach the OpenAI API. Check network or proxy settings.'
          : error instanceof Error ? error.message : String(error);
      // HTTP/API errors mean the route answered and CCSwitch is still
      // reachable. Keep the session retryable instead of turning the next
      // message into the misleading "CCSwitch is not connected" error.
      if (isTransportFailureMessage(message)) this.setStatus('error', message.slice(0, 500));
      else this.setStatus('connected', 'API connected');
      throw new Error(message.slice(0, 500));
    } finally {
      clearTimeout(timeout);
    }
  }

  private ensureConversation(): ApiConversation {
    if (this.activeConversationId && this.conversations.has(this.activeConversationId)) {
      return this.conversations.get(this.activeConversationId)!;
    }
    const id = `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conversation: ApiConversation = { id, title: NEW_CONVERSATION_TITLE, responseId: null, updatedAt: this.nextConversationTimestamp(), isDraft: true, history: [] };
    this.conversations.set(id, conversation);
    this.activeConversationId = id;
    return conversation;
  }

  private setStatus(state: ConnectionState, message: string): void {
    this.status = { state, message };
  }

  private nextConversationTimestamp(): number {
    const latest = [...this.conversations.values()].reduce((maximum, conversation) => Math.max(maximum, conversation.updatedAt), 0);
    return Math.max(Date.now(), latest + 1);
  }

  private authorizationHeader(): string {
    return `Bearer ${isLocalProxy(this.config?.apiBaseUrl ?? '') ? LOCAL_PROXY_BEARER : this.apiKey ?? ''}`;
  }

  private requestUnavailableMessage(): string {
    if (this.status.state === 'error' && this.status.message && this.status.message !== 'API is not connected') {
      return this.status.message;
    }
    return isLocalProxy(this.config?.apiBaseUrl ?? '')
      ? 'CCSwitch is not connected. Start CCSwitch and press Reconnect.'
      : 'API is not connected. Configure an API key and press Reconnect.';
  }

  private async loadCodexModelsForConfig(config: AppConfig): Promise<ApiModelOption[]> {
    // The local catalog belongs to the CCSwitch/relay setup. Do not mix it
    // into a direct remote OpenAI connection, where it could advertise
    // unavailable models.
    if (!isLocalProxy(config.apiBaseUrl)) return [];
    try {
      return await this.modelCatalogLoader();
    } catch {
      // A catalog refresh is auxiliary; a malformed or locked file must not
      // prevent the configured model from sending messages.
      return [];
    }
  }
}

function defaultModelCatalogLoader(): Promise<ApiModelOption[]> {
  // Keep the loader environment-agnostic so packaged Electron and diagnostic
  // Node harnesses observe the same Codex model catalog. Tests that need a
  // deterministic list inject their own loader into ApiService.
  return loadCodexModelCatalog();
}

function extractOutputText(data: ApiResponse): string {
  if (typeof data.output_text === 'string') return data.output_text.trim();
  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && (content.type === undefined || /text/i.test(content.type))) chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

function sanitizeApiError(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .slice(0, 500);
}

function isTransportFailureMessage(message: string): boolean {
  return /fetch failed|timed out|unable to reach|network|connection reset|socket|econn|enotfound|503|502|504/i.test(message);
}

function isPreviousResponseUnsupportedError(message: string): boolean {
  return /previous_response_id/i.test(message) && /websocket|webs*socket|only supported|not supported|unsupported/i.test(message);
}

function captureAttachment(capture: CapturePayload): AttachmentPayload {
  const extension = capture.mimeType === 'image/png' ? 'png' : 'jpg';
  const data = new Uint8Array(capture.buffer);
  return {
    id: `capture-${capture.capturedAt}`,
    name: `codex-capture-${capture.capturedAt}.${extension}`,
    mimeType: capture.mimeType,
    size: data.byteLength,
    data,
    width: capture.width,
    height: capture.height,
  };
}

function attachmentTitle(attachment: AttachmentPayload | undefined, language: AppConfig['language']): string {
  if (!attachment) return language === 'zh-CN' ? '附件分析' : 'Attachment analysis';
  if (/^codex-capture-/i.test(attachment.name)) return language === 'zh-CN' ? '截图分析' : 'Screenshot analysis';
  return attachment.name;
}

function attachmentToInputPart(attachment: AttachmentPayload): InputPart {
  const encoded = Buffer.from(attachment.data).toString('base64');
  const dataUrl = `data:${attachment.mimeType};base64,${encoded}`;
  if (attachment.mimeType.toLowerCase().startsWith('image/')) {
    return { type: 'input_image', image_url: dataUrl };
  }
  return { type: 'input_file', filename: attachment.name, file_data: dataUrl };
}

function extractApiError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return typeof (value as { message?: unknown }).message === 'string' ? (value as { message: string }).message : null;
}

export function parseModelList(value: unknown): ApiModelOption[] {
  const root = value && typeof value === 'object' ? value as { data?: unknown; models?: unknown } : null;
  const entries = Array.isArray(value) ? value : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const seen = new Set<string>();
  const models: ApiModelOption[] = [];
  for (const entry of entries) {
    const record = typeof entry === 'string' ? { id: entry } : entry && typeof entry === 'object' ? entry as ApiModelRecord : null;
    if (record && record.supported_in_api === false) continue;
    if (record && typeof record.visibility === 'string' && /^(?:hidden|hide)$/i.test(record.visibility.trim())) continue;
    // Codex catalogs use `slug`; OpenAI-compatible /models responses more
    // commonly use `id`. Prefer the stable slug when both are present.
    const rawId = record?.slug ?? record?.id ?? record?.name ?? record?.model ?? record?.model_name ?? record?.model_id ?? record?.modelId;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof record?.owned_by === 'string' ? record.owned_by.trim() : typeof record?.ownedBy === 'string' ? record.ownedBy.trim() : undefined;
    models.push(ownedBy ? { id, ownedBy: ownedBy.slice(0, 128) } : { id });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/**
 * Parse one Codex model-catalog JSON document. The catalog contains a large
 * amount of metadata (including base instructions); deliberately return only
 * the sanitized model identifiers needed by the renderer.
 */
export function parseCodexModelCatalog(value: unknown): ApiModelOption[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  const root = parsed && typeof parsed === 'object' ? parsed as { models?: unknown; data?: unknown } : null;
  const entries = Array.isArray(root?.models)
    ? root.models
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(parsed)
        ? parsed
        : [];
  return parseModelList(entries);
}

function mergeModelLists(...lists: ApiModelOption[][]): ApiModelOption[] {
  const merged: ApiModelOption[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const model of list) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
      if (merged.length >= MAX_MODELS) return merged;
    }
  }
  return merged;
}

/**
 * Resolve the Codex data directory without inspecting credentials. Codex uses
 * CODEX_HOME when set; otherwise its Windows default is %USERPROFILE%\.codex.
 */
export function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

interface CatalogFile {
  mtimeMs: number;
  models: ApiModelOption[];
}

/**
 * Read all current Codex model catalogs. This function is intentionally
 * read-only and tolerant of partially-written, stale, or malformed files;
 * Codex may refresh the directory while the assistant is running.
 */
export async function loadCodexModelCatalog(codexHome = resolveCodexHome()): Promise<ApiModelOption[]> {
  const catalogDirectory = path.join(codexHome, CODEX_MODEL_CATALOG_DIRECTORY);
  const primaryCatalogPaths = new Set<string>();
  const configuredCatalogPath = await readConfiguredCatalogPath(codexHome);
  if (configuredCatalogPath) primaryCatalogPaths.add(configuredCatalogPath);

  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(catalogDirectory, { withFileTypes: true });
  } catch {
    // A configured single catalog can still be valid when the directory is
    // absent (older Codex releases used this layout).
    entries = [];
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .slice(0, 128);
  for (const entry of candidates) primaryCatalogPaths.add(path.join(catalogDirectory, entry.name));

  const primaryModels = await readCatalogFiles(primaryCatalogPaths);
  if (primaryModels.length > 0) return primaryModels;

  // Older Codex/CCSwitch releases kept one catalog at CODEX_HOME root. Treat
  // it as a fallback only, because it may be a stale migration artifact when
  // a current model-catalogs directory is present.
  const legacyPaths = new Set(LEGACY_MODEL_CATALOG_FILES.map((fileName) => path.join(codexHome, fileName)));
  return readCatalogFiles(legacyPaths);
}

async function readCatalogFiles(catalogPaths: Set<string>): Promise<ApiModelOption[]> {
  const files = await Promise.all([...catalogPaths].map(async (filePath): Promise<CatalogFile | null> => {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size > MAX_MODEL_CATALOG_FILE_BYTES) return null;
      const raw = await fs.readFile(filePath, 'utf8');
      return { mtimeMs: stats.mtimeMs, models: parseCodexModelCatalog(raw) };
    } catch {
      return null;
    }
  }));

  return mergeModelLists(
    ...files
      .filter((file): file is CatalogFile => file !== null && file.models.length > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((file) => file.models),
  );
}

/**
 * Codex releases have used both a directory of relay catalogs and a
 * `model_catalog_json` path in config.toml. Read only that one scalar setting;
 * never parse or expose the rest of the configuration.
 */
async function readConfiguredCatalogPath(codexHome: string): Promise<string | null> {
  const configPath = path.join(codexHome, 'config.toml');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const match = content.match(/^\s*model_catalog_json\s*=\s*(['"])([^'"\r\n]{1,2048})\1\s*(?:#.*)?$/m);
    if (!match?.[2]) return null;
    const rawPath = match[2].trim();
    if (!rawPath || rawPath.length > MAX_CATALOG_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(rawPath)) return null;
    const normalizedPath = rawPath.replace(/\\\\/g, '\\');
    return path.isAbsolute(normalizedPath)
      ? path.normalize(normalizedPath)
      : path.resolve(codexHome, normalizedPath);
  } catch {
    return null;
  }
}

function isCcswitchProxy(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && url.port === '15721';
  } catch {
    return false;
  }
}

function isLocalProxy(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type TransportMode = 'playwright' | 'api';
export type Language = 'zh-CN' | 'en-US';

// Keep the practical opacity range focused on readable, still-translucent UI.
export const OPACITY_MIN = 0.72;
export const OPACITY_MAX = 1;

// A draft conversation uses a stable sentinel until its first message gives it a title.
export const NEW_CONVERSATION_TITLE = 'New conversation';

export function isPlaceholderConversationTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === NEW_CONVERSATION_TITLE.toLowerCase() ||
    normalized === 'new api conversation' ||
    normalized === 'api conversation' ||
    normalized === 'new chat' ||
    normalized === 'new task' ||
    normalized === 'new thread' ||
    normalized === 'untitled' ||
    normalized === '新建会话' ||
    normalized === '新建对话' ||
    normalized === '新建聊天' ||
    normalized === '未命名会话' ||
    normalized === '未命名';
}

/**
 * Build a stable, local conversation label from the first user message.
 * Keeping this synchronous lets the UI rename a new conversation before the
 * remote response or history sidebar finishes updating.
 */
export function summarizeConversationTitle(content: string, language: Language = 'zh-CN'): string {
  const normalized = content
    .replace(/```+/gu, ' ')
    .replace(/https?:\/\/\S+/giu, '链接')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s>*#-]+/u, '')
    .trim();
  const fallback = language === 'zh-CN' ? '截图分析' : 'Screenshot analysis';
  if (!normalized) return fallback;

  const withoutPrompt = normalized
    .replace(/^(?:please|could you|can you|would you|请帮我|请|帮我|麻烦)\s*/iu, '')
    .trim();
  const firstSentence = (withoutPrompt || normalized).split(/[。！？!?；;\n]+/u)[0]?.trim() ?? '';
  const cleaned = firstSentence
    .replace(/^[`"“”‘’]+|[`"“”‘’]+$/gu, '')
    .replace(/[。！？!?；;:：.]+$/u, '')
    .trim();
  if (!cleaned) return fallback;
  if (/(?:screenshot|screen\s+shot|屏幕截图|截图|截屏)/iu.test(cleaned)) return fallback;

  const characters = Array.from(cleaned);
  const maxLength = 48;
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('')}…`
    : cleaned;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface AppConfig {
  mode: TransportMode;
  language: Language;
  codexUrl: string;
  lastPageUrl: string | null;
  /** Last official Codex thread selected through app-server. */
  lastThreadId: string | null;
  apiBaseUrl: string;
  apiModel: string;
  apiKeyConfigured: boolean;
  window: WindowBounds;
  opacity: number;
  alwaysOnTop: boolean;
  miniMode: boolean;
  theme: ThemeMode;
  launchAtLogin: boolean;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'login-required'
  | 'api-key-required'
  | 'error';

export interface ConversationSummary {
  id: string;
  title: string;
  url?: string;
}

/** A model exposed by the active OpenAI-compatible upstream. */
export interface ApiModelOption {
  id: string;
  ownedBy?: string;
}

export interface PageState {
  url: string;
  title: string;
  loggedIn: boolean;
  inputAvailable: boolean;
  sendAvailable: boolean;
  theme?: Exclude<ThemeMode, 'system'>;
}

export interface AppState {
  config: AppConfig;
  connection: ConnectionState;
  connectionMessage: string;
  page: PageState | null;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  availableModels: ApiModelOption[];
  isCapturing: boolean;
  isSending: boolean;
  isDeleting: boolean;
  lastError: string | null;
  lastResponse: string | null;
  startedAt: number;
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturePayload {
  buffer: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  capturedAt: number;
}

/**
 * A user-selected attachment held only for the lifetime of the compose draft.
 * The renderer never receives a filesystem path; `data` is transferred over
 * the typed preload bridge and is revalidated in the main process before use.
 */
export interface AttachmentPayload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
  previewDataUrl?: string;
  width?: number;
  height?: number;
}

export interface CaptureAttachmentInput {
  region?: CaptureRegion;
  /** Open a full-display drag selector before capturing. */
  selectRegion?: boolean;
}

export interface SendMessageInput {
  text: string;
  attachments?: AttachmentPayload[];
}

export const ATTACHMENT_MAX_COUNT = 8;
export const ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_SINGLE_BYTES = 15 * 1024 * 1024;
export const ATTACHMENT_MAX_NAME_LENGTH = 240;

export interface CaptureAndSendInput {
  text?: string;
  region?: CaptureRegion;
  /** Open a full-display drag selector before capturing. */
  selectRegion?: boolean;
}

export interface ApiKeyInput {
  apiKey: string;
}

export interface ConfigPatch {
  mode?: TransportMode;
  language?: Language;
  codexUrl?: string;
  lastPageUrl?: string | null;
  lastThreadId?: string | null;
  apiBaseUrl?: string;
  apiModel?: string;
  opacity?: number;
  alwaysOnTop?: boolean;
  miniMode?: boolean;
  theme?: ThemeMode;
  launchAtLogin?: boolean;
  window?: Partial<WindowBounds>;
}

export interface IpcApi {
  getState(): Promise<AppState>;
  updateConfig(patch: ConfigPatch): Promise<AppState>;
  setApiKey(input: ApiKeyInput): Promise<AppState>;
  clearApiKey(): Promise<AppState>;
  sendMessage(input: SendMessageInput): Promise<AppState>;
  captureAndSend(input?: CaptureAndSendInput): Promise<AppState>;
  captureAttachment(input?: CaptureAttachmentInput): Promise<AttachmentPayload>;
  pickFiles(): Promise<AttachmentPayload[]>;
  newConversation(): Promise<AppState>;
  listConversations(): Promise<ConversationSummary[]>;
  switchConversation(id: string): Promise<AppState>;
  deleteConversation(id: string): Promise<AppState>;
  listModels(): Promise<ApiModelOption[]>;
  reconnect(): Promise<AppState>;
  minimizeWindow(): Promise<void>;
  quit(): Promise<void>;
  toggleMiniMode(): Promise<AppState>;
  toggleVisibility(): Promise<boolean>;
  openCodex(): Promise<void>;
  openSettings(): Promise<void>;
  openModelMenu(): Promise<void>;
  setOfficialPageOverlayOpen(open: boolean): Promise<void>;
  onState(listener: (state: AppState) => void): () => void;
}

export const IPC_CHANNELS = {
  getState: 'app:get-state',
  updateConfig: 'app:update-config',
  setApiKey: 'app:set-api-key',
  clearApiKey: 'app:clear-api-key',
  sendMessage: 'app:send-message',
  captureAndSend: 'app:capture-and-send',
  captureAttachment: 'app:capture-attachment',
  pickFiles: 'app:pick-files',
  captureSelectionComplete: 'app:capture-selection-complete',
  captureSelectionCancel: 'app:capture-selection-cancel',
  newConversation: 'app:new-conversation',
  listConversations: 'app:list-conversations',
  switchConversation: 'app:switch-conversation',
  deleteConversation: 'app:delete-conversation',
  listModels: 'app:list-models',
  reconnect: 'app:reconnect',
  minimizeWindow: 'app:minimize-window',
  quit: 'app:quit',
  toggleMiniMode: 'app:toggle-mini',
  toggleVisibility: 'app:toggle-visibility',
  openCodex: 'app:open-codex',
  openSettings: 'app:open-settings',
  openModelMenu: 'app:open-model-menu',
  setOfficialPageOverlayOpen: 'app:set-official-page-overlay-open',
  stateEvent: 'app:state-event',
} as const;

export function isCaptureRegion(value: unknown): value is CaptureRegion {
  if (!value || typeof value !== 'object') return false;
  const region = value as Record<string, unknown>;
  return typeof region.x === 'number' && Number.isFinite(region.x) && region.x >= 0 &&
    typeof region.y === 'number' && Number.isFinite(region.y) && region.y >= 0 &&
    typeof region.width === 'number' && Number.isFinite(region.width) && region.width > 0 &&
    typeof region.height === 'number' && Number.isFinite(region.height) && region.height > 0;
}

export function isConfigPatch(value: unknown): value is ConfigPatch {
  if (!value || typeof value !== 'object') return false;
  const patch = value as Record<string, unknown>;
  if (patch.mode !== undefined && patch.mode !== 'playwright' && patch.mode !== 'api') return false;
  if (patch.language !== undefined && patch.language !== 'zh-CN' && patch.language !== 'en-US') return false;
  if (patch.codexUrl !== undefined && typeof patch.codexUrl !== 'string') return false;
  if (patch.lastPageUrl !== undefined && patch.lastPageUrl !== null && typeof patch.lastPageUrl !== 'string') return false;
  if (patch.lastThreadId !== undefined && patch.lastThreadId !== null &&
    (typeof patch.lastThreadId !== 'string' || patch.lastThreadId.length < 1 || patch.lastThreadId.length > 512 || /[\u0000-\u001f\u007f]/u.test(patch.lastThreadId))) return false;
  if (patch.apiBaseUrl !== undefined && typeof patch.apiBaseUrl !== 'string') return false;
  if (patch.apiModel !== undefined && (typeof patch.apiModel !== 'string' || patch.apiModel.trim().length === 0 || patch.apiModel.trim().length > 256 || /[\u0000-\u001f\u007f]/.test(patch.apiModel))) return false;
  if (patch.opacity !== undefined && (typeof patch.opacity !== 'number' || !Number.isFinite(patch.opacity))) return false;
  if (patch.alwaysOnTop !== undefined && typeof patch.alwaysOnTop !== 'boolean') return false;
  if (patch.miniMode !== undefined && typeof patch.miniMode !== 'boolean') return false;
  if (patch.launchAtLogin !== undefined && typeof patch.launchAtLogin !== 'boolean') return false;
  if (patch.theme !== undefined && !['system', 'light', 'dark'].includes(String(patch.theme))) return false;
  if (patch.window !== undefined) {
    if (!patch.window || typeof patch.window !== 'object') return false;
    const windowPatch = patch.window as Record<string, unknown>;
    for (const key of ['x', 'y', 'width', 'height']) {
      if (windowPatch[key] !== undefined && (typeof windowPatch[key] !== 'number' || !Number.isFinite(windowPatch[key]))) return false;
    }
  }
  return true;
}

export function isApiKeyInput(value: unknown): value is ApiKeyInput {
  return !!value && typeof value === 'object' && typeof (value as ApiKeyInput).apiKey === 'string';
}

export function isSendMessageInput(value: unknown): value is SendMessageInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string') return false;
  if (input.attachments === undefined) return true;
  return isAttachmentPayloadList(input.attachments);
}

export function isAttachmentPayload(value: unknown): value is AttachmentPayload {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  if (typeof attachment.id !== 'string' || attachment.id.length < 1 || attachment.id.length > 128) return false;
  if (typeof attachment.name !== 'string' || attachment.name.length < 1 || attachment.name.length > ATTACHMENT_MAX_NAME_LENGTH) return false;
  if (/[/\\\u0000-\u001f\u007f]/u.test(attachment.name)) return false;
  if (typeof attachment.mimeType !== 'string' || attachment.mimeType.length < 1 || attachment.mimeType.length > 128 || /[\u0000-\u001f\u007f]/u.test(attachment.mimeType)) return false;
  if (typeof attachment.size !== 'number' || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > ATTACHMENT_MAX_SINGLE_BYTES) return false;
  if (!isByteArray(attachment.data) || attachment.data.byteLength !== attachment.size) return false;
  if (attachment.previewDataUrl !== undefined && (typeof attachment.previewDataUrl !== 'string' || attachment.previewDataUrl.length > 2_000_000 || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(attachment.previewDataUrl))) return false;
  for (const key of ['width', 'height']) {
    if (attachment[key] !== undefined && (typeof attachment[key] !== 'number' || !Number.isSafeInteger(attachment[key]) || attachment[key] < 1 || attachment[key] > 32_000)) return false;
  }
  return true;
}

export function isAttachmentPayloadList(value: unknown): value is AttachmentPayload[] {
  if (!Array.isArray(value) || value.length > ATTACHMENT_MAX_COUNT) return false;
  let total = 0;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isAttachmentPayload(item)) return false;
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    total += item.size;
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) return false;
  }
  return true;
}

export function isCaptureAttachmentInput(value: unknown): value is CaptureAttachmentInput {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const input = value as CaptureAttachmentInput;
  return (input.region === undefined || isCaptureRegion(input.region)) &&
    (input.selectRegion === undefined || typeof input.selectRegion === 'boolean') &&
    !(input.selectRegion && input.region !== undefined);
}

function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value));
}

export function isCaptureAndSendInput(value: unknown): value is CaptureAndSendInput {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const input = value as CaptureAndSendInput;
  return (input.text === undefined || typeof input.text === 'string') &&
    (input.region === undefined || isCaptureRegion(input.region)) &&
    (input.selectRegion === undefined || typeof input.selectRegion === 'boolean') &&
    !(input.selectRegion && input.region !== undefined);
}

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

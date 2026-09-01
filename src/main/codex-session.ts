import type {
  ApiModelOption,
  AppConfig,
  AttachmentPayload,
  CapturePayload,
  ConnectionState,
  ConversationSummary,
  PageState,
} from '../shared/types';

/**
 * The main-process contract used by IPC. Implementations may be backed by the
 * official Desktop renderer (CDP) or the official app-server protocol, but
 * both operate on Codex's real persisted conversations.
 */
export interface CodexSessionStatus {
  state: ConnectionState;
  message: string;
  page?: PageState | null;
}

export interface CodexSessionService {
  readonly currentStatus: CodexSessionStatus;
  readonly currentConversationId: string | null;
  connect(config: AppConfig): Promise<CodexSessionStatus>;
  disconnect(): Promise<void>;
  listConversations(): Promise<ConversationSummary[]>;
  newConversation(): Promise<void>;
  switchConversation(id: string, knownUrl?: string): Promise<void>;
  deleteConversation(id: string, knownUrl?: string): Promise<ConversationSummary[]>;
  sendMessage(text: string, attachments: AttachmentPayload[]): Promise<string | void>;
  uploadAndSend(capture: CapturePayload, text?: string): Promise<string | void>;
  listModels(): Promise<ApiModelOption[]>;
  setModel?(id: string): Promise<void>;
  setReasoningEffort?(effort: import('../shared/types').ReasoningEffort): Promise<void>;
  switchProject?(projectId: string): Promise<void>;
  prepareMessageTitle?(content: string): ConversationSummary[];
  onStatus(listener: (status: CodexSessionStatus) => void): () => void;
  onThreadsChanged(listener: () => void): () => void;
  openCodex?(): Promise<void>;
}

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  type AppState,
  type ApiModelOption,
  type ApiKeyInput,
  type AttachmentPayload,
  type CaptureAndSendInput,
  type CaptureAttachmentInput,
  type ConfigPatch,
  type IpcApi,
  type SendMessageInput,
} from './shared/types';

const api: IpcApi = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState),
  updateConfig: (patch: ConfigPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateConfig, patch),
  setApiKey: (input: ApiKeyInput) => ipcRenderer.invoke(IPC_CHANNELS.setApiKey, input),
  clearApiKey: () => ipcRenderer.invoke(IPC_CHANNELS.clearApiKey),
  sendMessage: (input: SendMessageInput) => ipcRenderer.invoke(IPC_CHANNELS.sendMessage, input),
  captureAndSend: (input?: CaptureAndSendInput) => ipcRenderer.invoke(IPC_CHANNELS.captureAndSend, input),
  captureAttachment: (input?: CaptureAttachmentInput): Promise<AttachmentPayload> => ipcRenderer.invoke(IPC_CHANNELS.captureAttachment, input),
  pickFiles: (): Promise<AttachmentPayload[]> => ipcRenderer.invoke(IPC_CHANNELS.pickFiles),
  newConversation: () => ipcRenderer.invoke(IPC_CHANNELS.newConversation),
  listConversations: () => ipcRenderer.invoke(IPC_CHANNELS.listConversations),
  switchConversation: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.switchConversation, id),
  deleteConversation: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteConversation, id),
  listModels: (): Promise<ApiModelOption[]> => ipcRenderer.invoke(IPC_CHANNELS.listModels),
  reconnect: () => ipcRenderer.invoke(IPC_CHANNELS.reconnect),
  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.minimizeWindow),
  quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit),
  toggleMiniMode: () => ipcRenderer.invoke(IPC_CHANNELS.toggleMiniMode),
  toggleVisibility: () => ipcRenderer.invoke(IPC_CHANNELS.toggleVisibility),
  openCodex: () => ipcRenderer.invoke(IPC_CHANNELS.openCodex),
  openSettings: () => ipcRenderer.invoke(IPC_CHANNELS.openSettings),
  openModelMenu: () => ipcRenderer.invoke(IPC_CHANNELS.openModelMenu),
  onState: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.stateEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.stateEvent, handler);
  },
};

contextBridge.exposeInMainWorld('codexAssistant', api);

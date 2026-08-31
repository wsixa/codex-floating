import type { IpcApi } from '../shared/types';
import type { Root } from 'react-dom/client';

declare global {
  interface Window {
    codexAssistant: IpcApi;
    __codexAssistantRoot?: Root;
  }
}

export {};

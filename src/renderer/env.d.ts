import type { IpcApi } from '../shared/types';

declare global {
  interface Window {
    codexAssistant: IpcApi;
  }
}

export {};

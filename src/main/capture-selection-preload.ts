import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type CaptureRegion } from '../shared/types';

/**
 * The selection window receives no Node.js APIs. It can only return a
 * validated-by-main-process rectangle or cancel the current selection.
 */
contextBridge.exposeInMainWorld('captureSelection', {
  complete: (region: CaptureRegion) => ipcRenderer.send(IPC_CHANNELS.captureSelectionComplete, region),
  cancel: () => ipcRenderer.send(IPC_CHANNELS.captureSelectionCancel),
});

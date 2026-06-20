/**
 * Preload bridge.
 *
 * Exposes a single, minimal `window.harbor` object to the chrome renderer via
 * `contextBridge`, under `contextIsolation`. The renderer gets no direct access
 * to Node, Electron, or arbitrary IPC — only the typed invoke/on surface, and
 * only for channels that appear in the contract's allow-lists. Anything else is
 * rejected here rather than reaching the main process.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type HarborBridge,
  type InvokeChannel,
} from '../ipc';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const bridge: HarborBridge = {
  invoke: ((channel: InvokeChannel, payload?: unknown) => {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(new Error(`Harbor: blocked invoke on unknown channel "${channel}"`));
    }
    return ipcRenderer.invoke(channel, payload);
  }) as HarborBridge['invoke'],

  on: ((channel: EventChannel, listener: (payload: unknown) => void) => {
    if (!eventAllowed.has(channel)) {
      throw new Error(`Harbor: blocked subscription on unknown channel "${channel}"`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }) as HarborBridge['on'],
};

contextBridge.exposeInMainWorld('harbor', bridge);

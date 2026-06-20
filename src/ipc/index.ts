/**
 * Public entry point for the IPC contract.
 *
 * This module is deliberately free of any Electron or Node imports so it can be
 * type-imported from the renderer's browser context as well as from the main
 * process. The main-side router (which needs `electron` types) lives under
 * `src/main/` and consumes these types — never the other way around.
 */
export * from './types';
export * from './channels';

import type { EventMap, InvokeChannel, InvokeMap } from './channels';

export type InvokeRequest<C extends InvokeChannel> = InvokeMap[C]['request'];
export type InvokeResponse<C extends InvokeChannel> = InvokeMap[C]['response'];

/**
 * Arguments tuple for an invoke channel: empty when the request is `void`,
 * otherwise a single request object. Lets `invoke('x')` and `invoke('y', {...})`
 * both stay fully typed.
 */
export type InvokeArgs<C extends InvokeChannel> = InvokeMap[C]['request'] extends void
  ? []
  : [request: InvokeMap[C]['request']];

/**
 * The surface exposed on `window.harbor` by the preload bridge. The renderer
 * programs exclusively against this interface.
 */
export interface HarborBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeArgs<C>
  ): Promise<InvokeMap[C]['response']>;

  /** Subscribe to a main->renderer event. Returns an unsubscribe function. */
  on<E extends keyof EventMap>(
    channel: E,
    listener: (payload: EventMap[E]) => void,
  ): () => void;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    readonly harbor: HarborBridge;
  }
}

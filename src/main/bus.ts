/**
 * A tiny, fully-typed publish/subscribe bus for main-process modules.
 *
 * The architecture rule is that no module reaches into another's internals.
 * Direct method calls between feature modules would violate that, so modules
 * instead announce facts on this bus and subscribe to the facts they care
 * about. The network module emits an observation without knowing the ledger
 * exists; the ledger subscribes without knowing where the observation came
 * from. The typing guarantees publishers and subscribers agree on payloads.
 */
import { EventEmitter } from 'node:events';

import type { Bookmark, Compartment, LedgerSnapshot, PresetConfig, SyncStatus, TabInfo } from '../ipc';
import type { RawObservation } from './internal-types';

export interface InternalEventMap {
  /** A network request was observed and ruled on. */
  'network:observation': RawObservation;
  /** A page attempted to read a fingerprinting surface. */
  'fingerprint:attempt': { tabId: number; api: string };
  /** A tab's metadata (title/url/load state) changed. */
  'tab:updated': TabInfo;
  /** The set of open tabs changed. */
  'tab:list-changed': readonly TabInfo[];
  /** The set of compartments changed. */
  'compartments:changed': readonly Compartment[];
  /** Duress mode fired. Carries the decoy target for the tab layer to switch to. */
  'duress:activated': {
    wipedCompartments: readonly string[];
    decoyActivated: boolean;
    decoyCompartmentId: string | null;
  };
  /** The active preset changed; carries the newly-resolved config. */
  'preset:changed': PresetConfig;
  /** A recomputed ledger snapshot is ready for a tab. */
  'ledger:updated': LedgerSnapshot;
  /** Sync subsystem state changed. */
  'sync:changed': SyncStatus;
  /** The bookmark set changed. */
  'bookmarks:changed': readonly Bookmark[];
  /** A page was visited (recorded into history). */
  'history:visit': { url: string; title: string };
  /** History changed (a visit was recorded, removed, or cleared). */
  'history:changed': void;
}

export type InternalEvent = keyof InternalEventMap;

export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Modules can fan out widely; lift the default 10-listener warning ceiling.
    this.emitter.setMaxListeners(100);
  }

  emit<E extends InternalEvent>(event: E, payload: InternalEventMap[E]): void {
    this.emitter.emit(event, payload);
  }

  on<E extends InternalEvent>(
    event: E,
    listener: (payload: InternalEventMap[E]) => void,
  ): () => void {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return () => {
      this.emitter.off(event, listener as (payload: unknown) => void);
    };
  }
}

/**
 * Types used only between main-process modules. These never cross the IPC
 * boundary; the renderer-facing shapes live in `src/ipc/`.
 */
import type { RequestDisposition, RequestReason } from '../ipc';

/**
 * A network request the network layer has observed and ruled on, before the
 * ledger has translated it into plain language. The network module owns the
 * decision (disposition/reason); the ledger owns presentation and scoring.
 */
export interface RawObservation {
  readonly tabId: number;
  readonly url: string;
  readonly domain: string;
  readonly canonicalDomain: string | null;
  readonly resourceType: string;
  readonly initiator: string | null;
  readonly disposition: RequestDisposition;
  readonly reason: RequestReason;
  readonly timestamp: number;
}

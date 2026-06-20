/**
 * Network ledger.
 *
 * Subscribes to the bus, translates raw observations and fingerprint attempts
 * into plain-language ledger entries, keeps a bounded per-tab log, recomputes
 * the runtime privacy score, and emits `ledger:updated`. It is the only module
 * that turns machine facts into the sentences a user reads.
 */
import { randomUUID } from 'node:crypto';

import type { LedgerEntry, LedgerSnapshot, RequestReason } from '../../ipc';
import { Bus } from '../bus';
import type { RawObservation } from '../internal-types';
import { computeScore } from './score';

/** Cap per-tab history so a long-lived tab cannot grow memory unbounded. */
const MAX_ENTRIES_PER_TAB = 500;

export class Ledger {
  private readonly byTab = new Map<number, LedgerEntry[]>();

  constructor(private readonly bus: Bus) {
    this.bus.on('network:observation', (obs) => this.onObservation(obs));
    this.bus.on('fingerprint:attempt', ({ tabId, api }) => this.onFingerprint(tabId, api));
  }

  private onObservation(obs: RawObservation): void {
    const entry: LedgerEntry = {
      id: randomUUID(),
      timestamp: obs.timestamp,
      url: obs.url,
      domain: obs.domain,
      canonicalDomain: obs.canonicalDomain,
      resourceType: obs.resourceType,
      initiator: obs.initiator,
      disposition: obs.disposition,
      reason: obs.reason,
      summary: summarize(obs.reason, obs.domain, obs.canonicalDomain, obs.resourceType),
    };
    this.append(obs.tabId, entry);
  }

  private onFingerprint(tabId: number, api: string): void {
    const entry: LedgerEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      url: '',
      domain: 'this page',
      canonicalDomain: null,
      resourceType: 'script',
      initiator: null,
      disposition: 'blocked',
      reason: 'fingerprinting-api',
      summary: `Neutralised a fingerprinting attempt via ${api}`,
    };
    this.append(tabId, entry);
  }

  private append(tabId: number, entry: LedgerEntry): void {
    const list = this.byTab.get(tabId) ?? [];
    list.push(entry);
    if (list.length > MAX_ENTRIES_PER_TAB) {
      list.splice(0, list.length - MAX_ENTRIES_PER_TAB);
    }
    this.byTab.set(tabId, list);
    this.bus.emit('ledger:updated', this.snapshot(tabId));
  }

  snapshot(tabId: number): LedgerSnapshot {
    const entries = this.byTab.get(tabId) ?? [];
    return { tabId, entries: [...entries], score: computeScore(entries) };
  }

  /** Clear a tab's log, e.g. on top-level navigation to a new site. */
  reset(tabId: number): void {
    this.byTab.set(tabId, []);
    this.bus.emit('ledger:updated', this.snapshot(tabId));
  }

  /** Drop a tab entirely when it closes. */
  remove(tabId: number): void {
    this.byTab.delete(tabId);
  }
}

function summarize(
  reason: RequestReason,
  domain: string,
  canonical: string | null,
  resourceType: string,
): string {
  switch (reason) {
    case 'first-party':
      return `Loaded ${resourceType} from ${domain} (this site)`;
    case 'third-party':
      return `Contacted third party ${domain} for ${resourceType}`;
    case 'allowed-cdn':
      return `Loaded ${resourceType} from CDN ${domain}`;
    case 'tracker-blocklist':
      return `Blocked tracker ${domain}`;
    case 'cname-uncloaked':
      return `Blocked hidden tracker ${domain} → ${canonical ?? 'unknown'} (CNAME-cloaked)`;
    case 'fingerprinting-api':
      return `Neutralised a fingerprinting attempt`;
    case 'clipboard-read':
      return `Blocked ${domain} from reading your clipboard`;
    default:
      return `${domain} (${resourceType})`;
  }
}

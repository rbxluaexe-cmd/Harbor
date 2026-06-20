/**
 * Shared domain types for the Harbor IPC contract.
 *
 * Every value that crosses the main <-> renderer boundary is described here.
 * Both the main-process modules and the renderer import these types, but
 * neither side imports the other's implementation — the contract is the only
 * thing they share. Keep this file free of any Electron or Node imports so it
 * stays loadable from the renderer's DOM-only context.
 */

/** Fingerprint shielding aggressiveness. */
export type FingerprintMode = 'off' | 'standard' | 'strict';

/** How DNS resolution / private routing is performed. */
export type DnsMode = 'system' | 'doh' | 'odoh-relay';

/** Default storage behaviour for newly opened tabs. */
export type DefaultCompartmentMode = 'ephemeral' | 'persistent';

/**
 * A named storage compartment. Persistent compartments map to a
 * `persist:` Chromium partition; ephemeral ones map to an in-memory partition
 * that is discarded when the last tab using it closes.
 */
export interface Compartment {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly persistent: boolean;
  /** True for the built-in compartments the user cannot delete. */
  readonly builtin: boolean;
}

/** Lifecycle / load state reported for a tab. */
export type TabLoadState = 'idle' | 'loading' | 'complete' | 'failed';

/** A single browser tab and the compartment it is bound to. */
export interface TabInfo {
  readonly id: number;
  readonly compartmentId: string;
  readonly title: string;
  readonly url: string;
  readonly loadState: TabLoadState;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Whether a request was permitted, blocked, or redirected by the network layer. */
export type RequestDisposition = 'allowed' | 'blocked' | 'redirected';

/** Why a request received the disposition it did — drives the plain-language ledger. */
export type RequestReason =
  | 'first-party'
  | 'third-party'
  | 'tracker-blocklist'
  | 'cname-uncloaked'
  | 'fingerprinting-api'
  | 'clipboard-read'
  | 'allowed-cdn';

/** One observed network request, already translated toward plain language. */
export interface LedgerEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly url: string;
  readonly domain: string;
  /** The canonical domain when a CNAME chain was uncloaked, else null. */
  readonly canonicalDomain: string | null;
  readonly resourceType: string;
  readonly initiator: string | null;
  readonly disposition: RequestDisposition;
  readonly reason: RequestReason;
  /** Human-readable one-line summary shown in the ledger panel. */
  readonly summary: string;
}

/** Aggregate, runtime-derived privacy assessment for a single tab. */
export interface PrivacyScore {
  /** 0 (hostile) – 100 (clean), computed from observed runtime behaviour. */
  readonly value: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly totalRequests: number;
  readonly blockedRequests: number;
  readonly thirdParties: number;
  readonly trackersBlocked: number;
  readonly cnameUncloaked: number;
  readonly fingerprintAttempts: number;
}

/** Everything the ledger panel needs to render for one tab. */
export interface LedgerSnapshot {
  readonly tabId: number;
  readonly entries: readonly LedgerEntry[];
  readonly score: PrivacyScore;
}

/** A duress key binding plus the actions it performs when triggered. */
export interface DuressConfig {
  readonly accelerator: string;
  /** Compartment ids to wipe; empty means "all". */
  readonly wipeCompartments: readonly string[];
  /** Switch to this decoy compartment after wiping, if set. */
  readonly decoyCompartmentId: string | null;
  readonly enabled: boolean;
}

/** Concrete configuration produced by a threat-model preset. */
export interface PresetConfig {
  readonly fingerprintMode: FingerprintMode;
  readonly dnsMode: DnsMode;
  readonly defaultCompartment: DefaultCompartmentMode;
  readonly webRtcPolicy: 'default' | 'proxy-only' | 'disabled';
  readonly cnameUncloaking: boolean;
  readonly syncEnabled: boolean;
  readonly duress: DuressConfig;
}

/** A named threat-model preset. */
export interface Preset {
  readonly schemaVersion: number;
  readonly name: string;
  readonly description: string;
  readonly config: PresetConfig;
}

/** Lightweight preset listing for the settings UI. */
export interface PresetSummary {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
}

/** Sync subsystem state surfaced to the UI. Never carries key material. */
export interface SyncStatus {
  readonly enabled: boolean;
  readonly lastSyncedAt: number | null;
  readonly pendingChanges: number;
  readonly serverConfigured: boolean;
}

/** Result of a push/pull round-trip. */
export interface SyncResult {
  readonly ok: boolean;
  readonly itemCount: number;
  readonly message: string;
}

/** Live duress configuration plus whether it is currently armed. */
export interface DuressStatus {
  readonly armed: boolean;
  readonly config: DuressConfig;
}

/** Result of an update check; verification is performed in the main process. */
export interface UpdateStatus {
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  readonly signatureVerified: boolean;
  readonly checkedAt: number;
  readonly message: string;
}

/** User-facing settings independent of the active preset. */
export interface Settings {
  readonly activePreset: string;
  readonly homepage: string;
  readonly showLedgerPanel: boolean;
}

/** Top-level state pushed to the renderer on startup so it can render once. */
export interface BootstrapState {
  readonly version: string;
  readonly settings: Settings;
  readonly compartments: readonly Compartment[];
  readonly tabs: readonly TabInfo[];
  readonly activePreset: string;
  readonly presets: readonly PresetSummary[];
  readonly sync: SyncStatus;
  readonly duress: DuressStatus;
}

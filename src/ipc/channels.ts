/**
 * The complete, typed channel catalogue for Harbor's IPC.
 *
 * `InvokeMap` describes request/response (renderer -> main -> renderer) calls.
 * `EventMap` describes pushes (main -> renderer). The preload bridge and the
 * main-process router are both generated from these maps, so adding a channel
 * in one place makes it type-checked everywhere.
 */
import type {
  BootstrapState,
  Bookmark,
  Compartment,
  DownloadItem,
  DuressConfig,
  DuressStatus,
  HistoryEntry,
  LedgerSnapshot,
  PermissionDecision,
  Preset,
  PresetSummary,
  Settings,
  SitePermission,
  SyncResult,
  SyncStatus,
  TabInfo,
  UpdateStatus,
} from './types';

/** Request/response channels invoked from the renderer. */
export interface InvokeMap {
  'app:bootstrap': {
    request: void;
    response: BootstrapState;
  };

  'compartments:list': {
    request: void;
    response: readonly Compartment[];
  };
  'compartments:create': {
    request: { name: string; color: string; persistent: boolean };
    response: Compartment;
  };
  'compartments:remove': {
    request: { id: string };
    response: readonly Compartment[];
  };

  'tabs:list': {
    request: void;
    response: readonly TabInfo[];
  };
  'tabs:create': {
    request: { compartmentId?: string; url?: string };
    response: TabInfo;
  };
  'tabs:close': {
    request: { tabId: number };
    response: readonly TabInfo[];
  };
  'tabs:activate': {
    request: { tabId: number };
    response: void;
  };
  'tabs:navigate': {
    request: { tabId: number; url: string };
    response: TabInfo;
  };
  'tabs:goBack': {
    request: { tabId: number };
    response: void;
  };
  'tabs:goForward': {
    request: { tabId: number };
    response: void;
  };
  'tabs:reload': {
    request: { tabId: number };
    response: void;
  };
  'tabs:reassign': {
    request: { tabId: number; compartmentId: string };
    response: TabInfo;
  };
  'tabs:toggleMute': {
    request: { tabId: number };
    response: void;
  };
  'tabs:contextMenu': {
    request: { tabId: number };
    response: void;
  };

  'ledger:get': {
    request: { tabId: number };
    response: LedgerSnapshot;
  };

  'presets:list': {
    request: void;
    response: readonly PresetSummary[];
  };
  'presets:get': {
    request: { name: string };
    response: Preset;
  };
  'presets:apply': {
    request: { name: string };
    response: readonly PresetSummary[];
  };

  'sync:status': {
    request: void;
    response: SyncStatus;
  };
  'sync:enable': {
    request: { password: string; serverUrl: string };
    response: SyncStatus;
  };
  'sync:disable': {
    request: void;
    response: SyncStatus;
  };
  'sync:push': {
    request: void;
    response: SyncResult;
  };
  'sync:pull': {
    request: void;
    response: SyncResult;
  };

  'duress:status': {
    request: void;
    response: DuressStatus;
  };
  'duress:configure': {
    request: { config: DuressConfig };
    response: DuressStatus;
  };
  'duress:trigger': {
    request: void;
    response: void;
  };

  'update:check': {
    request: void;
    response: UpdateStatus;
  };

  'settings:get': {
    request: void;
    response: Settings;
  };
  'settings:set': {
    request: { patch: Partial<Settings> };
    response: Settings;
  };

  'window:minimize': {
    request: void;
    response: void;
  };
  'window:toggleMaximize': {
    request: void;
    response: void;
  };
  'window:close': {
    request: void;
    response: void;
  };
  'window:isMaximized': {
    request: void;
    response: boolean;
  };

  'find:start': {
    request: { text: string; forward: boolean };
    response: void;
  };
  'find:stop': {
    request: void;
    response: void;
  };

  'bookmarks:list': {
    request: void;
    response: readonly Bookmark[];
  };
  'bookmarks:add': {
    request: { url: string; title: string };
    response: readonly Bookmark[];
  };
  'bookmarks:remove': {
    request: { id: string };
    response: readonly Bookmark[];
  };

  'history:list': {
    request: { query?: string; limit?: number };
    response: readonly HistoryEntry[];
  };
  'history:remove': {
    request: { id: string };
    response: void;
  };
  'history:clear': {
    request: void;
    response: void;
  };

  'downloads:list': {
    request: void;
    response: readonly DownloadItem[];
  };
  'downloads:open': {
    request: { id: string };
    response: void;
  };
  'downloads:showInFolder': {
    request: { id: string };
    response: void;
  };
  'downloads:clear': {
    request: void;
    response: void;
  };

  'data:clearBrowsing': {
    request: void;
    response: void;
  };

  'permissions:get': {
    request: { origin: string };
    response: readonly SitePermission[];
  };
  'permissions:set': {
    request: { origin: string; permission: string; decision: PermissionDecision };
    response: readonly SitePermission[];
  };
}

/** One-way pushes from main to the renderer chrome. */
export interface EventMap {
  'tabs:updated': TabInfo;
  'tabs:list-changed': readonly TabInfo[];
  /** The active tab changed (e.g. via keyboard shortcut). */
  'tabs:active-changed': number;
  'ledger:updated': LedgerSnapshot;
  'compartments:changed': readonly Compartment[];
  'duress:activated': { wipedCompartments: readonly string[]; decoyActivated: boolean };
  'preset:changed': readonly PresetSummary[];
  'sync:changed': SyncStatus;
  /** Ask the renderer to focus and select the address bar (menu / Ctrl+L). */
  'ui:focus-address': null;
  /** Window maximize state changed (for the maximize/restore button). */
  'window:maximized': boolean;
  /** Open the find-in-page bar (Ctrl+F). */
  'ui:find': null;
  /** Find-in-page result counts. */
  'find:result': { matches: number; active: number };
  /** The bookmark set changed. */
  'bookmarks:changed': readonly Bookmark[];
  /** History changed; the renderer reloads the history view if it is open. */
  'history:changed': null;
  /** The downloads list changed (new download, progress, or completion). */
  'downloads:changed': readonly DownloadItem[];
  /** A site's permissions changed (a request was seen or an override set). */
  'permissions:changed': string;
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;

/**
 * The list of every invoke channel, used by the main router to register
 * handlers and by the preload bridge to expose typed callers. Keep in sync
 * with `InvokeMap` — the satisfies clause makes a mismatch a compile error.
 */
export const INVOKE_CHANNELS = [
  'app:bootstrap',
  'compartments:list',
  'compartments:create',
  'compartments:remove',
  'tabs:list',
  'tabs:create',
  'tabs:close',
  'tabs:activate',
  'tabs:navigate',
  'tabs:goBack',
  'tabs:goForward',
  'tabs:reload',
  'tabs:reassign',
  'tabs:toggleMute',
  'tabs:contextMenu',
  'ledger:get',
  'presets:list',
  'presets:get',
  'presets:apply',
  'sync:status',
  'sync:enable',
  'sync:disable',
  'sync:push',
  'sync:pull',
  'duress:status',
  'duress:configure',
  'duress:trigger',
  'update:check',
  'settings:get',
  'settings:set',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:isMaximized',
  'find:start',
  'find:stop',
  'bookmarks:list',
  'bookmarks:add',
  'bookmarks:remove',
  'history:list',
  'history:remove',
  'history:clear',
  'downloads:list',
  'downloads:open',
  'downloads:showInFolder',
  'downloads:clear',
  'data:clearBrowsing',
  'permissions:get',
  'permissions:set',
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'tabs:updated',
  'tabs:list-changed',
  'tabs:active-changed',
  'ledger:updated',
  'compartments:changed',
  'duress:activated',
  'preset:changed',
  'sync:changed',
  'ui:focus-address',
  'window:maximized',
  'ui:find',
  'find:result',
  'bookmarks:changed',
  'history:changed',
  'downloads:changed',
  'permissions:changed',
] as const satisfies readonly EventChannel[];

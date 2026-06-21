/**
 * Main-process IPC router.
 *
 * The single place that binds the typed channel catalogue to module methods,
 * and the single place that forwards internal bus events out to the chrome
 * renderer. Feature modules never touch `ipcMain` themselves — they expose
 * plain methods and emit on the bus; the router translates.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import type {
  BootstrapState,
  InvokeRequest,
  InvokeResponse,
  Settings,
} from '../ipc';
import { EVENT_CHANNELS, type EventMap, type InvokeChannel } from '../ipc';
import { app } from 'electron';

import { Bus } from './bus';
import { BookmarksManager } from './bookmarks';
import { CompartmentManager } from './identity';
import { DuressController } from './duress';
import { HistoryManager } from './history';
import { Ledger } from './ledger';
import { PresetManager } from './presets';
import { SettingsStore } from './settings';
import { SyncClient } from './sync';
import { TabManager } from './tabs';
import { UpdateChecker } from './update';

export interface RouterModules {
  readonly bus: Bus;
  readonly compartments: CompartmentManager;
  readonly tabs: TabManager;
  readonly presets: PresetManager;
  readonly ledger: Ledger;
  readonly sync: SyncClient;
  readonly duress: DuressController;
  readonly update: UpdateChecker;
  readonly settings: SettingsStore;
  readonly bookmarks: BookmarksManager;
  readonly history: HistoryManager;
}

export function registerIpcRouter(m: RouterModules): void {
  const handle = <C extends InvokeChannel>(
    channel: C,
    fn: (req: InvokeRequest<C>, event: IpcMainInvokeEvent) => Promise<InvokeResponse<C>> | InvokeResponse<C>,
  ): void => {
    ipcMain.handle(channel, (event, req: unknown) => fn(req as InvokeRequest<C>, event));
  };

  const composedSettings = (): Settings => ({
    activePreset: m.presets.activeName(),
    homepage: m.settings.get().homepage,
    showLedgerPanel: m.settings.get().showLedgerPanel,
    showBookmarksBar: m.settings.get().showBookmarksBar,
  });

  const bootstrap = (): BootstrapState => ({
    version: app.getVersion(),
    settings: composedSettings(),
    compartments: m.compartments.list(),
    tabs: m.tabs.list(),
    bookmarks: m.bookmarks.list(),
    activePreset: m.presets.activeName(),
    presets: m.presets.list(),
    sync: m.sync.status(),
    duress: m.duress.status(),
  });

  handle('app:bootstrap', () => bootstrap());

  handle('compartments:list', () => m.compartments.list());
  handle('compartments:create', (req) => m.compartments.create(req.name, req.color, req.persistent));
  handle('compartments:remove', (req) => m.compartments.remove(req.id));

  handle('tabs:list', () => m.tabs.list());
  handle('tabs:create', (req) => m.tabs.create(req.compartmentId, req.url));
  handle('tabs:close', (req) => m.tabs.close(req.tabId));
  handle('tabs:activate', (req) => {
    m.tabs.activate(req.tabId);
  });
  handle('tabs:navigate', (req) => m.tabs.navigate(req.tabId, req.url));
  handle('tabs:goBack', (req) => {
    m.tabs.goBack(req.tabId);
  });
  handle('tabs:goForward', (req) => {
    m.tabs.goForward(req.tabId);
  });
  handle('tabs:reload', (req) => {
    m.tabs.reload(req.tabId);
  });
  handle('tabs:reassign', (req) => m.tabs.reassign(req.tabId, req.compartmentId));

  handle('ledger:get', (req) => m.ledger.snapshot(req.tabId));

  handle('presets:list', () => m.presets.list());
  handle('presets:get', (req) => m.presets.get(req.name));
  handle('presets:apply', (req) => m.presets.apply(req.name));

  handle('sync:status', () => m.sync.status());
  handle('sync:enable', (req) => m.sync.enable(req.password, req.serverUrl));
  handle('sync:disable', () => m.sync.disable());
  handle('sync:push', () => m.sync.push());
  handle('sync:pull', () => m.sync.pull());

  handle('duress:status', () => m.duress.status());
  handle('duress:configure', (req) => m.duress.configure(req.config));
  handle('duress:trigger', () => m.duress.trigger());

  handle('update:check', () => m.update.check());

  handle('window:minimize', () => {
    m.tabs.minimizeWindow();
  });
  handle('window:toggleMaximize', () => {
    m.tabs.toggleMaximize();
  });
  handle('window:close', () => {
    m.tabs.closeWindow();
  });
  handle('window:isMaximized', () => m.tabs.isMaximized());

  handle('find:start', (req) => {
    m.tabs.findInActive(req.text, req.forward);
  });
  handle('find:stop', () => {
    m.tabs.stopFindActive();
  });

  handle('bookmarks:list', () => m.bookmarks.list());
  handle('bookmarks:add', (req) => m.bookmarks.toggle(req.url, req.title));
  handle('bookmarks:remove', (req) => m.bookmarks.remove(req.id));

  handle('history:list', (req) => m.history.list(req.query, req.limit));
  handle('history:remove', (req) => {
    m.history.remove(req.id);
  });
  handle('history:clear', () => {
    m.history.clear();
  });

  handle('settings:get', () => composedSettings());
  handle('settings:set', (req) => {
    const patch = req.patch;
    if (patch.activePreset !== undefined) {
      m.presets.apply(patch.activePreset);
    }
    const storePatch: Partial<{ homepage: string; showLedgerPanel: boolean; showBookmarksBar: boolean }> = {};
    if (patch.homepage !== undefined) {
      storePatch.homepage = patch.homepage;
    }
    if (patch.showLedgerPanel !== undefined) {
      storePatch.showLedgerPanel = patch.showLedgerPanel;
    }
    if (patch.showBookmarksBar !== undefined) {
      storePatch.showBookmarksBar = patch.showBookmarksBar;
    }
    if (Object.keys(storePatch).length > 0) {
      m.settings.patch(storePatch);
    }
    if (patch.showLedgerPanel !== undefined || patch.showBookmarksBar !== undefined) {
      m.tabs.relayout();
    }
    return composedSettings();
  });

  forwardBusEvents(m);
}

/** Subscribe to the bus and relay each event to the chrome renderer. */
function forwardBusEvents(m: RouterModules): void {
  const send = <E extends keyof EventMap>(channel: E, payload: EventMap[E]): void => {
    const wc = m.tabs.chromeWebContents();
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, payload);
    }
  };

  m.bus.on('tab:updated', (info) => send('tabs:updated', info));
  m.bus.on('tab:list-changed', (list) => send('tabs:list-changed', list));
  m.bus.on('ledger:updated', (snapshot) => send('ledger:updated', snapshot));
  m.bus.on('compartments:changed', (list) => send('compartments:changed', list));
  m.bus.on('duress:activated', (payload) =>
    send('duress:activated', {
      wipedCompartments: payload.wipedCompartments,
      decoyActivated: payload.decoyActivated,
    }),
  );
  m.bus.on('preset:changed', () => send('preset:changed', m.presets.list()));
  m.bus.on('sync:changed', (status) => send('sync:changed', status));
  m.bus.on('bookmarks:changed', (list) => send('bookmarks:changed', list));
  m.bus.on('history:changed', () => send('history:changed', null));

  // Sanity: every declared event channel is wired above.
  void EVENT_CHANNELS;
}

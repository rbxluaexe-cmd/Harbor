/**
 * Application entry point.
 *
 * Constructs every feature module, wires them through the bus and the IPC
 * router, and brings up the main window. Modules receive only the narrow
 * callbacks they need (e.g. a config getter, a wipe function) rather than
 * references to each other's internals.
 */
import { join } from 'node:path';

import { app, globalShortcut } from 'electron';

import { Bus } from './bus';
import { CompartmentManager } from './identity';
import { DuressController } from './duress';
import { FingerprintShield } from './fingerprint';
import { Ledger } from './ledger';
import { NetworkGuard } from './network';
import { configureSecureDns } from './network/secure-dns';
import { PresetManager } from './presets';
import { registerIpcRouter } from './ipc-router';
import { installAppMenu } from './menu';
import { SettingsStore } from './settings';
import { SyncClient, type SyncDataProvider } from './sync';
import { TabManager } from './tabs';
import { UpdateChecker } from './update';
import type { StoredSettings } from './settings';

app.setName('Harbor');
// Stable identity for Windows taskbar grouping and notifications.
app.setAppUserModelId('org.harbor.browser');

// Config that must be set before the app is ready (command-line switches).
const bus = new Bus();
const presets = new PresetManager(bus);
const settings = new SettingsStore();
configureSecureDns(app.commandLine, presets.current().dnsMode);

// Single-instance: a second launch focuses the existing window instead of
// spawning a parallel session that could fragment compartments.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function start(): void {
  const compartments = new CompartmentManager(bus);

  // TabManager is referenced by the network guard's first-party check before it
  // exists; the closure resolves it lazily once assigned below.
  let tabs: TabManager;
  const network = new NetworkGuard(
    bus,
    () => presets.current(),
    (id) => tabs.getTabUrl(id),
  );
  compartments.registerSessionConfigurator(network.configureSession);

  const fingerprint = new FingerprintShield(bus, () => presets.current());
  const ledger = new Ledger(bus);
  const duress = new DuressController(bus, (ids) => compartments.wipe(ids));
  const update = new UpdateChecker();

  const syncProvider: SyncDataProvider = {
    collect: () => ({
      settings: settings.get(),
      activePreset: presets.activeName(),
      compartments: compartments.list(),
    }),
    apply: (data) => {
      if (data['settings'] && typeof data['settings'] === 'object') {
        settings.patch(data['settings'] as Partial<StoredSettings>);
      }
      if (typeof data['activePreset'] === 'string') {
        try {
          presets.apply(data['activePreset']);
        } catch {
          // Unknown preset in synced data — ignore rather than fail the pull.
        }
      }
    },
  };
  const sync = new SyncClient(bus, syncProvider);

  tabs = new TabManager({
    bus,
    compartments,
    network,
    fingerprint,
    ledger,
    config: () => presets.current(),
    homepage: () => settings.get().homepage,
    showLedgerPanel: () => settings.get().showLedgerPanel,
  });

  registerIpcRouter({ bus, compartments, tabs, presets, ledger, sync, duress, update, settings });

  const preloadPath = join(__dirname, '..', 'preload', 'index.js');
  const chromeHtmlPath = join(__dirname, '..', 'renderer', 'index.html');
  const win = tabs.createWindow(preloadPath, chromeHtmlPath);
  duress.init();

  installAppMenu({
    newTab: () => tabs.create(),
    closeTab: () => tabs.closeActive(),
    reload: () => tabs.reloadActive(),
    back: () => tabs.backActive(),
    forward: () => tabs.forwardActive(),
    focusAddress: () => tabs.focusAddress(),
    toggleDevTools: () => tabs.toggleDevToolsActive(),
  });

  // Open an initial ephemeral tab once the chrome UI has loaded.
  const chrome = tabs.chromeWebContents();
  chrome?.once('did-finish-load', () => {
    tabs.create();
  });

  win.on('closed', () => {
    duress.dispose();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

app.on('second-instance', () => {
  // Focus handling is best-effort; the single window is managed by TabManager.
});

void app.whenReady().then(start);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

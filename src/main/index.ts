/**
 * Application entry point.
 *
 * Constructs every feature module, wires them through the bus and the IPC
 * router, and brings up the main window. Modules receive only the narrow
 * callbacks they need (e.g. a config getter, a wipe function) rather than
 * references to each other's internals.
 *
 * Startup is wrapped so any failure is *visible*: it is written to a log file
 * and shown in an error dialog instead of the process dying silently with no
 * window. All filesystem/app-path access happens after `whenReady`.
 */
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, dialog, globalShortcut, Menu } from 'electron';

import { Bus } from './bus';
import { BookmarksManager } from './bookmarks';
import { CompartmentManager } from './identity';
import { DownloadsManager } from './downloads';
import { DuressController } from './duress';
import { HistoryManager } from './history';
import { SessionManager } from './session';
import { FingerprintShield } from './fingerprint';
import { Ledger } from './ledger';
import { NetworkGuard } from './network';
import { configureSecureDns } from './network/secure-dns';
import { PresetManager } from './presets';
import { registerIpcRouter } from './ipc-router';
import { SettingsStore } from './settings';
import { SyncClient, type SyncDataProvider } from './sync';
import { TabManager } from './tabs';
import { UpdateChecker } from './update';
import type { StoredSettings } from './settings';

/** Append a line to a crash log in userData (falling back to the temp dir). */
function logLine(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  for (const dir of safeDirs()) {
    try {
      appendFileSync(join(dir, 'harbor.log'), line);
      break;
    } catch {
      // try the next directory
    }
  }
  try {
    // eslint-disable-next-line no-console
    console.error(line.trimEnd());
  } catch {
    // ignore
  }
}

function safeDirs(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(app.getPath('userData'));
  } catch {
    // app path not available yet
  }
  dirs.push(tmpdir());
  return dirs;
}

function fatal(label: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logLine(`FATAL ${label}: ${detail}`);
  try {
    dialog.showErrorBox('Harbor failed to start', `${label}\n\n${detail}`);
  } catch {
    // showErrorBox can fail very early; the log still captured it.
  }
}

// Make any otherwise-unhandled failure visible rather than silent.
process.on('uncaughtException', (err) => {
  fatal('uncaughtException', err);
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logLine(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

app.setName('Harbor');
// Stable identity for Windows taskbar grouping and notifications.
app.setAppUserModelId('org.harbor.browser');

// Single-instance: a second launch focuses the existing window instead of
// spawning a parallel session that could fragment compartments.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // The single window is managed by TabManager; nothing to focus explicitly.
  });

  app.whenReady().then(start).catch((err: unknown) => {
    fatal('startup', err);
    app.exit(1);
  });
}

function start(): void {
  logLine('starting up');
  // No native application menu — Harbor's chrome is the only UI. Keyboard
  // shortcuts are handled per-webContents in the tab manager instead.
  Menu.setApplicationMenu(null);
  const bus = new Bus();
  const presets = new PresetManager(bus);
  const settings = new SettingsStore();
  // No-op for the default (system) DNS mode; only DoH/ODoH presets add switches,
  // which take full effect on the next launch.
  configureSecureDns(app.commandLine, presets.current().dnsMode);

  const compartments = new CompartmentManager(bus);

  // TabManager is referenced by the network guard's first-party check before it
  // exists; the closure resolves it lazily once assigned below.
  let tabs: TabManager;
  const network = new NetworkGuard(
    bus,
    () => presets.current(),
    (id) => tabs.getTabUrl(id),
  );
  const downloads = new DownloadsManager(bus);
  compartments.registerSessionConfigurator(network.configureSession);
  compartments.registerSessionConfigurator(downloads.attach);

  const fingerprint = new FingerprintShield(bus, () => presets.current());
  const ledger = new Ledger(bus);
  const duress = new DuressController(bus, (ids) => compartments.wipe(ids));
  const update = new UpdateChecker();
  const bookmarks = new BookmarksManager(bus);
  const history = new HistoryManager(bus);
  const session = new SessionManager();

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

  const startPageUrl = pathToFileURL(join(__dirname, '..', 'renderer', 'newtab.html')).href;

  tabs = new TabManager({
    bus,
    compartments,
    network,
    fingerprint,
    ledger,
    config: () => presets.current(),
    homepage: () => settings.get().homepage,
    startPageUrl,
    showLedgerPanel: () => settings.get().showLedgerPanel,
    showBookmarksBar: () => settings.get().showBookmarksBar,
    bookmarkCount: () => bookmarks.list().length,
    persistSession: (openTabs) => session.save(openTabs),
  });

  registerIpcRouter({ bus, compartments, tabs, presets, ledger, sync, duress, update, settings, bookmarks, history, downloads });

  const preloadPath = join(__dirname, '..', 'preload', 'index.js');
  const chromeHtmlPath = join(__dirname, '..', 'renderer', 'index.html');
  const iconPath = join(__dirname, '..', 'icon.png');
  const win = tabs.createWindow(preloadPath, chromeHtmlPath, iconPath);
  logLine('window created');

  try {
    duress.init();
  } catch (err) {
    // A bad global-shortcut binding must never prevent the app from opening.
    logLine(`duress.init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Restore the previous session (or open a single start-page tab). The chrome
  // UI picks tabs up via bootstrap when it finishes loading.
  if (settings.get().restoreSession) {
    tabs.restore(session.load());
  } else {
    tabs.create();
  }
  logLine('initial tab(s) created');

  win.on('closed', () => {
    duress.dispose();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

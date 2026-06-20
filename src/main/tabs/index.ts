/**
 * Tab manager — the browser shell.
 *
 * Hosts a `BrowserWindow` whose own web contents render the chrome UI, plus one
 * `WebContentsView` per tab layered on top in the content area. BrowserWindow is
 * the most broadly-tested window type across platforms. Each tab is bound to a
 * compartment session, so storage isolation is enforced by Chromium. On tab
 * creation the manager asks the network guard to apply the WebRTC policy and the
 * fingerprint shield to inject — calling their public methods as the
 * orchestrator, without those modules knowing about each other.
 */
import { BrowserWindow, WebContentsView, type WebContents } from 'electron';

import type { TabInfo, TabLoadState } from '../../ipc';
import { Bus } from '../bus';
import { CompartmentManager, EPHEMERAL_COMPARTMENT_ID } from '../identity';
import { FingerprintShield } from '../fingerprint';
import { Ledger } from '../ledger';
import { NetworkGuard } from '../network';
import type { PresetConfig } from '../../ipc';

// Must match the chrome CSS: title bar (40) + toolbar (48).
const TOPBAR_HEIGHT = 88;
const LEDGER_PANEL_WIDTH = 360;

interface TabEntry {
  readonly view: WebContentsView;
  compartmentId: string;
  url: string;
  title: string;
  loadState: TabLoadState;
}

export interface TabManagerDeps {
  readonly bus: Bus;
  readonly compartments: CompartmentManager;
  readonly network: NetworkGuard;
  readonly fingerprint: FingerprintShield;
  readonly ledger: Ledger;
  readonly config: () => PresetConfig;
  /** User homepage; empty means "use Harbor's local start page". */
  readonly homepage: () => string;
  /** file:// URL of the bundled start page shown for new/blank tabs. */
  readonly startPageUrl: string;
  readonly showLedgerPanel: () => boolean;
}

export class TabManager {
  private window: BrowserWindow | null = null;
  private readonly tabs = new Map<number, TabEntry>();
  private activeTabId: number | null = null;

  constructor(private readonly deps: TabManagerDeps) {
    this.deps.bus.on('duress:activated', (payload) => {
      if (payload.decoyActivated && payload.decoyCompartmentId) {
        this.activateDecoy(payload.decoyCompartmentId);
      }
    });
  }

  /** Create the main window and load the chrome UI into its web contents. */
  createWindow(preloadPath: string, chromeHtmlPath: string, iconPath: string): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 940,
      minHeight: 600,
      title: 'Harbor',
      icon: iconPath,
      backgroundColor: '#0b1220',
      // Frameless: Harbor draws its own title bar and window controls.
      frame: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        // The chrome UI is our own local code behind a strict CSP and loads no
        // remote content; contextIsolation is the real boundary protecting the
        // bridge. sandbox:false lets the preload load the IPC contract via Node
        // require. Web-content tabs below run fully sandboxed.
        sandbox: false,
        nodeIntegration: false,
      },
    });
    this.window = win;
    win.setMenu(null);
    this.wireShortcuts(win.webContents);

    void win.loadFile(chromeHtmlPath);

    win.on('resize', () => this.layout());
    win.on('maximize', () => win.webContents.send('window:maximized', true));
    win.on('unmaximize', () => win.webContents.send('window:maximized', false));
    win.on('closed', () => {
      this.window = null;
    });
    return win;
  }

  chromeWebContents(): WebContents | null {
    return this.window?.webContents ?? null;
  }

  // --- window controls (custom title bar) ---
  minimizeWindow(): void {
    this.window?.minimize();
  }
  toggleMaximize(): void {
    const win = this.window;
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
  closeWindow(): void {
    this.window?.close();
  }
  isMaximized(): boolean {
    return this.window?.isMaximized() ?? false;
  }

  // --- find in page ---
  findInActive(text: string, forward: boolean): void {
    if (this.activeTabId === null || text.length === 0) return;
    this.requireTab(this.activeTabId).view.webContents.findInPage(text, { forward, findNext: false });
  }
  stopFindActive(): void {
    if (this.activeTabId === null) return;
    this.requireTab(this.activeTabId).view.webContents.stopFindInPage('clearSelection');
  }

  /** Top-level URL of a tab — used by the network guard for first-party checks. */
  getTabUrl = (webContentsId: number): string | null => {
    return this.tabs.get(webContentsId)?.url ?? null;
  };

  list(): readonly TabInfo[] {
    return [...this.tabs.values()].map((entry) => this.buildInfo(entry));
  }

  private defaultCompartment(): string {
    return this.deps.config().defaultCompartment === 'persistent' ? 'personal' : EPHEMERAL_COMPARTMENT_ID;
  }

  /** Where a fresh tab points: the user's homepage, or the local start page. */
  private newTabTarget(): string {
    const home = this.deps.homepage().trim();
    return home.length > 0 ? home : this.deps.startPageUrl;
  }

  create(compartmentId?: string, url?: string): TabInfo {
    if (!this.window) {
      throw new Error('Window is not initialised');
    }
    const targetCompartment = compartmentId ?? this.defaultCompartment();
    const session = this.deps.compartments.sessionFor(targetCompartment);
    const view = new WebContentsView({
      webPreferences: {
        session,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    const wc = view.webContents;
    const entry: TabEntry = {
      view,
      compartmentId: targetCompartment,
      url: '',
      title: 'New Tab',
      loadState: 'idle',
    };
    this.tabs.set(wc.id, entry);

    // Orchestrate the per-view privacy features.
    this.deps.network.applyWebRtc(wc);
    void this.deps.fingerprint.attach(wc, targetCompartment);

    this.wireTabEvents(entry);
    this.wireShortcuts(wc);

    this.window.contentView.addChildView(view);
    const startUrl = url ?? this.newTabTarget();
    entry.url = startUrl;
    void wc.loadURL(startUrl);

    this.activate(wc.id);
    this.emitListChanged();
    return this.buildInfo(entry);
  }

  /**
   * Browser keyboard shortcuts, handled per-webContents so they work whether
   * the chrome or a web page has focus — without a native menu bar.
   */
  private wireShortcuts(wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') {
        return;
      }
      const mod = input.control || input.meta;
      const key = input.key.toLowerCase();
      let handled = true;
      if (mod && key === 't') this.create();
      else if (mod && key === 'w') this.closeActive();
      else if ((mod && key === 'r') || key === 'f5') this.reloadActive();
      else if (mod && key === 'l') this.focusAddress();
      else if (input.alt && key === 'arrowleft') this.backActive();
      else if (input.alt && key === 'arrowright') this.forwardActive();
      else if ((mod && input.shift && key === 'i') || key === 'f12') this.toggleDevToolsActive();
      else if (mod && key === 'f') this.window?.webContents.send('ui:find', null);
      else handled = false;
      if (handled) {
        event.preventDefault();
      }
    });
  }

  private wireTabEvents(entry: TabEntry): void {
    const wc = entry.view.webContents;
    const update = (): void => {
      this.deps.bus.emit('tab:updated', this.buildInfo(entry));
    };
    wc.on('page-title-updated', (_e, title) => {
      entry.title = title;
      update();
    });
    wc.on('did-start-loading', () => {
      entry.loadState = 'loading';
      update();
    });
    wc.on('did-stop-loading', () => {
      entry.loadState = 'complete';
      update();
    });
    wc.on('did-fail-load', (_e, _code, _desc, _validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        entry.loadState = 'failed';
        update();
      }
    });
    wc.on('did-navigate', (_e, navUrl) => {
      // A new top-level document — the ledger for this tab starts fresh.
      entry.url = navUrl;
      this.deps.ledger.reset(wc.id);
      update();
    });
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) {
        entry.url = navUrl;
        update();
      }
    });
    wc.on('found-in-page', (_e, result) => {
      this.window?.webContents.send('find:result', {
        matches: result.matches,
        active: result.activeMatchOrdinal,
      });
    });
    // Open target=_blank / window.open in a new tab in the same compartment.
    wc.setWindowOpenHandler(({ url }) => {
      this.create(entry.compartmentId, url);
      return { action: 'deny' };
    });
  }

  activate(tabId: number): void {
    if (!this.tabs.has(tabId)) {
      return;
    }
    this.activeTabId = tabId;
    for (const [id, entry] of this.tabs) {
      entry.view.setVisible(id === tabId);
    }
    this.layout();
  }

  navigate(tabId: number, url: string): TabInfo {
    const entry = this.requireTab(tabId);
    const normalized = normalizeUrl(url);
    entry.url = normalized;
    void entry.view.webContents.loadURL(normalized);
    return this.buildInfo(entry);
  }

  goBack(tabId: number): void {
    const wc = this.requireTab(tabId).view.webContents;
    if (wc.canGoBack()) {
      wc.goBack();
    }
  }

  goForward(tabId: number): void {
    const wc = this.requireTab(tabId).view.webContents;
    if (wc.canGoForward()) {
      wc.goForward();
    }
  }

  reload(tabId: number): void {
    this.requireTab(tabId).view.webContents.reload();
  }

  getActiveId(): number | null {
    return this.activeTabId;
  }

  /** Operate on the currently active tab — used by the application menu. */
  reloadActive(): void {
    if (this.activeTabId !== null) this.reload(this.activeTabId);
  }
  backActive(): void {
    if (this.activeTabId !== null) this.goBack(this.activeTabId);
  }
  forwardActive(): void {
    if (this.activeTabId !== null) this.goForward(this.activeTabId);
  }
  closeActive(): void {
    if (this.activeTabId !== null) this.close(this.activeTabId);
  }
  toggleDevToolsActive(): void {
    if (this.activeTabId === null) return;
    const wc = this.requireTab(this.activeTabId).view.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }
  focusAddress(): void {
    this.window?.webContents.send('ui:focus-address', null);
  }

  close(tabId: number): readonly TabInfo[] {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      return this.list();
    }
    this.deps.fingerprint.detach(entry.view.webContents);
    this.deps.ledger.remove(tabId);
    if (this.window) {
      this.window.contentView.removeChildView(entry.view);
    }
    entry.view.webContents.close();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const next = [...this.tabs.keys()][0];
      if (next !== undefined) {
        this.activate(next);
      } else {
        this.activeTabId = null;
        this.create();
      }
    }
    this.emitListChanged();
    return this.list();
  }

  /** Move a tab to a different compartment by recreating it there. */
  reassign(tabId: number, compartmentId: string): TabInfo {
    const entry = this.requireTab(tabId);
    const url = entry.url;
    this.close(tabId);
    return this.create(compartmentId, url);
  }

  private activateDecoy(decoyCompartmentId: string): void {
    // Tear down every open tab and present a single clean tab in the decoy
    // compartment. Combined with the storage wipe, nothing of the real session
    // remains visible.
    for (const id of [...this.tabs.keys()]) {
      const entry = this.tabs.get(id);
      if (entry) {
        this.deps.fingerprint.detach(entry.view.webContents);
        this.deps.ledger.remove(id);
        if (this.window) {
          this.window.contentView.removeChildView(entry.view);
        }
        entry.view.webContents.close();
        this.tabs.delete(id);
      }
    }
    this.activeTabId = null;
    this.create(decoyCompartmentId);
    this.emitListChanged();
  }

  /** Toggle/relayout when the ledger panel visibility changes. */
  relayout(): void {
    this.layout();
  }

  private layout(): void {
    if (!this.window) {
      return;
    }
    const [width, height] = this.window.getContentSize();
    const w = width ?? 0;
    const h = height ?? 0;
    const panelWidth = this.deps.showLedgerPanel() ? LEDGER_PANEL_WIDTH : 0;
    const contentBounds = {
      x: 0,
      y: TOPBAR_HEIGHT,
      width: Math.max(0, w - panelWidth),
      height: Math.max(0, h - TOPBAR_HEIGHT),
    };
    if (this.activeTabId !== null) {
      const active = this.tabs.get(this.activeTabId);
      active?.view.setBounds(contentBounds);
    }
  }

  private requireTab(tabId: number): TabEntry {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      throw new Error(`Unknown tab: ${tabId}`);
    }
    return entry;
  }

  private buildInfo(entry: TabEntry): TabInfo {
    const wc = entry.view.webContents;
    // The local start page shows as a clean, empty address bar.
    const isStart = entry.url === this.deps.startPageUrl;
    return {
      id: wc.id,
      compartmentId: entry.compartmentId,
      title: isStart ? 'New Tab' : entry.title || wc.getTitle() || 'New Tab',
      url: isStart ? '' : entry.url,
      loadState: entry.loadState,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
    };
  }

  private emitListChanged(): void {
    this.deps.bus.emit('tab:list-changed', this.list());
  }
}

/** Add a scheme when the user typed a bare host; otherwise pass through. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.startsWith('about:')) {
    return trimmed;
  }
  if (/^[^\s.]+\.[^\s]+$/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

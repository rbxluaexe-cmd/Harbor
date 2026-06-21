/**
 * Harbor chrome UI (renderer).
 *
 * Framework-light, dependency-free. Talks to main only through the typed
 * `window.harbor` bridge. Renders a custom frameless title bar with window
 * controls, the tab strip, the toolbar, the find bar, the runtime privacy
 * ledger, and settings. Untrusted strings (titles/URLs) are only ever assigned
 * via textContent.
 */
import type {
  BootstrapState,
  Bookmark,
  Compartment,
  DownloadItem,
  DuressConfig,
  HistoryEntry,
  LedgerSnapshot,
  PresetSummary,
  Settings,
  SyncStatus,
  TabInfo,
} from '../ipc';

const harbor = window.harbor;

type PanelMode = 'ledger' | 'history' | 'settings' | 'compartments';

interface UiState {
  version: string;
  settings: Settings;
  compartments: readonly Compartment[];
  tabs: readonly TabInfo[];
  bookmarks: readonly Bookmark[];
  downloads: readonly DownloadItem[];
  presets: readonly PresetSummary[];
  sync: SyncStatus;
  duress: DuressConfig;
  activeTabId: number | null;
  panelMode: PanelMode;
  ledgerByTab: Map<number, LedgerSnapshot>;
}

const state: UiState = {
  version: '',
  settings: { activePreset: '', homepage: '', showLedgerPanel: true, showBookmarksBar: true, restoreSession: true, theme: 'dark' },
  compartments: [],
  tabs: [],
  bookmarks: [],
  downloads: [],
  presets: [],
  sync: { enabled: false, lastSyncedAt: null, pendingChanges: 0, serverConfigured: false },
  duress: { accelerator: '', wipeCompartments: [], decoyCompartmentId: null, enabled: false },
  activeTabId: null,
  panelMode: 'ledger',
  ledgerByTab: new Map(),
};

// --- DOM helpers -------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'style') node.style.cssText = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else if (typeof value === 'boolean') { if (value) node.setAttribute(key, ''); }
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(d: string | string[], viewBox = '0 0 24 24'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  for (const path of Array.isArray(d) ? d : [d]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  back: 'M15 6l-6 6 6 6',
  forward: 'M9 6l6 6-6 6',
  reload: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v4h-4'],
  shield: 'M12 3l7 3v5c0 4.6-3 7.7-7 9-4-1.3-7-4.4-7-9V6l7-3z',
  lock: ['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-3.5-3.5'],
  star: 'M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 17l-5.25 2.65 1-5.85L3.5 9.7l5.9-.9z',
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M7 7l1 13h8l1-13'],
  download: ['M12 3v11', 'M8 10l4 4 4-4', 'M5 20h14'],
  volume: ['M4 9v6h4l5 4V5L8 9z', 'M16 8.5a4 4 0 0 1 0 7'],
  muted: ['M4 9v6h4l5 4V5L8 9z', 'M16 9.5l5 5M21 9.5l-5 5'],
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

// --- helpers -----------------------------------------------------------------

function activeTab(): TabInfo | null {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}
function compartmentFor(id: string): Compartment | undefined {
  return state.compartments.find((c) => c.id === id);
}
function activeSnapshot(): LedgerSnapshot | null {
  return state.activeTabId === null ? null : state.ledgerByTab.get(state.activeTabId) ?? null;
}
async function invoke<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (err) { console.error('Harbor IPC error', err); return null; }
}

// --- title bar: tabs + window controls --------------------------------------

function renderTabs(): void {
  const strip = $('tabs');
  strip.replaceChildren();
  const ordered = [...state.tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  for (const tab of ordered) {
    const compartment = compartmentFor(tab.compartmentId);
    const lead = tab.loadState === 'loading'
      ? el('span', { class: 'spinner' })
      : el('span', { class: 'dot', style: `background:${compartment?.color ?? '#888'}` });
    const children: HTMLElement[] = [lead];
    if (!tab.pinned) children.push(el('span', { class: 'title', text: tab.title || 'New Tab' }));
    if (tab.audible || tab.muted) {
      const spk = el('span', {
        class: `audio${tab.muted ? ' muted' : ''}`,
        title: tab.muted ? 'Unmute tab' : 'Mute tab',
        onclick: (e: Event) => { e.stopPropagation(); void harbor.invoke('tabs:toggleMute', { tabId: tab.id }); },
      });
      spk.append(icon(tab.muted ? ICONS.muted : ICONS.volume));
      children.push(spk);
    }
    if (!tab.pinned) {
      const close = el('span', { class: 'close', title: 'Close tab', onclick: (e: Event) => { e.stopPropagation(); void closeTab(tab.id); } });
      close.append(icon('M5 5l8 8M13 5l-8 8', '0 0 18 18'));
      children.push(close);
    }
    const chip = el('div', {
      class: `tab${tab.id === state.activeTabId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}`,
      title: tab.url || tab.title,
    }, children);
    chip.addEventListener('click', () => { void selectTab(tab.id); });
    chip.addEventListener('contextmenu', (e: Event) => { e.preventDefault(); void harbor.invoke('tabs:contextMenu', { tabId: tab.id }); });
    chip.addEventListener('auxclick', (e: Event) => { if ((e as MouseEvent).button === 1) { e.preventDefault(); void closeTab(tab.id); } });
    strip.append(chip);
  }
}

let maxButton: HTMLElement;
function wireWindowControls(): void {
  const ctrls = $('winctrls');
  maxButton = ctrls.querySelector('[data-win="max"]') as HTMLElement;
  (ctrls.querySelector('[data-win="min"]') as HTMLElement).addEventListener('click', () => void harbor.invoke('window:minimize'));
  maxButton.addEventListener('click', () => void harbor.invoke('window:toggleMaximize'));
  (ctrls.querySelector('[data-win="close"]') as HTMLElement).addEventListener('click', () => void harbor.invoke('window:close'));
  $('newtab').addEventListener('click', () => { void newTab(); });
}

function setMaximized(maxed: boolean): void {
  // Restore icon = two offset squares; maximize icon = single square.
  maxButton.replaceChildren(
    maxed
      ? icon(['M3.5 4.5h5v5h-5z', 'M5.5 4.5v-1h5v5h-1'], '0 0 12 12')
      : icon('M2.5 2.5h7v7h-7z', '0 0 12 12'),
  );
}

// --- toolbar -----------------------------------------------------------------

let urlInput: HTMLInputElement;

function buildToolbar(): void {
  const toolbar = $('toolbar');
  toolbar.replaceChildren();
  const active = activeTab();

  const back = navButton(ICONS.back, 'Back (Alt+Left)', () => navBack());
  const fwd = navButton(ICONS.forward, 'Forward (Alt+Right)', () => navFwd());
  const reload = navButton(ICONS.reload, 'Reload (Ctrl+R)', () => navReload());

  urlInput = el('input', {
    id: 'url',
    type: 'text',
    placeholder: 'Search or enter address',
    spellcheck: false,
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') void go(urlInput.value); },
  }) as HTMLInputElement;
  const lock = el('span', { class: 'lock', title: 'Connection isolated in compartment' });
  lock.append(icon(ICONS.lock));
  const urlwrap = el('div', { id: 'urlwrap' }, [lock, urlInput]);

  const score = activeSnapshot()?.score;
  const scoreBadge = el('div', { class: `score ${score?.grade ?? ''}`, title: 'Runtime privacy score' }, [
    el('span', { class: 'grade', text: score ? score.grade : '–' }),
    el('span', { class: 'muted', text: score ? String(score.value) : '' }),
  ]);

  const compartmentSelect = el('select', {
    id: 'compartment',
    title: 'Compartment for this tab',
    onchange: (e: Event) => void reassign((e.target as HTMLSelectElement).value),
  });
  for (const c of state.compartments) {
    compartmentSelect.append(el('option', { value: c.id }, [c.name]));
  }
  if (active) (compartmentSelect as HTMLSelectElement).value = active.compartmentId;

  const isHttp = !!active && /^https?:\/\//i.test(active.url);
  const isMarked = !!active && state.bookmarks.some((b) => b.url === active.url);
  const star = el('button', {
    class: `tool-btn star${isMarked ? ' on' : ''}`,
    title: isMarked ? 'Remove bookmark' : 'Bookmark this page',
    onclick: () => void toggleBookmark(),
  });
  star.append(icon(ICONS.star));
  star.toggleAttribute('disabled', !isHttp);

  const activeDownloads = state.downloads.filter((d) => d.state === 'progressing').length;
  const dlBtn = el('button', {
    class: `tool-btn${activeDownloads > 0 ? ' on' : ''}`,
    title: 'Downloads',
    onclick: () => toggleDownloads(),
  });
  dlBtn.append(icon(ICONS.download));
  if (activeDownloads > 0) dlBtn.append(el('span', { class: 'badge', text: String(activeDownloads) }));

  const shield = el('button', {
    class: `tool-btn${state.settings.showLedgerPanel ? ' on' : ''}`,
    title: 'Privacy panel',
    onclick: () => void togglePanel(),
  });
  shield.append(icon(ICONS.shield));

  toolbar.append(back, fwd, reload, urlwrap, scoreBadge, compartmentSelect, star, dlBtn, shield);

  back.toggleAttribute('disabled', !active?.canGoBack);
  fwd.toggleAttribute('disabled', !active?.canGoForward);
  if (active && document.activeElement !== urlInput) urlInput.value = active.url;
}

function navButton(path: string | string[], title: string, onclick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'nav-btn', title, onclick });
  b.append(icon(path));
  return b;
}

// --- find bar ----------------------------------------------------------------

let findInput: HTMLInputElement;
let findCount: HTMLElement;

function buildFindBar(): void {
  const bar = $('findbar');
  findInput = el('input', {
    type: 'text',
    placeholder: 'Find in page',
    spellcheck: false,
    oninput: () => doFind(true),
    onkeydown: (e: Event) => {
      const ev = e as KeyboardEvent;
      if (ev.key === 'Enter') doFind(!ev.shiftKey);
      else if (ev.key === 'Escape') closeFind();
    },
  }) as HTMLInputElement;
  findCount = el('span', { class: 'count', text: '' });
  const prev = el('button', { title: 'Previous (Shift+Enter)', onclick: () => doFind(false) });
  prev.append(icon('M18 15l-6-6-6 6'));
  const next = el('button', { title: 'Next (Enter)', onclick: () => doFind(true) });
  next.append(icon('M6 9l6 6 6-6'));
  const close = el('button', { title: 'Close (Esc)', onclick: () => closeFind() });
  close.append(icon('M6 6l12 12M18 6L6 18'));
  const search = el('span', { class: 'lock', style: 'color:var(--fg-dim)' });
  search.append(icon(ICONS.search));
  bar.replaceChildren(search, findInput, findCount, prev, next, close);
}

function openFind(): void {
  $('findbar').removeAttribute('hidden');
  findInput.focus();
  findInput.select();
  if (findInput.value) doFind(true);
}
function closeFind(): void {
  $('findbar').setAttribute('hidden', '');
  findCount.textContent = '';
  void harbor.invoke('find:stop');
}
function doFind(forward: boolean): void {
  const text = findInput.value;
  if (!text) { findCount.textContent = ''; void harbor.invoke('find:stop'); return; }
  void harbor.invoke('find:start', { text, forward });
}

// --- downloads popover -------------------------------------------------------

function toggleDownloads(): void {
  const dl = $('downloads');
  const willShow = dl.hasAttribute('hidden');
  dl.toggleAttribute('hidden', !willShow);
  if (willShow) renderDownloads();
}

function renderDownloads(): void {
  const dl = $('downloads');
  if (dl.hasAttribute('hidden')) return;
  const header = el('div', { class: 'dl-head' }, [
    el('span', { text: 'Downloads' }),
    el('button', { class: 'btn', text: 'Clear', onclick: () => void harbor.invoke('downloads:clear') }),
  ]);
  const listEl = el('div', { class: 'dl-list' });
  if (state.downloads.length === 0) {
    listEl.append(el('p', { class: 'muted', text: 'No downloads yet.' }));
  } else {
    for (const d of state.downloads) listEl.append(downloadRow(d));
  }
  dl.replaceChildren(header, listEl);
}

function downloadRow(d: DownloadItem): HTMLElement {
  const pct = d.state === 'completed' ? 100 : d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
  const meta =
    d.state === 'progressing'
      ? `${fmtBytes(d.receivedBytes)} / ${d.totalBytes > 0 ? fmtBytes(d.totalBytes) : '?'}`
      : d.state === 'completed'
        ? fmtBytes(d.receivedBytes)
        : d.state;
  const actions: HTMLElement[] = [];
  if (d.state === 'completed') {
    actions.push(el('button', { class: 'btn sm', text: 'Open', onclick: () => void harbor.invoke('downloads:open', { id: d.id }) }));
    actions.push(el('button', { class: 'btn sm', text: 'Folder', onclick: () => void harbor.invoke('downloads:showInFolder', { id: d.id }) }));
  }
  return el('div', { class: 'dl-row' }, [
    el('div', { class: 't', text: d.filename, title: d.url }),
    el('div', { class: 'dl-bar' }, [el('div', { class: `dl-fill ${d.state}`, style: `width:${pct}%` })]),
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-top:5px' }, [
      el('span', { class: 'muted', text: meta }),
      el('div', { class: 'row' }, actions),
    ]),
  ]);
}

// --- bookmarks bar -----------------------------------------------------------

function renderBookmarksBar(): void {
  const bar = $('bookmarksbar');
  const show = state.settings.showBookmarksBar && state.bookmarks.length > 0;
  bar.toggleAttribute('hidden', !show);
  if (!show) return;
  bar.replaceChildren();
  for (const b of state.bookmarks) {
    const fav = el('span', { class: 'fav', text: (b.title || b.url).slice(0, 1).toUpperCase() });
    const x = el('span', { class: 'x', title: 'Remove', onclick: (e: Event) => { e.stopPropagation(); void removeBookmark(b.id); } });
    x.append(icon('M5 5l8 8M13 5l-8 8', '0 0 18 18'));
    const chip = el('div', { class: 'bm-chip', title: b.url }, [fav, el('span', { class: 'label', text: b.title || b.url }), x]);
    chip.addEventListener('click', () => { void navigateActive(b.url); });
    bar.append(chip);
  }
}

// --- panel -------------------------------------------------------------------

function renderPanel(): void {
  const panel = $('panel');
  panel.toggleAttribute('hidden', !state.settings.showLedgerPanel);
  if (!state.settings.showLedgerPanel) return;
  panel.replaceChildren();
  const tabs = el('div', { class: 'panel-tabs' }, [
    panelTabButton('Ledger', 'ledger'),
    panelTabButton('History', 'history'),
    panelTabButton('Settings', 'settings'),
    panelTabButton('Boxes', 'compartments'),
  ]);
  const body = el('div', { class: 'panel-body' });
  panel.append(tabs, body);
  if (state.panelMode === 'ledger') renderLedger(body);
  else if (state.panelMode === 'history') void renderHistory(body);
  else if (state.panelMode === 'settings') renderSettings(body);
  else renderCompartments(body);
}

function panelTabButton(label: string, mode: PanelMode): HTMLElement {
  return el('button', {
    class: state.panelMode === mode ? 'active' : '',
    text: label,
    onclick: () => { state.panelMode = mode; renderPanel(); },
  });
}

function renderLedger(body: HTMLElement): void {
  const snap = activeSnapshot();
  if (!snap) { body.append(el('p', { class: 'muted', text: 'No activity recorded for this tab yet.' })); return; }
  const s = snap.score;
  const ring = el('div', { class: 'ring', style: `--p:${s.value}` }, [
    el('span', { class: 'ring-inner' }, [el('span', { class: `ring-val grade-${s.grade}`, text: String(s.value) })]),
  ]);
  body.append(
    el('div', { class: 'score-card' }, [ring, el('div', { class: 'grade-line', text: `Grade ${s.grade} · live from this page's behaviour` })]),
    el('div', { class: 'stat-grid' }, [
      stat(s.totalRequests, 'requests'),
      stat(s.blockedRequests, 'blocked'),
      stat(s.thirdParties, 'third parties'),
      stat(s.trackersBlocked, 'trackers'),
      stat(s.cnameUncloaked, 'CNAME-uncloaked'),
      stat(s.fingerprintAttempts, 'fingerprint hits'),
    ]),
  );
  for (const entry of [...snap.entries].reverse().slice(0, 100)) {
    body.append(el('div', { class: `entry ${entry.disposition}` }, [
      el('div', { class: 'summary', text: entry.summary }),
      el('div', { class: 'meta', text: `${entry.resourceType} · ${new Date(entry.timestamp).toLocaleTimeString()}` }),
    ]));
  }
}

function stat(n: number, label: string): HTMLElement {
  return el('div', { class: 'stat' }, [el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: label })]);
}

function toggleRow(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  return el('label', { class: 'row', style: 'margin-top:8px' }, [cb, el('span', { text: ` ${label}` })]);
}

let reloadHistory: (() => void) | null = null;

async function renderHistory(body: HTMLElement): Promise<void> {
  const search = el('input', {
    type: 'text',
    placeholder: 'Search history',
    style: 'flex:1;padding:9px 11px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--fg);outline:none;user-select:text',
  }) as HTMLInputElement;
  const clear = el('button', { class: 'btn', text: 'Clear all', onclick: () => void clearHistory() });
  const listEl = el('div', {});
  body.replaceChildren(el('div', { class: 'row', style: 'margin-bottom:12px' }, [search, clear]), listEl);

  const load = (): void => {
    void invoke(harbor.invoke('history:list', { query: search.value, limit: 300 })).then((items) => {
      renderHistoryList(listEl, items ?? []);
    });
  };
  search.addEventListener('input', load);
  reloadHistory = load;
  load();
}

function renderHistoryList(listEl: HTMLElement, items: readonly HistoryEntry[]): void {
  listEl.replaceChildren();
  if (items.length === 0) {
    listEl.append(el('p', { class: 'muted', text: 'No history yet.' }));
    return;
  }
  for (const h of items) {
    const x = el('span', { class: 'x', title: 'Remove', onclick: (e: Event) => { e.stopPropagation(); void removeHistory(h.id); } });
    x.append(icon(ICONS.trash));
    const row = el('div', { class: 'hist-row' }, [
      el('div', { class: 'body' }, [el('div', { class: 't', text: h.title || h.url }), el('div', { class: 'u', text: h.url })]),
      el('span', { class: 'when', text: relTime(h.visitedAt) }),
      x,
    ]);
    row.addEventListener('click', () => { void navigateActive(h.url); });
    listEl.append(row);
  }
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderSettings(body: HTMLElement): void {
  const presetSection = el('div', { class: 'section' }, [el('h3', { text: 'Threat-model preset' })]);
  for (const p of state.presets) {
    const card = el('div', { class: `preset${p.active ? ' active' : ''}` }, [
      el('div', { class: 'name', text: p.name }),
      el('div', { class: 'desc', text: p.description }),
    ]);
    card.addEventListener('click', () => { void applyPreset(p.name); });
    presetSection.append(card);
  }

  const homeInput = el('input', { type: 'text', value: state.settings.homepage, placeholder: 'Empty = Harbor start page' }) as HTMLInputElement;
  const homeSection = el('div', { class: 'section' }, [
    el('h3', { text: 'General' }),
    el('div', { class: 'field' }, [el('label', { text: 'Homepage' }), homeInput,
      el('button', { class: 'btn', text: 'Save homepage', onclick: () => void saveSettings({ homepage: homeInput.value }) })]),
    toggleRow('Show bookmarks bar', state.settings.showBookmarksBar, (v) => void saveSettings({ showBookmarksBar: v })),
    toggleRow('Restore tabs on launch', state.settings.restoreSession, (v) => void saveSettings({ restoreSession: v })),
    toggleRow('Light theme', state.settings.theme === 'light', (v) => void saveSettings({ theme: v ? 'light' : 'dark' })),
  ]);

  const privacy = el('div', { class: 'section' }, [
    el('h3', { text: 'Privacy' }),
    el('div', { class: 'muted', text: 'Wipe cookies, cache, and storage across all compartments, and clear history.' }),
    el('button', { class: 'btn', style: 'margin-top:8px', text: 'Clear all browsing data', onclick: () => void clearBrowsing() }),
  ]);

  body.append(presetSection, homeSection, privacy, renderSyncSection(), renderDuressSection(), renderUpdateSection());
}

function renderSyncSection(): HTMLElement {
  const section = el('div', { class: 'section' }, [el('h3', { text: 'Zero-knowledge sync' })]);
  if (state.sync.enabled) {
    const last = state.sync.lastSyncedAt ? new Date(state.sync.lastSyncedAt).toLocaleString() : 'never';
    section.append(
      el('div', { class: 'muted', text: `Enabled · last synced: ${last}` }),
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn', text: 'Push', onclick: () => void doSync('push') }),
        el('button', { class: 'btn', text: 'Pull', onclick: () => void doSync('pull') }),
        el('button', { class: 'btn', text: 'Disable', onclick: () => void disableSync() }),
      ]),
    );
  } else {
    const pwd = el('input', { type: 'password', placeholder: 'Master password (min 8)' }) as HTMLInputElement;
    const url = el('input', { type: 'text', placeholder: 'Server URL' }) as HTMLInputElement;
    section.append(
      el('div', { class: 'muted', text: 'Keys are derived locally with Argon2id; the server only sees ciphertext.' }),
      el('div', { class: 'field', style: 'margin-top:10px' }, [el('label', { text: 'Master password' }), pwd]),
      el('div', { class: 'field' }, [el('label', { text: 'Server URL' }), url]),
      el('button', { class: 'btn primary', text: 'Enable sync', onclick: () => void enableSync(pwd.value, url.value) }),
    );
  }
  return section;
}

function renderDuressSection(): HTMLElement {
  const d = state.duress;
  const accel = el('input', { type: 'text', value: d.accelerator }) as HTMLInputElement;
  const enabled = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabled.checked = d.enabled;
  const decoy = el('select', {}) as HTMLSelectElement;
  decoy.append(el('option', { value: '' }, ['No decoy switch']));
  for (const c of state.compartments) decoy.append(el('option', { value: c.id }, [c.name]));
  decoy.value = d.decoyCompartmentId ?? '';
  return el('div', { class: 'section' }, [
    el('h3', { text: 'Duress / panic mode' }),
    el('div', { class: 'muted', text: 'A global hotkey instantly wipes storage and can switch to a decoy compartment.' }),
    el('div', { class: 'field', style: 'margin-top:10px' }, [el('label', { text: 'Hotkey' }), accel]),
    el('div', { class: 'field' }, [el('label', { text: 'Decoy compartment' }), decoy]),
    el('label', { class: 'row' }, [enabled, el('span', { text: ' Arm duress hotkey' })]),
    el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('button', { class: 'btn', text: 'Save', onclick: () => void saveDuress({ accelerator: accel.value, wipeCompartments: [], decoyCompartmentId: decoy.value || null, enabled: enabled.checked }) }),
      el('button', { class: 'btn', text: 'Test wipe', onclick: () => void harbor.invoke('duress:trigger') }),
    ]),
  ]);
}

function renderUpdateSection(): HTMLElement {
  const out = el('div', { class: 'muted', text: 'Not checked yet.', style: 'margin-top:8px' });
  return el('div', { class: 'section' }, [
    el('h3', { text: 'Binary transparency' }),
    el('button', { class: 'btn', text: 'Check for signed update', onclick: () => void checkUpdate(out) }),
    out,
  ]);
}

function renderCompartments(body: HTMLElement): void {
  body.append(el('h3', { text: 'Compartments', style: 'margin-bottom:12px' }));
  for (const c of state.compartments) {
    body.append(el('div', { class: 'preset' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'dot-inline', style: `background:${c.color}` }),
        el('span', { class: 'name', text: c.name }),
        el('span', { class: 'pill', text: c.persistent ? 'persistent' : 'ephemeral' }),
      ]),
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn', text: 'New tab here', onclick: () => void newTab(c.id) }),
        c.builtin ? el('span', { class: 'muted', text: 'built-in' }) : el('button', { class: 'btn', text: 'Delete', onclick: () => void removeCompartment(c.id) }),
      ]),
    ]));
  }
  const name = el('input', { type: 'text', placeholder: 'Name' }) as HTMLInputElement;
  const persistent = el('input', { type: 'checkbox' }) as HTMLInputElement;
  persistent.checked = true;
  body.append(el('div', { class: 'section', style: 'margin-top:16px' }, [
    el('h3', { text: 'New compartment' }),
    el('div', { class: 'field' }, [el('label', { text: 'Name' }), name]),
    el('label', { class: 'row' }, [persistent, el('span', { text: ' Persistent (survives restart)' })]),
    el('button', { class: 'btn primary', text: 'Create', style: 'margin-top:10px', onclick: () => void createCompartment(name.value, persistent.checked) }),
  ]));
}

// --- actions -----------------------------------------------------------------

async function newTab(compartmentId?: string): Promise<void> {
  const tab = await invoke(compartmentId ? harbor.invoke('tabs:create', { compartmentId }) : harbor.invoke('tabs:create', {}));
  if (tab) { state.activeTabId = tab.id; await refreshTabs(); }
}
async function closeTab(id: number): Promise<void> { await invoke(harbor.invoke('tabs:close', { tabId: id })); await refreshTabs(); }
async function selectTab(id: number): Promise<void> {
  state.activeTabId = id;
  await invoke(harbor.invoke('tabs:activate', { tabId: id }));
  await loadLedger(id);
  renderAll();
}
async function reassign(compartmentId: string): Promise<void> {
  const active = activeTab();
  if (!active || active.compartmentId === compartmentId) return;
  const tab = await invoke(harbor.invoke('tabs:reassign', { tabId: active.id, compartmentId }));
  if (tab) state.activeTabId = tab.id;
  await refreshTabs();
}
async function go(value: string): Promise<void> {
  if (state.activeTabId === null) await newTab();
  if (state.activeTabId === null) return;
  await invoke(harbor.invoke('tabs:navigate', { tabId: state.activeTabId, url: value }));
  urlInput.blur();
}
function navBack(): void { if (state.activeTabId !== null) void harbor.invoke('tabs:goBack', { tabId: state.activeTabId }); }
function navFwd(): void { if (state.activeTabId !== null) void harbor.invoke('tabs:goForward', { tabId: state.activeTabId }); }
function navReload(): void { if (state.activeTabId !== null) void harbor.invoke('tabs:reload', { tabId: state.activeTabId }); }

async function togglePanel(): Promise<void> { await saveSettings({ showLedgerPanel: !state.settings.showLedgerPanel }); }
async function applyPreset(name: string): Promise<void> {
  const presets = await invoke(harbor.invoke('presets:apply', { name }));
  if (presets) state.presets = presets;
  await syncBootstrapBits();
  renderAll();
}
async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const s = await invoke(harbor.invoke('settings:set', { patch }));
  if (s) state.settings = s;
  renderAll();
}
async function enableSync(password: string, serverUrl: string): Promise<void> { const s = await invoke(harbor.invoke('sync:enable', { password, serverUrl })); if (s) state.sync = s; renderPanel(); }
async function disableSync(): Promise<void> { const s = await invoke(harbor.invoke('sync:disable')); if (s) state.sync = s; renderPanel(); }
async function doSync(dir: 'push' | 'pull'): Promise<void> {
  const res = await invoke(dir === 'push' ? harbor.invoke('sync:push') : harbor.invoke('sync:pull'));
  if (res) window.alert(res.message);
  const s = await invoke(harbor.invoke('sync:status'));
  if (s) state.sync = s;
  renderPanel();
}
async function saveDuress(config: DuressConfig): Promise<void> { const status = await invoke(harbor.invoke('duress:configure', { config })); if (status) state.duress = status.config; renderPanel(); }
async function checkUpdate(out: HTMLElement): Promise<void> {
  out.textContent = 'Checking…';
  const status = await invoke(harbor.invoke('update:check'));
  out.textContent = status ? `${status.message} (signature ${status.signatureVerified ? 'verified' : 'unverified'})` : 'Check failed.';
}
async function createCompartment(name: string, persistent: boolean): Promise<void> {
  if (!name.trim()) return;
  await invoke(harbor.invoke('compartments:create', { name, color: '', persistent }));
  await refreshCompartments();
}
async function removeCompartment(id: string): Promise<void> { await invoke(harbor.invoke('compartments:remove', { id })); await refreshCompartments(); }

async function toggleBookmark(): Promise<void> {
  const active = activeTab();
  if (!active || !/^https?:\/\//i.test(active.url)) return;
  const list = await invoke(harbor.invoke('bookmarks:add', { url: active.url, title: active.title }));
  if (list) state.bookmarks = list;
  renderAll();
}
async function removeBookmark(id: string): Promise<void> {
  const list = await invoke(harbor.invoke('bookmarks:remove', { id }));
  if (list) state.bookmarks = list;
  renderAll();
}
async function navigateActive(url: string): Promise<void> {
  if (state.activeTabId === null) { await newTab(); }
  if (state.activeTabId === null) return;
  await invoke(harbor.invoke('tabs:navigate', { tabId: state.activeTabId, url }));
}
async function removeHistory(id: string): Promise<void> { await invoke(harbor.invoke('history:remove', { id })); reloadHistory?.(); }
async function clearBrowsing(): Promise<void> {
  if (!window.confirm('Clear cookies, cache, storage (all compartments) and history?')) return;
  await invoke(harbor.invoke('data:clearBrowsing'));
  window.alert('Browsing data cleared.');
}
async function clearHistory(): Promise<void> {
  if (!window.confirm('Clear all browsing history?')) return;
  await invoke(harbor.invoke('history:clear'));
  reloadHistory?.();
}

// --- refresh / data ----------------------------------------------------------

async function refreshTabs(): Promise<void> { const tabs = await invoke(harbor.invoke('tabs:list')); if (tabs) state.tabs = tabs; ensureActiveTab(); renderAll(); }
async function refreshCompartments(): Promise<void> { const list = await invoke(harbor.invoke('compartments:list')); if (list) state.compartments = list; renderAll(); }
async function loadLedger(tabId: number): Promise<void> { const snap = await invoke(harbor.invoke('ledger:get', { tabId })); if (snap) state.ledgerByTab.set(tabId, snap); }
async function syncBootstrapBits(): Promise<void> {
  const [sync, duress, settings] = await Promise.all([
    invoke(harbor.invoke('sync:status')), invoke(harbor.invoke('duress:status')), invoke(harbor.invoke('settings:get')),
  ]);
  if (sync) state.sync = sync;
  if (duress) state.duress = duress.config;
  if (settings) state.settings = settings;
}
function ensureActiveTab(): void {
  if (state.activeTabId !== null && state.tabs.some((t) => t.id === state.activeTabId)) return;
  const last = state.tabs[state.tabs.length - 1];
  state.activeTabId = last ? last.id : null;
}

function applyTheme(): void { document.body.dataset['theme'] = state.settings.theme; }

function renderAll(): void { applyTheme(); renderTabs(); buildToolbar(); renderBookmarksBar(); renderPanel(); }

// --- events ------------------------------------------------------------------

function subscribe(): void {
  harbor.on('tabs:list-changed', (list) => { state.tabs = list; ensureActiveTab(); renderTabs(); buildToolbar(); });
  harbor.on('tabs:updated', (info) => {
    state.tabs = state.tabs.map((t) => (t.id === info.id ? info : t));
    renderTabs();
    if (info.id === state.activeTabId) buildToolbar();
  });
  harbor.on('tabs:active-changed', (id) => {
    if (id === state.activeTabId) return;
    state.activeTabId = id;
    renderTabs();
    buildToolbar();
    void loadLedger(id).then(() => { if (state.panelMode === 'ledger') renderPanel(); });
  });
  harbor.on('ledger:updated', (snap) => {
    state.ledgerByTab.set(snap.tabId, snap);
    if (snap.tabId === state.activeTabId) { buildToolbar(); if (state.panelMode === 'ledger') renderPanel(); }
  });
  harbor.on('compartments:changed', (list) => { state.compartments = list; renderAll(); });
  harbor.on('preset:changed', (presets) => { state.presets = presets; void syncBootstrapBits().then(renderAll); });
  harbor.on('sync:changed', (status) => { state.sync = status; if (state.panelMode === 'settings') renderPanel(); });
  harbor.on('window:maximized', (maxed) => setMaximized(maxed));
  harbor.on('ui:focus-address', () => { urlInput.focus(); urlInput.select(); });
  harbor.on('ui:find', () => openFind());
  harbor.on('find:result', ({ matches, active }) => { findCount.textContent = matches > 0 ? `${active}/${matches}` : 'No results'; });
  harbor.on('bookmarks:changed', (list) => { state.bookmarks = list; renderTabs(); buildToolbar(); renderBookmarksBar(); });
  harbor.on('history:changed', () => { if (state.panelMode === 'history') reloadHistory?.(); });
  harbor.on('downloads:changed', (list) => { state.downloads = list; buildToolbar(); renderDownloads(); });
  harbor.on('duress:activated', (payload) => {
    state.ledgerByTab.clear();
    void refreshTabs();
    window.alert(`Duress activated — wiped ${payload.wipedCompartments.length || 'all'} compartment(s)${payload.decoyActivated ? ' and switched to decoy.' : '.'}`);
  });
}

// --- init --------------------------------------------------------------------

async function init(): Promise<void> {
  wireWindowControls();
  buildFindBar();
  const boot = (await invoke(harbor.invoke('app:bootstrap'))) as BootstrapState | null;
  if (boot) {
    state.version = boot.version;
    state.settings = boot.settings;
    state.compartments = boot.compartments;
    state.tabs = boot.tabs;
    state.bookmarks = boot.bookmarks;
    state.presets = boot.presets;
    state.sync = boot.sync;
    state.duress = boot.duress.config;
    ensureActiveTab();
  }
  const dls = await invoke(harbor.invoke('downloads:list'));
  if (dls) state.downloads = dls;
  subscribe();
  renderAll();
  const maxed = await invoke(harbor.invoke('window:isMaximized'));
  setMaximized(maxed ?? false);
}

void init();

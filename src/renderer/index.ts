/**
 * Harbor chrome UI (renderer).
 *
 * Framework-light, dependency-free. It talks to the main process exclusively
 * through the typed `window.harbor` bridge and renders the tab bar, compartment
 * switcher, the runtime privacy ledger, and settings. Untrusted strings (page
 * titles, URLs) are only ever assigned via `textContent`, never `innerHTML`.
 */
import type {
  BootstrapState,
  Compartment,
  DuressConfig,
  LedgerSnapshot,
  PresetSummary,
  Settings,
  SyncStatus,
  TabInfo,
} from '../ipc';

const harbor = window.harbor;

type PanelMode = 'ledger' | 'settings' | 'compartments';

interface UiState {
  version: string;
  settings: Settings;
  compartments: readonly Compartment[];
  tabs: readonly TabInfo[];
  presets: readonly PresetSummary[];
  sync: SyncStatus;
  duress: DuressConfig;
  activeTabId: number | null;
  panelMode: PanelMode;
  ledgerByTab: Map<number, LedgerSnapshot>;
}

const state: UiState = {
  version: '',
  settings: { activePreset: '', homepage: '', showLedgerPanel: true },
  compartments: [],
  tabs: [],
  presets: [],
  sync: { enabled: false, lastSyncedAt: null, pendingChanges: 0, serverConfigured: false },
  duress: { accelerator: '', wipeCompartments: [], decoyCompartmentId: null, enabled: false },
  activeTabId: null,
  panelMode: 'ledger',
  ledgerByTab: new Map(),
};

// --- tiny DOM helper ---------------------------------------------------------

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'style') {
      // Set via the CSSOM rather than a style attribute: CSP's style-src does
      // not govern CSSOM writes, so this keeps the strict policy intact.
      node.style.cssText = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
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
  try {
    return await p;
  } catch (err) {
    console.error('Harbor IPC error', err);
    return null;
  }
}

// --- tab strip ---------------------------------------------------------------

function renderTabs(): void {
  const strip = $('tabstrip');
  strip.replaceChildren();
  for (const tab of state.tabs) {
    const compartment = compartmentFor(tab.compartmentId);
    const chip = el('div', { class: `tab${tab.id === state.activeTabId ? ' active' : ''}` }, [
      el('span', { class: 'dot', style: `background:${compartment?.color ?? '#888'}` }),
      el('span', { class: 'title', text: tab.title || tab.url || 'New Tab', title: tab.url }),
      el('span', {
        class: 'close',
        text: '✕',
        onclick: (e: Event) => {
          e.stopPropagation();
          void closeTab(tab.id);
        },
      }),
    ]);
    chip.addEventListener('click', () => {
      void selectTab(tab.id);
    });
    strip.append(chip);
  }
  strip.append(
    el('button', {
      class: 'tab-add',
      text: '+',
      title: 'New tab',
      onclick: () => {
        void newTab();
      },
    }),
  );
}

// --- toolbar -----------------------------------------------------------------

let urlInput: HTMLInputElement;

function buildToolbar(): void {
  const toolbar = $('toolbar');
  toolbar.replaceChildren();

  const back = el('button', { class: 'nav-btn', text: '‹', title: 'Back', onclick: () => navBack() });
  const fwd = el('button', { class: 'nav-btn', text: '›', title: 'Forward', onclick: () => navFwd() });
  const reload = el('button', { class: 'nav-btn', text: '⟳', title: 'Reload', onclick: () => navReload() });

  urlInput = el('input', {
    id: 'url',
    type: 'text',
    placeholder: 'Search or enter address',
    spellcheck: false,
    onkeydown: (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        void go(urlInput.value);
      }
    },
  }) as HTMLInputElement;

  const compartmentSelect = el('select', {
    id: 'compartment-select',
    title: 'Compartment for this tab',
    onchange: (e: Event) => {
      void reassign((e.target as HTMLSelectElement).value);
    },
  });
  for (const c of state.compartments) {
    compartmentSelect.append(
      el('option', { value: c.id }, [`${c.name}${c.persistent ? '' : ' (ephemeral)'}`]),
    );
  }
  const active = activeTab();
  if (active) (compartmentSelect as HTMLSelectElement).value = active.compartmentId;

  const score = activeSnapshot()?.score;
  const scoreBadge = el('span', { class: 'badge', title: 'Runtime privacy score' }, [
    el('span', { class: `score ${score?.grade ?? ''}`, text: score ? `${score.grade} ${score.value}` : '—' }),
  ]);

  const panelToggle = el('button', {
    title: 'Toggle privacy panel',
    text: '🛡',
    onclick: () => {
      void togglePanel();
    },
  });

  toolbar.append(back, fwd, reload, urlInput, compartmentSelect, scoreBadge, panelToggle);

  back.toggleAttribute('disabled', !active?.canGoBack);
  fwd.toggleAttribute('disabled', !active?.canGoForward);
  if (active && document.activeElement !== urlInput) {
    urlInput.value = active.url;
  }
}

// --- panel -------------------------------------------------------------------

function renderPanel(): void {
  const panel = $('panel');
  panel.toggleAttribute('hidden', !state.settings.showLedgerPanel);
  if (!state.settings.showLedgerPanel) {
    return;
  }
  panel.replaceChildren();

  const tabs = el('div', { class: 'panel-tabs' }, [
    panelTabButton('Ledger', 'ledger'),
    panelTabButton('Settings', 'settings'),
    panelTabButton('Compartments', 'compartments'),
  ]);
  const body = el('div', { class: 'panel-body' });
  panel.append(tabs, body);

  if (state.panelMode === 'ledger') renderLedger(body);
  else if (state.panelMode === 'settings') renderSettings(body);
  else renderCompartments(body);
}

function panelTabButton(label: string, mode: PanelMode): HTMLElement {
  return el('button', {
    class: state.panelMode === mode ? 'active' : '',
    text: label,
    onclick: () => {
      state.panelMode = mode;
      renderPanel();
    },
  });
}

function renderLedger(body: HTMLElement): void {
  const snap = activeSnapshot();
  if (!snap) {
    body.append(el('p', { class: 'muted', text: 'No activity recorded for this tab yet.' }));
    return;
  }
  const s = snap.score;
  body.append(
    el('div', { class: 'score-header' }, [
      el('div', { class: `value score ${s.grade}`, text: String(s.value) }),
      el('div', { class: 'muted', text: `Grade ${s.grade} · live from this page's behaviour` }),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat(s.totalRequests, 'requests'),
      stat(s.blockedRequests, 'blocked'),
      stat(s.thirdParties, 'third parties'),
      stat(s.trackersBlocked, 'trackers'),
      stat(s.cnameUncloaked, 'CNAME-uncloaked'),
      stat(s.fingerprintAttempts, 'fingerprint hits'),
    ]),
  );
  const recent = [...snap.entries].reverse().slice(0, 100);
  for (const entry of recent) {
    body.append(
      el('div', { class: `entry ${entry.disposition}` }, [
        el('div', { class: 'summary', text: entry.summary }),
        el('div', { class: 'meta', text: `${entry.resourceType} · ${new Date(entry.timestamp).toLocaleTimeString()}` }),
      ]),
    );
  }
}

function stat(n: number, label: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'n', text: String(n) }),
    el('div', { class: 'l', text: label }),
  ]);
}

function renderSettings(body: HTMLElement): void {
  // Presets
  const presetSection = el('div', { class: 'section' }, [el('h3', { text: 'Threat-model preset' })]);
  for (const p of state.presets) {
    const card = el('div', { class: `preset${p.active ? ' active' : ''}` }, [
      el('div', { class: 'name', text: p.name }),
      el('div', { class: 'desc', text: p.description }),
    ]);
    card.addEventListener('click', () => {
      void applyPreset(p.name);
    });
    presetSection.append(card);
  }

  // Homepage
  const homeInput = el('input', {
    type: 'text',
    value: state.settings.homepage,
    placeholder: 'Empty = Harbor start page',
  }) as HTMLInputElement;
  const homeSection = el('div', { class: 'section' }, [
    el('h3', { text: 'General' }),
    el('div', { class: 'field' }, [
      el('label', { text: 'Homepage' }),
      homeInput,
      el('button', {
        text: 'Save homepage',
        onclick: () => {
          void saveSettings({ homepage: homeInput.value });
        },
      }),
    ]),
  ]);

  // Sync
  const syncSection = renderSyncSection();

  // Duress
  const duressSection = renderDuressSection();

  // Update
  const updateOut = el('div', { class: 'muted', text: 'Not checked yet.' });
  const updateSection = el('div', { class: 'section' }, [
    el('h3', { text: 'Binary transparency' }),
    el('button', {
      text: 'Check for signed update',
      onclick: () => {
        void checkUpdate(updateOut);
      },
    }),
    updateOut,
  ]);

  body.append(presetSection, homeSection, syncSection, duressSection, updateSection);
}

function renderSyncSection(): HTMLElement {
  const section = el('div', { class: 'section' }, [el('h3', { text: 'Zero-knowledge sync' })]);
  if (state.sync.enabled) {
    const last = state.sync.lastSyncedAt ? new Date(state.sync.lastSyncedAt).toLocaleString() : 'never';
    section.append(
      el('div', { class: 'muted', text: `Enabled · last synced: ${last}` }),
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('button', { text: 'Push', onclick: () => void doSync('push') }),
        el('button', { text: 'Pull', onclick: () => void doSync('pull') }),
        el('button', { text: 'Disable', onclick: () => void disableSync() }),
      ]),
    );
  } else {
    const pwd = el('input', { type: 'password', placeholder: 'Master password (min 8)' }) as HTMLInputElement;
    const url = el('input', { type: 'text', placeholder: 'Server URL (e.g. https://sync.example)' }) as HTMLInputElement;
    section.append(
      el('div', { class: 'muted', text: 'Keys are derived locally with Argon2id; the server only ever sees ciphertext.' }),
      el('div', { class: 'field', style: 'margin-top:8px' }, [el('label', { text: 'Master password' }), pwd]),
      el('div', { class: 'field' }, [el('label', { text: 'Server URL' }), url]),
      el('button', {
        text: 'Enable sync',
        onclick: () => {
          void enableSync(pwd.value, url.value);
        },
      }),
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
  for (const c of state.compartments) {
    decoy.append(el('option', { value: c.id }, [c.name]));
  }
  decoy.value = d.decoyCompartmentId ?? '';

  return el('div', { class: 'section' }, [
    el('h3', { text: 'Duress / panic mode' }),
    el('div', { class: 'muted', text: 'A global hotkey instantly wipes storage and can switch to a decoy compartment.' }),
    el('div', { class: 'field', style: 'margin-top:8px' }, [el('label', { text: 'Hotkey' }), accel]),
    el('div', { class: 'field' }, [el('label', { text: 'Decoy compartment' }), decoy]),
    el('label', { class: 'row' }, [enabled, el('span', { text: ' Arm duress hotkey' })]),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('button', {
        text: 'Save duress config',
        onclick: () => {
          void saveDuress({
            accelerator: accel.value,
            wipeCompartments: [],
            decoyCompartmentId: decoy.value || null,
            enabled: enabled.checked,
          });
        },
      }),
      el('button', { text: 'Test wipe now', onclick: () => void harbor.invoke('duress:trigger') }),
    ]),
  ]);
}

function renderCompartments(body: HTMLElement): void {
  body.append(el('h3', { text: 'Compartments' }));
  for (const c of state.compartments) {
    body.append(
      el('div', { class: 'preset' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'dot', style: `background:${c.color};width:10px;height:10px;border-radius:50%;display:inline-block` }),
          el('span', { class: 'name', text: c.name }),
          el('span', { class: 'pill', text: c.persistent ? 'persistent' : 'ephemeral' }),
        ]),
        el('div', { class: 'row', style: 'margin-top:6px' }, [
          el('button', { text: 'New tab here', onclick: () => void newTab(c.id) }),
          c.builtin
            ? el('span', { class: 'muted', text: 'built-in' })
            : el('button', { text: 'Delete', onclick: () => void removeCompartment(c.id) }),
        ]),
      ]),
    );
  }
  const name = el('input', { type: 'text', placeholder: 'Name' }) as HTMLInputElement;
  const persistent = el('input', { type: 'checkbox' }) as HTMLInputElement;
  persistent.checked = true;
  body.append(
    el('div', { class: 'section', style: 'margin-top:14px' }, [
      el('h3', { text: 'New compartment' }),
      el('div', { class: 'field' }, [el('label', { text: 'Name' }), name]),
      el('label', { class: 'row' }, [persistent, el('span', { text: ' Persistent (survives restart)' })]),
      el('button', {
        text: 'Create',
        style: 'margin-top:8px',
        onclick: () => {
          void createCompartment(name.value, persistent.checked);
        },
      }),
    ]),
  );
}

// --- actions -----------------------------------------------------------------

async function newTab(compartmentId?: string): Promise<void> {
  const tab = await invoke(
    compartmentId ? harbor.invoke('tabs:create', { compartmentId }) : harbor.invoke('tabs:create', {}),
  );
  if (tab) {
    state.activeTabId = tab.id;
    await refreshTabs();
  }
}

async function closeTab(id: number): Promise<void> {
  await invoke(harbor.invoke('tabs:close', { tabId: id }));
  await refreshTabs();
}

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
  if (state.activeTabId === null) {
    await newTab();
  }
  if (state.activeTabId === null) return;
  await invoke(harbor.invoke('tabs:navigate', { tabId: state.activeTabId, url: value }));
}

function navBack(): void {
  if (state.activeTabId !== null) void harbor.invoke('tabs:goBack', { tabId: state.activeTabId });
}
function navFwd(): void {
  if (state.activeTabId !== null) void harbor.invoke('tabs:goForward', { tabId: state.activeTabId });
}
function navReload(): void {
  if (state.activeTabId !== null) void harbor.invoke('tabs:reload', { tabId: state.activeTabId });
}

async function togglePanel(): Promise<void> {
  const next = !state.settings.showLedgerPanel;
  await saveSettings({ showLedgerPanel: next });
}

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

async function enableSync(password: string, serverUrl: string): Promise<void> {
  const s = await invoke(harbor.invoke('sync:enable', { password, serverUrl }));
  if (s) state.sync = s;
  renderPanel();
}
async function disableSync(): Promise<void> {
  const s = await invoke(harbor.invoke('sync:disable'));
  if (s) state.sync = s;
  renderPanel();
}
async function doSync(dir: 'push' | 'pull'): Promise<void> {
  const res = await invoke(dir === 'push' ? harbor.invoke('sync:push') : harbor.invoke('sync:pull'));
  if (res) window.alert(res.message);
  const s = await invoke(harbor.invoke('sync:status'));
  if (s) state.sync = s;
  renderPanel();
}

async function saveDuress(config: DuressConfig): Promise<void> {
  const status = await invoke(harbor.invoke('duress:configure', { config }));
  if (status) state.duress = status.config;
  renderPanel();
}

async function checkUpdate(out: HTMLElement): Promise<void> {
  out.textContent = 'Checking…';
  const status = await invoke(harbor.invoke('update:check'));
  if (!status) {
    out.textContent = 'Check failed.';
    return;
  }
  out.textContent = `${status.message} (signature ${status.signatureVerified ? 'verified' : 'unverified'})`;
}

async function createCompartment(name: string, persistent: boolean): Promise<void> {
  if (!name.trim()) return;
  await invoke(harbor.invoke('compartments:create', { name, color: '', persistent }));
  await refreshCompartments();
}

async function removeCompartment(id: string): Promise<void> {
  await invoke(harbor.invoke('compartments:remove', { id }));
  await refreshCompartments();
}

// --- refresh / data ----------------------------------------------------------

async function refreshTabs(): Promise<void> {
  const tabs = await invoke(harbor.invoke('tabs:list'));
  if (tabs) state.tabs = tabs;
  ensureActiveTab();
  renderAll();
}

async function refreshCompartments(): Promise<void> {
  const list = await invoke(harbor.invoke('compartments:list'));
  if (list) state.compartments = list;
  renderAll();
}

async function loadLedger(tabId: number): Promise<void> {
  const snap = await invoke(harbor.invoke('ledger:get', { tabId }));
  if (snap) state.ledgerByTab.set(tabId, snap);
}

async function syncBootstrapBits(): Promise<void> {
  const [sync, duress, settings] = await Promise.all([
    invoke(harbor.invoke('sync:status')),
    invoke(harbor.invoke('duress:status')),
    invoke(harbor.invoke('settings:get')),
  ]);
  if (sync) state.sync = sync;
  if (duress) state.duress = duress.config;
  if (settings) state.settings = settings;
}

function ensureActiveTab(): void {
  if (state.activeTabId !== null && state.tabs.some((t) => t.id === state.activeTabId)) {
    return;
  }
  const last = state.tabs[state.tabs.length - 1];
  state.activeTabId = last ? last.id : null;
}

// --- render orchestration ----------------------------------------------------

function renderAll(): void {
  renderTabs();
  buildToolbar();
  renderPanel();
}

// --- events ------------------------------------------------------------------

function subscribe(): void {
  harbor.on('tabs:list-changed', (list) => {
    state.tabs = list;
    ensureActiveTab();
    renderTabs();
    buildToolbar();
  });
  harbor.on('tabs:updated', (info) => {
    state.tabs = state.tabs.map((t) => (t.id === info.id ? info : t));
    renderTabs();
    if (info.id === state.activeTabId) buildToolbar();
  });
  harbor.on('ledger:updated', (snap) => {
    state.ledgerByTab.set(snap.tabId, snap);
    if (snap.tabId === state.activeTabId) {
      buildToolbar();
      if (state.panelMode === 'ledger') renderPanel();
    }
  });
  harbor.on('compartments:changed', (list) => {
    state.compartments = list;
    renderAll();
  });
  harbor.on('preset:changed', (presets) => {
    state.presets = presets;
    void syncBootstrapBits().then(renderAll);
  });
  harbor.on('sync:changed', (status) => {
    state.sync = status;
    if (state.panelMode === 'settings') renderPanel();
  });
  harbor.on('ui:focus-address', () => {
    urlInput.focus();
    urlInput.select();
  });
  harbor.on('duress:activated', (payload) => {
    state.ledgerByTab.clear();
    void refreshTabs();
    window.alert(
      `Duress activated — wiped ${payload.wipedCompartments.length || 'all'} compartment(s)` +
        (payload.decoyActivated ? ' and switched to decoy.' : '.'),
    );
  });
}

// --- init --------------------------------------------------------------------

async function init(): Promise<void> {
  const boot = (await invoke(harbor.invoke('app:bootstrap'))) as BootstrapState | null;
  if (boot) {
    state.version = boot.version;
    state.settings = boot.settings;
    state.compartments = boot.compartments;
    state.tabs = boot.tabs;
    state.presets = boot.presets;
    state.sync = boot.sync;
    state.duress = boot.duress.config;
    ensureActiveTab();
  }
  subscribe();
  renderAll();
}

void init();

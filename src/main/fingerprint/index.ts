/**
 * Fingerprint shield.
 *
 * Patches fingerprint-surface APIs before any page script runs. A preload under
 * `contextIsolation` lives in an isolated world and cannot touch the page's own
 * prototype chain, so instead we drive the Chrome DevTools Protocol via
 * `webContents.debugger` and use `Page.addScriptToEvaluateOnNewDocument`, which
 * injects into the real main world ahead of the page. A `Runtime.addBinding`
 * channel lets the injected script report attempts back so the ledger can show
 * them. This module knows nothing of the ledger — it only emits on the bus.
 */
import type { WebContents } from 'electron';

import type { PresetConfig } from '../../ipc';
import { Bus } from '../bus';
import { buildInjectionScript } from './script';
import { deriveSeed, newSessionNonce } from './seed';

const REPORT_BINDING = '__harborReport';

interface BindingCalledParams {
  name?: string;
  payload?: string;
}

export class FingerprintShield {
  private readonly sessionNonce = newSessionNonce();
  private readonly attached = new Set<number>();

  constructor(
    private readonly bus: Bus,
    private readonly config: () => PresetConfig,
  ) {}

  /**
   * Attach shielding to a tab's content view. Reads the active fingerprint mode
   * at attach time; in `off` mode nothing is injected. Safe to call once per
   * content view — repeated calls are ignored.
   */
  async attach(webContents: WebContents, compartmentId: string): Promise<void> {
    const mode = this.config().fingerprintMode;
    if (mode === 'off') {
      return;
    }
    if (this.attached.has(webContents.id)) {
      return;
    }
    this.attached.add(webContents.id);

    try {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach('1.3');
      }
    } catch {
      // Another debugger (e.g. DevTools) owns the target; shielding is skipped
      // for this view rather than crashing the tab.
      this.attached.delete(webContents.id);
      return;
    }

    webContents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Runtime.bindingCalled') {
        return;
      }
      const called = params as BindingCalledParams;
      if (called.name === REPORT_BINDING && typeof called.payload === 'string') {
        this.bus.emit('fingerprint:attempt', { tabId: webContents.id, api: called.payload });
      }
    });

    webContents.once('destroyed', () => this.detach(webContents));

    const seed = deriveSeed(this.sessionNonce, compartmentId);
    const source = buildInjectionScript(seed, mode);
    try {
      await webContents.debugger.sendCommand('Runtime.enable');
      await webContents.debugger.sendCommand('Runtime.addBinding', { name: REPORT_BINDING });
      await webContents.debugger.sendCommand('Page.enable');
      await webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
    } catch {
      // If CDP setup fails partway, leave the view usable.
      this.attached.delete(webContents.id);
    }
  }

  detach(webContents: WebContents): void {
    this.attached.delete(webContents.id);
    try {
      if (webContents.debugger.isAttached()) {
        webContents.debugger.detach();
      }
    } catch {
      // Already detached / destroyed.
    }
  }
}

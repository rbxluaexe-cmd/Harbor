/**
 * Duress / panic mode.
 *
 * Registers a configurable global accelerator that wipes storage for the
 * configured compartments and, if set, signals a switch to a decoy compartment.
 * This is a first-class, preset-driven feature rather than a buried settings
 * checkbox — the gap mainstream browsers leave open. The actual wipe is
 * delegated through an injected callback so this module never imports the
 * identity module; the decoy switch is announced on the bus for the tab layer
 * to carry out.
 */
import { globalShortcut } from 'electron';

import type { DuressConfig, DuressStatus } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';
import { duressConfigSchema } from '../presets/schema';

const storeSchema = duressConfigSchema;

export type WipeFn = (compartmentIds: readonly string[]) => Promise<void>;

const FALLBACK_CONFIG: DuressConfig = {
  accelerator: 'CommandOrControl+Shift+X',
  wipeCompartments: [],
  decoyCompartmentId: null,
  enabled: false,
};

export class DuressController {
  private readonly store: JsonStore<DuressConfig>;
  private registered = false;

  constructor(
    private readonly bus: Bus,
    private readonly wipe: WipeFn,
  ) {
    this.store = new JsonStore<DuressConfig>('duress.json', storeSchema, () => FALLBACK_CONFIG);
    // Presets are authoritative for the recommended duress binding; adopt it
    // whenever the active preset changes.
    this.bus.on('preset:changed', (config) => {
      this.applyConfig(config.duress);
    });
  }

  /** Call once after the app is ready so globalShortcut can register. */
  init(): void {
    this.register();
  }

  status(): DuressStatus {
    return { armed: this.registered && this.store.get().enabled, config: this.store.get() };
  }

  configure(config: DuressConfig): DuressStatus {
    this.applyConfig(config);
    return this.status();
  }

  private applyConfig(config: DuressConfig): void {
    this.store.set(config);
    this.register();
  }

  private register(): void {
    globalShortcut.unregister(this.previousAccelerator);
    this.registered = false;
    const config = this.store.get();
    this.previousAccelerator = config.accelerator;
    if (!config.enabled) {
      return;
    }
    try {
      this.registered = globalShortcut.register(config.accelerator, () => {
        void this.trigger();
      });
    } catch {
      this.registered = false;
    }
  }

  private previousAccelerator = FALLBACK_CONFIG.accelerator;

  /** Fire the duress action: wipe, then signal decoy activation. */
  async trigger(): Promise<void> {
    const config = this.store.get();
    await this.wipe(config.wipeCompartments);
    const decoyActivated = config.decoyCompartmentId !== null;
    this.bus.emit('duress:activated', {
      wipedCompartments: config.wipeCompartments,
      decoyActivated,
      decoyCompartmentId: config.decoyCompartmentId,
    });
  }

  dispose(): void {
    globalShortcut.unregister(this.previousAccelerator);
    this.registered = false;
  }
}

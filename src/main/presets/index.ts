/**
 * Preset manager.
 *
 * Owns the catalogue of threat-model presets and the currently active one,
 * and exposes the resolved `PresetConfig` that every other privacy module
 * reads live. Applying a preset emits `preset:changed` on the bus so the
 * network, fingerprint, and duress modules can re-read configuration without
 * being coupled to the preset module's internals.
 */
import type { Preset, PresetConfig, PresetSummary } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';
import { DEFAULT_ACTIVE_PRESET, DEFAULT_PRESETS } from './defaults';
import { presetCollectionSchema } from './schema';

interface PresetCollection {
  activePreset: string;
  presets: Preset[];
}

export class PresetManager {
  private readonly store: JsonStore<PresetCollection>;

  constructor(private readonly bus: Bus) {
    this.store = new JsonStore<PresetCollection>(
      'presets.json',
      presetCollectionSchema,
      () => ({ activePreset: DEFAULT_ACTIVE_PRESET, presets: [...DEFAULT_PRESETS] }),
    );
    this.ensureDefaults();
  }

  private ensureDefaults(): void {
    const current = this.store.get();
    const names = new Set(current.presets.map((p) => p.name));
    const merged = [...current.presets];
    let changed = false;
    for (const preset of DEFAULT_PRESETS) {
      if (!names.has(preset.name)) {
        merged.push(preset);
        changed = true;
      }
    }
    if (!merged.some((p) => p.name === current.activePreset)) {
      current.activePreset = DEFAULT_ACTIVE_PRESET;
      changed = true;
    }
    if (changed) {
      this.store.set({ activePreset: current.activePreset, presets: merged });
    }
  }

  list(): readonly PresetSummary[] {
    const { activePreset, presets } = this.store.get();
    return presets.map((p) => ({
      name: p.name,
      description: p.description,
      active: p.name === activePreset,
    }));
  }

  get(name: string): Preset {
    const preset = this.store.get().presets.find((p) => p.name === name);
    if (!preset) {
      throw new Error(`Unknown preset: ${name}`);
    }
    return preset;
  }

  activeName(): string {
    return this.store.get().activePreset;
  }

  /** The live configuration every privacy module reads. */
  current(): PresetConfig {
    return this.get(this.activeName()).config;
  }

  apply(name: string): readonly PresetSummary[] {
    const preset = this.get(name);
    this.store.update((c) => ({ ...c, activePreset: preset.name }));
    this.bus.emit('preset:changed', preset.config);
    return this.list();
  }
}

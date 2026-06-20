/**
 * Built-in threat-model presets.
 *
 * These are intentionally *different configurations for different threats*,
 * not points along a single linear slider. "Everyday" defends against ordinary
 * ad-tracking; "Journalist" assumes a capable adversary and arms duress mode;
 * "Public terminal" assumes the machine itself is hostile and keeps nothing.
 */
import type { Preset } from '../../ipc';
import { PRESET_SCHEMA_VERSION } from './schema';

export const DEFAULT_PRESETS: readonly Preset[] = [
  {
    schemaVersion: PRESET_SCHEMA_VERSION,
    name: 'Everyday',
    description: 'Balanced defaults: blocks trackers and uncloaks CNAMEs without breaking sites.',
    config: {
      fingerprintMode: 'standard',
      dnsMode: 'doh',
      defaultCompartment: 'ephemeral',
      webRtcPolicy: 'proxy-only',
      cnameUncloaking: true,
      syncEnabled: false,
      duress: {
        accelerator: 'CommandOrControl+Shift+X',
        wipeCompartments: [],
        decoyCompartmentId: null,
        enabled: false,
      },
    },
  },
  {
    schemaVersion: PRESET_SCHEMA_VERSION,
    name: 'Journalist',
    description: 'Hardened for a capable adversary: strict fingerprint noise, duress wipe armed.',
    config: {
      fingerprintMode: 'strict',
      dnsMode: 'odoh-relay',
      defaultCompartment: 'ephemeral',
      webRtcPolicy: 'disabled',
      cnameUncloaking: true,
      syncEnabled: true,
      duress: {
        accelerator: 'CommandOrControl+Shift+Delete',
        wipeCompartments: [],
        decoyCompartmentId: 'personal',
        enabled: true,
      },
    },
  },
  {
    schemaVersion: PRESET_SCHEMA_VERSION,
    name: 'Public terminal',
    description: 'Assumes the machine is hostile: everything ephemeral, nothing synced or persisted.',
    config: {
      fingerprintMode: 'strict',
      dnsMode: 'doh',
      defaultCompartment: 'ephemeral',
      webRtcPolicy: 'disabled',
      cnameUncloaking: true,
      syncEnabled: false,
      duress: {
        accelerator: 'CommandOrControl+Shift+X',
        wipeCompartments: [],
        decoyCompartmentId: null,
        enabled: true,
      },
    },
  },
];

export const DEFAULT_ACTIVE_PRESET = 'Everyday';

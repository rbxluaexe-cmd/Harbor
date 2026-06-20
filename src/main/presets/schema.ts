/**
 * Zod schemas for threat-model presets. Presets are validated on load so a
 * malformed or tampered preset file can never silently weaken the active
 * privacy configuration — it is rejected and the default is used instead.
 */
import { z } from 'zod';

export const fingerprintModeSchema = z.enum(['off', 'standard', 'strict']);
export const dnsModeSchema = z.enum(['system', 'doh', 'odoh-relay']);
export const defaultCompartmentSchema = z.enum(['ephemeral', 'persistent']);
export const webRtcPolicySchema = z.enum(['default', 'proxy-only', 'disabled']);

export const duressConfigSchema = z.object({
  accelerator: z.string().min(1),
  wipeCompartments: z.array(z.string()),
  decoyCompartmentId: z.string().nullable(),
  enabled: z.boolean(),
});

export const presetConfigSchema = z.object({
  fingerprintMode: fingerprintModeSchema,
  dnsMode: dnsModeSchema,
  defaultCompartment: defaultCompartmentSchema,
  webRtcPolicy: webRtcPolicySchema,
  cnameUncloaking: z.boolean(),
  syncEnabled: z.boolean(),
  duress: duressConfigSchema,
});

/** Current schema version. Bump when the config shape changes. */
export const PRESET_SCHEMA_VERSION = 1;

export const presetSchema = z.object({
  schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
  name: z.string().min(1),
  description: z.string(),
  config: presetConfigSchema,
});

export const presetCollectionSchema = z.object({
  activePreset: z.string().min(1),
  presets: z.array(presetSchema),
});

/**
 * Per-site permissions.
 *
 * Harbor denies the privacy-sensitive permissions by default and allows benign
 * ones, but the user can override either way per origin. Overrides are
 * persisted; the set of permissions a site has *requested* is tracked in memory
 * so the UI can show only what's relevant for the current site. The network
 * guard consults `decide` for every request and announces each request on the
 * bus so this module can record it — the guard never imports this module.
 */
import { z } from 'zod';

import type { OriginPermissions, PermissionDecision, SitePermission } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';

/** Permissions denied unless the user explicitly allows them. */
const DEFAULT_DENY: ReadonlySet<string> = new Set([
  'clipboard-read',
  'geolocation',
  'media',
  'hid',
  'serial',
  'usb',
  'midiSysex',
  'idle-detection',
  'display-capture',
]);

const LABELS: Readonly<Record<string, string>> = {
  'clipboard-read': 'Clipboard',
  geolocation: 'Location',
  media: 'Camera & microphone',
  notifications: 'Notifications',
  midi: 'MIDI',
  midiSysex: 'MIDI (SysEx)',
  hid: 'HID devices',
  serial: 'Serial ports',
  usb: 'USB devices',
  'idle-detection': 'Idle detection',
  'display-capture': 'Screen capture',
  pointerLock: 'Pointer lock',
  fullscreen: 'Fullscreen',
  openExternal: 'Open external apps',
};

const overrideSchema = z.enum(['allow', 'deny']);
const storeSchema = z.object({
  overrides: z.record(z.record(overrideSchema)),
});
type PermissionStore = z.infer<typeof storeSchema>;

function labelFor(permission: string): string {
  return LABELS[permission] ?? permission;
}

export class PermissionsManager {
  private readonly store: JsonStore<PermissionStore>;
  private readonly requested = new Map<string, Set<string>>();

  constructor(private readonly bus: Bus) {
    this.store = new JsonStore<PermissionStore>('permissions.json', storeSchema, () => ({ overrides: {} }));
    this.bus.on('permission:requested', ({ origin, permission }) => this.record(origin, permission));
  }

  /** The decision for a permission request — override first, else default policy. */
  decide = (origin: string, permission: string): boolean => {
    const override = this.store.get().overrides[origin]?.[permission];
    if (override) {
      return override === 'allow';
    }
    return !DEFAULT_DENY.has(permission);
  };

  private record(origin: string, permission: string): void {
    if (!origin) return;
    const set = this.requested.get(origin) ?? new Set<string>();
    if (!set.has(permission)) {
      set.add(permission);
      this.requested.set(origin, set);
      this.bus.emit('permissions:changed', origin);
    }
  }

  list(origin: string): readonly SitePermission[] {
    const overrides = this.store.get().overrides[origin] ?? {};
    const requested = this.requested.get(origin) ?? new Set<string>();
    const names = new Set<string>([...Object.keys(overrides), ...requested]);
    return [...names]
      .sort()
      .map((permission) => {
        const override: PermissionDecision = overrides[permission] ?? 'default';
        const effective = this.decide(origin, permission) ? 'allow' : 'deny';
        return { permission, label: labelFor(permission), effective, override, requested: requested.has(permission) };
      });
  }

  /** Every origin that has at least one override, for the global manager. */
  allSites(): readonly OriginPermissions[] {
    return Object.keys(this.store.get().overrides)
      .sort()
      .map((origin) => ({ origin, permissions: this.list(origin) }));
  }

  /** Remove all overrides for an origin (reset to defaults). */
  clearOrigin(origin: string): readonly OriginPermissions[] {
    this.store.update((s) => {
      const overrides = { ...s.overrides };
      delete overrides[origin];
      return { overrides };
    });
    this.bus.emit('permissions:changed', origin);
    return this.allSites();
  }

  set(origin: string, permission: string, decision: PermissionDecision): readonly SitePermission[] {
    this.store.update((s) => {
      const overrides = { ...s.overrides };
      const forOrigin = { ...(overrides[origin] ?? {}) };
      if (decision === 'default') {
        delete forOrigin[permission];
      } else {
        forOrigin[permission] = decision;
      }
      if (Object.keys(forOrigin).length > 0) {
        overrides[origin] = forOrigin;
      } else {
        delete overrides[origin];
      }
      return { overrides };
    });
    this.bus.emit('permissions:changed', origin);
    return this.list(origin);
  }
}

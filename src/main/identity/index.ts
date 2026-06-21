/**
 * Identity compartments.
 *
 * Each compartment is backed by a distinct Chromium partition, so storage
 * isolation (cookies, IndexedDB, cache, service workers) is enforced by the
 * engine itself rather than by app-level filtering. Persistent compartments use
 * a `persist:` partition that survives restarts; ephemeral ones use a
 * non-`persist:` partition that Chromium discards when its last consumer goes
 * away. New tabs default to an explicit ephemeral compartment, never a shared
 * default partition.
 */
import { randomUUID } from 'node:crypto';

import { session, type Session } from 'electron';
import { z } from 'zod';

import type { Compartment } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';

const compartmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  persistent: z.boolean(),
  builtin: z.boolean(),
});

const storeSchema = z.object({
  compartments: z.array(compartmentSchema),
});

type CompartmentStore = z.infer<typeof storeSchema>;

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

/** The compartment new ephemeral tabs land in by default. */
export const EPHEMERAL_COMPARTMENT_ID = 'ephemeral';
/** The hardened, no-history private-browsing compartment. */
export const INCOGNITO_COMPARTMENT_ID = 'incognito';

const BUILTIN_COMPARTMENTS: readonly Compartment[] = [
  { id: EPHEMERAL_COMPARTMENT_ID, name: 'Ephemeral', color: '#94a3b8', persistent: false, builtin: true },
  { id: INCOGNITO_COMPARTMENT_ID, name: 'Private', color: '#a855f7', persistent: false, builtin: true },
  { id: 'personal', name: 'Personal', color: '#3b82f6', persistent: true, builtin: true },
  { id: 'work', name: 'Work', color: '#10b981', persistent: true, builtin: true },
];

/** A function that configures a freshly-materialized session exactly once. */
export type SessionConfigurator = (session: Session, compartment: Compartment) => void;

export class CompartmentManager {
  private readonly store: JsonStore<CompartmentStore>;
  private readonly configurators: SessionConfigurator[] = [];
  private readonly configured = new Set<string>();

  constructor(private readonly bus: Bus) {
    this.store = new JsonStore<CompartmentStore>(
      'compartments.json',
      storeSchema,
      () => ({ compartments: [...BUILTIN_COMPARTMENTS] }),
    );
    this.ensureBuiltins();
  }

  private ensureBuiltins(): void {
    const current = this.store.get().compartments;
    const byId = new Map(current.map((c) => [c.id, c]));
    let changed = false;
    for (const builtin of BUILTIN_COMPARTMENTS) {
      if (!byId.has(builtin.id)) {
        byId.set(builtin.id, builtin);
        changed = true;
      }
    }
    if (changed) {
      this.store.set({ compartments: [...byId.values()] });
    }
  }

  /**
   * Register a configurator that runs the first time each unique session is
   * materialized. The network layer uses this to install its webRequest hooks
   * and DNS/proxy settings without the identity module knowing those features
   * exist.
   */
  registerSessionConfigurator(fn: SessionConfigurator): void {
    this.configurators.push(fn);
  }

  list(): readonly Compartment[] {
    return this.store.get().compartments;
  }

  get(id: string): Compartment | undefined {
    return this.store.get().compartments.find((c) => c.id === id);
  }

  /** Stable Chromium partition string for a compartment. */
  partitionFor(compartment: Compartment): string {
    return compartment.persistent ? `persist:harbor-${compartment.id}` : `harbor-eph-${compartment.id}`;
  }

  /**
   * Return the Electron session for a compartment, materializing and running
   * configurators on first access.
   */
  sessionFor(compartmentId: string): Session {
    const compartment = this.get(compartmentId) ?? this.requireEphemeral();
    const partition = this.partitionFor(compartment);
    const ses = session.fromPartition(partition);
    if (!this.configured.has(partition)) {
      this.configured.add(partition);
      for (const configure of this.configurators) {
        configure(ses, compartment);
      }
    }
    return ses;
  }

  private requireEphemeral(): Compartment {
    const eph = this.get(EPHEMERAL_COMPARTMENT_ID);
    if (!eph) {
      throw new Error('Ephemeral compartment missing — store is corrupt');
    }
    return eph;
  }

  create(name: string, color: string, persistent: boolean): Compartment {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new Error('Compartment name cannot be empty');
    }
    const compartment: Compartment = {
      id: `${slug(trimmed)}-${randomUUID().slice(0, 8)}`,
      name: trimmed,
      color: color || pickColor(this.list().length),
      persistent,
      builtin: false,
    };
    this.store.update((s) => ({ compartments: [...s.compartments, compartment] }));
    this.bus.emit('compartments:changed', this.list());
    return compartment;
  }

  remove(id: string): readonly Compartment[] {
    const target = this.get(id);
    if (!target) {
      return this.list();
    }
    if (target.builtin) {
      throw new Error('Built-in compartments cannot be removed');
    }
    this.store.update((s) => ({ compartments: s.compartments.filter((c) => c.id !== id) }));
    // Best-effort: drop persisted storage for the removed compartment.
    void this.sessionFor(EPHEMERAL_COMPARTMENT_ID); // ensure module is alive
    try {
      const ses = session.fromPartition(this.partitionFor(target));
      void ses.clearStorageData();
    } catch {
      // Session may never have been materialized; nothing to clear.
    }
    this.bus.emit('compartments:changed', this.list());
    return this.list();
  }

  /** Wipe storage for a set of compartments (used by duress mode). */
  async wipe(compartmentIds: readonly string[]): Promise<void> {
    const targets = compartmentIds.length > 0 ? compartmentIds : this.list().map((c) => c.id);
    await Promise.all(
      targets.map(async (id) => {
        const compartment = this.get(id);
        if (!compartment) {
          return;
        }
        const ses = session.fromPartition(this.partitionFor(compartment));
        await ses.clearStorageData();
        await ses.clearCache();
      }),
    );
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'compartment';
}

function pickColor(index: number): string {
  return PALETTE[index % PALETTE.length] ?? '#3b82f6';
}

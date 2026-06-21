/**
 * Browsing history.
 *
 * Records top-level navigations announced on the bus, newest first, capped to a
 * bounded size. Consecutive visits to the same URL collapse into one entry
 * (its title/time update as the page finishes loading) so reloads and
 * title-arrives-late don't create duplicates. History is per-profile and lives
 * only on disk under userData — never synced or sent anywhere.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { HistoryEntry } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';

const entrySchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  visitedAt: z.number(),
});

const storeSchema = z.object({ entries: z.array(entrySchema) });
type HistoryStore = z.infer<typeof storeSchema>;

const MAX_ENTRIES = 5000;

export class HistoryManager {
  private readonly store: JsonStore<HistoryStore>;

  constructor(private readonly bus: Bus) {
    this.store = new JsonStore<HistoryStore>('history.json', storeSchema, () => ({ entries: [] }));
    this.bus.on('history:visit', ({ url, title }) => this.record(url, title));
  }

  private record(url: string, title: string): void {
    this.store.update((s) => {
      const entries = [...s.entries];
      const top = entries[0];
      if (top && top.url === url) {
        // Same page — update title/time rather than adding a duplicate.
        entries[0] = { ...top, title: title.trim() || top.title, visitedAt: Date.now() };
      } else {
        entries.unshift({ id: randomUUID(), url, title: title.trim() || url, visitedAt: Date.now() });
      }
      return { entries: entries.slice(0, MAX_ENTRIES) };
    });
    this.bus.emit('history:changed', undefined);
  }

  list(query?: string, limit = 200): readonly HistoryEntry[] {
    const all = this.store.get().entries;
    const q = query?.trim().toLowerCase();
    const filtered = q
      ? all.filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
      : all;
    return filtered.slice(0, limit);
  }

  /** Most-visited sites, aggregated by origin, for the start page. */
  topSites(limit = 8): ReadonlyArray<{ title: string; url: string }> {
    const byOrigin = new Map<string, { title: string; url: string; count: number }>();
    for (const e of this.store.get().entries) {
      let origin: string;
      try {
        origin = new URL(e.url).origin;
      } catch {
        continue;
      }
      const cur = byOrigin.get(origin);
      if (cur) cur.count += 1;
      else byOrigin.set(origin, { title: e.title, url: e.url, count: 1 });
    }
    return [...byOrigin.values()].sort((a, b) => b.count - a.count).slice(0, limit).map(({ title, url }) => ({ title, url }));
  }

  remove(id: string): void {
    this.store.update((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    this.bus.emit('history:changed', undefined);
  }

  clear(): void {
    this.store.set({ entries: [] });
    this.bus.emit('history:changed', undefined);
  }
}

/**
 * Session restore.
 *
 * Persists the set of open tabs (compartment + URL, in order) so a relaunch can
 * reopen exactly where the user left off. URLs that aren't real web pages (the
 * local start page, about:) are stored blank and reopen as the start page, so
 * nothing machine-specific is written.
 */
import { z } from 'zod';

import { JsonStore } from '../store';

export interface SessionTab {
  readonly compartmentId: string;
  readonly url: string;
  readonly pinned: boolean;
}

const sessionSchema = z.object({
  tabs: z.array(
    z.object({
      compartmentId: z.string(),
      url: z.string(),
      pinned: z.boolean().optional().default(false),
    }),
  ),
});

type SessionData = z.infer<typeof sessionSchema>;

export class SessionManager {
  private readonly store: JsonStore<SessionData>;

  constructor() {
    this.store = new JsonStore<SessionData>('session.json', sessionSchema, () => ({ tabs: [] }));
  }

  load(): readonly SessionTab[] {
    return this.store.get().tabs;
  }

  save(tabs: readonly SessionTab[]): void {
    this.store.set({ tabs: [...tabs] });
  }
}

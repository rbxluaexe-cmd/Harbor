/**
 * User settings independent of the active preset. The active preset name is
 * owned by the preset manager; everything here is plain user preference.
 */
import { z } from 'zod';

import { JsonStore } from './store';

const settingsSchema = z.object({
  homepage: z.string(),
  showLedgerPanel: z.boolean(),
  showBookmarksBar: z.boolean(),
  restoreSession: z.boolean(),
  theme: z.enum(['dark', 'light']),
  verticalTabs: z.boolean(),
});

export type StoredSettings = z.infer<typeof settingsSchema>;

export class SettingsStore {
  private readonly store: JsonStore<StoredSettings>;

  constructor() {
    this.store = new JsonStore<StoredSettings>('settings.json', settingsSchema, () => ({
      // Empty homepage means new tabs open Harbor's local start page.
      homepage: '',
      showLedgerPanel: true,
      showBookmarksBar: true,
      restoreSession: true,
      theme: 'dark',
      verticalTabs: false,
    }));
  }

  get(): StoredSettings {
    return this.store.get();
  }

  patch(patch: Partial<StoredSettings>): StoredSettings {
    return this.store.update((current) => ({ ...current, ...patch }));
  }
}

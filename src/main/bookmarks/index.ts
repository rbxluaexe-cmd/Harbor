/**
 * Bookmarks.
 *
 * A flat, persisted list of saved pages. Newest first. Adding a URL that is
 * already bookmarked is a no-op so the star toggle stays consistent.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Bookmark } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';

const bookmarkSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  addedAt: z.number(),
});

const storeSchema = z.object({ bookmarks: z.array(bookmarkSchema) });
type BookmarkStore = z.infer<typeof storeSchema>;

export class BookmarksManager {
  private readonly store: JsonStore<BookmarkStore>;

  constructor(private readonly bus: Bus) {
    this.store = new JsonStore<BookmarkStore>('bookmarks.json', storeSchema, () => ({ bookmarks: [] }));
  }

  list(): readonly Bookmark[] {
    return this.store.get().bookmarks;
  }

  has(url: string): boolean {
    return this.store.get().bookmarks.some((b) => b.url === url);
  }

  add(url: string, title: string): readonly Bookmark[] {
    const clean = url.trim();
    if (clean.length === 0 || this.has(clean)) {
      return this.list();
    }
    const bookmark: Bookmark = {
      id: randomUUID(),
      url: clean,
      title: title.trim() || clean,
      addedAt: Date.now(),
    };
    this.store.update((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
    this.emit();
    return this.list();
  }

  remove(id: string): readonly Bookmark[] {
    this.store.update((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
    this.emit();
    return this.list();
  }

  /** Toggle by URL — used by the address-bar star. */
  toggle(url: string, title: string): readonly Bookmark[] {
    const existing = this.store.get().bookmarks.find((b) => b.url === url.trim());
    return existing ? this.remove(existing.id) : this.add(url, title);
  }

  private emit(): void {
    this.bus.emit('bookmarks:changed', this.list());
  }
}

/**
 * Downloads.
 *
 * Hooks `will-download` on each compartment session and tracks every download's
 * progress and final state, exposing a newest-first list to the UI and
 * open / show-in-folder actions. Progress events fire rapidly, so change
 * notifications are throttled. Downloads are session-scoped like everything
 * else — a download started in one compartment is just a file on disk.
 */
import { randomUUID } from 'node:crypto';

import { shell, type DownloadItem as ElectronDownloadItem, type Session } from 'electron';

import type { DownloadItem, DownloadState } from '../../ipc';
import { Bus } from '../bus';

const EMIT_THROTTLE_MS = 350;

export class DownloadsManager {
  private readonly records = new Map<string, DownloadItem>();
  private lastEmit = 0;

  constructor(private readonly bus: Bus) {}

  /** Session configurator: start tracking downloads from this session. */
  readonly attach = (ses: Session): void => {
    ses.on('will-download', (_event, item) => this.track(item));
  };

  private track(item: ElectronDownloadItem): void {
    const id = randomUUID();
    this.records.set(id, this.snapshot(id, item));
    item.on('updated', () => {
      this.records.set(id, this.snapshot(id, item));
      this.emitThrottled();
    });
    item.once('done', () => {
      this.records.set(id, this.snapshot(id, item));
      this.emit();
    });
    this.emit();
  }

  private snapshot(id: string, item: ElectronDownloadItem): DownloadItem {
    return {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      state: item.getState() as DownloadState,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      savePath: item.getSavePath(),
      startedAt: item.getStartTime() > 0 ? Math.round(item.getStartTime() * 1000) : Date.now(),
    };
  }

  list(): readonly DownloadItem[] {
    return [...this.records.values()].reverse();
  }

  open(id: string): void {
    const r = this.records.get(id);
    if (r && r.state === 'completed' && r.savePath) {
      void shell.openPath(r.savePath);
    }
  }

  showInFolder(id: string): void {
    const r = this.records.get(id);
    if (r && r.savePath) {
      shell.showItemInFolder(r.savePath);
    }
  }

  /** Remove finished entries; in-progress downloads stay. */
  clear(): void {
    for (const [id, r] of this.records) {
      if (r.state !== 'progressing') {
        this.records.delete(id);
      }
    }
    this.emit();
  }

  private emitThrottled(): void {
    const now = Date.now();
    if (now - this.lastEmit >= EMIT_THROTTLE_MS) {
      this.emit();
    }
  }

  private emit(): void {
    this.lastEmit = Date.now();
    this.bus.emit('downloads:changed', this.list());
  }
}

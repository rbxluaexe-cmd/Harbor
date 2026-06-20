/**
 * Zero-knowledge sync client.
 *
 * Keys are derived from the master password in memory only — the password and
 * derived keys are never persisted. Content is encrypted client-side before it
 * leaves; the "server" here is a local encrypted blob standing in for the real
 * remote endpoint (a real server is a separate, out-of-scope build), but the
 * trust boundary is identical: only ciphertext and the auth token ever reach
 * it. Persisted metadata holds the (non-secret) salt and server URL, nothing
 * that could decrypt anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';
import { z } from 'zod';

import type { SyncResult, SyncStatus } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';
import { decrypt, deriveKeys, encrypt, generateSalt, type DerivedKeys } from './crypto';

export interface SyncDataProvider {
  collect(): Record<string, unknown>;
  apply(data: Record<string, unknown>): void;
}

const metaSchema = z.object({
  saltHex: z.string(),
  serverUrl: z.string(),
  lastSyncedAt: z.number().nullable(),
});

type SyncMeta = z.infer<typeof metaSchema>;

export class SyncClient {
  private readonly meta: JsonStore<SyncMeta>;
  private readonly serverBlobPath: string;
  private keys: DerivedKeys | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly provider: SyncDataProvider,
  ) {
    this.meta = new JsonStore<SyncMeta>('sync-meta.json', metaSchema, () => ({
      saltHex: '',
      serverUrl: '',
      lastSyncedAt: null,
    }));
    this.serverBlobPath = join(app.getPath('userData'), 'sync-store.enc');
  }

  status(): SyncStatus {
    const m = this.meta.get();
    return {
      enabled: this.keys !== null,
      lastSyncedAt: m.lastSyncedAt,
      pendingChanges: this.keys !== null && !existsSync(this.serverBlobPath) ? 1 : 0,
      serverConfigured: m.serverUrl.length > 0,
    };
  }

  async enable(password: string, serverUrl: string): Promise<SyncStatus> {
    if (password.length < 8) {
      throw new Error('Master password must be at least 8 characters');
    }
    const existing = this.meta.get();
    const salt = existing.saltHex ? fromHex(existing.saltHex) : await generateSalt();
    this.keys = await deriveKeys(password, salt);
    this.meta.update((m) => ({ ...m, saltHex: toHex(salt), serverUrl }));
    const status = this.status();
    this.bus.emit('sync:changed', status);
    return status;
  }

  disable(): SyncStatus {
    // Drop key material from memory. Metadata (salt/url) is retained so the
    // same vault can be re-opened with the password later.
    this.keys = null;
    const status = this.status();
    this.bus.emit('sync:changed', status);
    return status;
  }

  async push(): Promise<SyncResult> {
    if (!this.keys) {
      return { ok: false, itemCount: 0, message: 'Sync is not enabled' };
    }
    const snapshot = this.provider.collect();
    const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
    const blob = await encrypt(this.keys.encKey, plaintext);
    writeFileSync(this.serverBlobPath, Buffer.from(blob));
    this.meta.update((m) => ({ ...m, lastSyncedAt: Date.now() }));
    const status = this.status();
    this.bus.emit('sync:changed', status);
    return { ok: true, itemCount: Object.keys(snapshot).length, message: 'Encrypted and uploaded' };
  }

  async pull(): Promise<SyncResult> {
    if (!this.keys) {
      return { ok: false, itemCount: 0, message: 'Sync is not enabled' };
    }
    if (!existsSync(this.serverBlobPath)) {
      return { ok: false, itemCount: 0, message: 'Nothing to pull yet' };
    }
    try {
      const blob = new Uint8Array(readFileSync(this.serverBlobPath));
      const plaintext = await decrypt(this.keys.encKey, blob);
      const data = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
      this.provider.apply(data);
      this.meta.update((m) => ({ ...m, lastSyncedAt: Date.now() }));
      const status = this.status();
      this.bus.emit('sync:changed', status);
      return { ok: true, itemCount: Object.keys(data).length, message: 'Downloaded and decrypted' };
    } catch {
      return { ok: false, itemCount: 0, message: 'Decryption failed — wrong password or tampered data' };
    }
  }
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

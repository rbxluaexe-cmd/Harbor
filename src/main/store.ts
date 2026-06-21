/**
 * Minimal persistent JSON store. Each store is one file under the app's
 * userData directory. Reads are validated through a zod schema so a corrupt or
 * tampered file falls back to a known-good default rather than crashing or
 * silently loading garbage — important for a config that drives security
 * behaviour.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';
import type { ZodType, ZodTypeDef } from 'zod';

export class JsonStore<T> {
  private readonly filePath: string;
  private cache: T;

  constructor(
    fileName: string,
    private readonly schema: ZodType<T, ZodTypeDef, unknown>,
    private readonly fallback: () => T,
  ) {
    this.filePath = join(app.getPath('userData'), fileName);
    this.cache = this.load();
  }

  private load(): T {
    try {
      if (!existsSync(this.filePath)) {
        return this.fallback();
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const result = this.schema.safeParse(parsed);
      if (!result.success) {
        return this.fallback();
      }
      return result.data;
    } catch {
      return this.fallback();
    }
  }

  get(): T {
    return this.cache;
  }

  set(value: T): void {
    this.cache = value;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(value, null, 2), 'utf-8');
  }

  update(mutator: (current: T) => T): T {
    const next = mutator(this.cache);
    this.set(next);
    return next;
  }
}

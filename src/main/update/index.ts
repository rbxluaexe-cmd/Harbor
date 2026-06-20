/**
 * Signed update checks.
 *
 * Closes the "trust us" gap: a release is only acted on if its manifest carries
 * a valid Ed25519 signature from the pinned project key (verified with
 * libsodium), so "this binary matches the public source" is independently
 * checkable rather than asserted. Network fetching of the manifest is a later
 * phase; this verifies whatever manifest is present and never trusts an
 * unsigned or wrongly-signed one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';
import _sodium from 'libsodium-wrappers';
import { z } from 'zod';

import type { UpdateStatus } from '../../ipc';

// Pinned release-signing public key (Ed25519, hex). Replace with the real key
// at release time; a placeholder verifies nothing, so updates stay un-trusted.
const PINNED_PUBKEY_HEX = '0000000000000000000000000000000000000000000000000000000000000000';

const manifestSchema = z.object({
  version: z.string(),
  sha256: z.string(),
  url: z.string(),
});

export class UpdateChecker {
  private readonly manifestPath: string;
  private readonly signaturePath: string;

  constructor() {
    const dir = join(app.getPath('userData'), 'update');
    this.manifestPath = join(dir, 'manifest.json');
    this.signaturePath = join(dir, 'manifest.sig');
  }

  async check(): Promise<UpdateStatus> {
    const currentVersion = app.getVersion();
    const base: UpdateStatus = {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      signatureVerified: false,
      checkedAt: Date.now(),
      message: 'No release manifest available yet',
    };

    if (!existsSync(this.manifestPath) || !existsSync(this.signaturePath)) {
      return base;
    }

    const manifestBytes = new Uint8Array(readFileSync(this.manifestPath));
    const signature = new Uint8Array(readFileSync(this.signaturePath));
    const verified = await verifySignature(manifestBytes, signature);

    if (!verified) {
      return {
        ...base,
        signatureVerified: false,
        message: 'Release manifest signature is INVALID — refusing to trust it',
      };
    }

    const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    if (!parsed.success) {
      return { ...base, signatureVerified: true, message: 'Signed manifest is malformed' };
    }

    const latestVersion = parsed.data.version;
    const updateAvailable = isNewer(latestVersion, currentVersion);
    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      signatureVerified: true,
      checkedAt: Date.now(),
      message: updateAvailable
        ? `Verified update ${latestVersion} available`
        : 'You are on the latest verified release',
    };
  }
}

async function verifySignature(message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    await _sodium.ready;
    const pubkey = _sodium.from_hex(PINNED_PUBKEY_HEX);
    return _sodium.crypto_sign_verify_detached(signature, message, pubkey);
  } catch {
    return false;
  }
}

/** Simple semver-ish comparison: returns true when `candidate` > `current`. */
function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return false;
}

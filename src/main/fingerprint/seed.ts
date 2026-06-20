/**
 * Per-compartment, per-session noise seed.
 *
 * The same compartment yields the same seed for the lifetime of a session, so
 * spoofed values stay consistent across reads — a fingerprint that changes
 * between two reads on the same page is itself a distinguishing signal. A fresh
 * random nonce each session means the seed differs run-to-run, so the spoof is
 * not itself a stable cross-session identifier.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Generated once per app session. */
export function newSessionNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Deterministic 32-bit unsigned seed from (sessionNonce, compartmentId). */
export function deriveSeed(sessionNonce: string, compartmentId: string): number {
  const digest = createHash('sha256').update(`${sessionNonce}:${compartmentId}`).digest();
  // First 4 bytes as an unsigned 32-bit integer.
  return digest.readUInt32BE(0);
}

/**
 * Secure DNS / private routing.
 *
 * Chromium exposes secure DNS through command-line switches whose names have
 * drifted across versions — these MUST be confirmed against the exact
 * Electron/Chromium build before shipping rather than trusted from memory. They
 * are applied before `app.ready`, which is why this runs at the very top of
 * startup.
 *
 * True Oblivious DoH (RFC 9230) has no built-in support in any mainstream
 * engine. It is scoped as its own phase: a standalone relay client wired in
 * through `session.setProxy`, not a config flip. `applyOdohProxy` is the
 * integration seam for that future client and currently routes through the
 * system path until the relay client lands.
 */
import type { CommandLine, Session } from 'electron';

import type { DnsMode } from '../../ipc';

// Cloudflare's canonical DoH endpoint — a provider Chromium recognises, so it
// can bootstrap without a classic-DNS lookup of the resolver host. Verify
// availability/policy before shipping.
const DOH_TEMPLATE = 'https://cloudflare-dns.com/dns-query';

/**
 * Apply secure-DNS command-line switches. Call before the app `ready` event.
 * NOTE: switch names are Chromium-version-sensitive — confirm against the
 * bundled Chromium of the Electron version in package.json.
 */
export function configureSecureDns(commandLine: CommandLine, mode: DnsMode): void {
  if (mode === 'system') {
    return;
  }
  // `secure` enforces DoH; `automatic` upgrades opportunistically. We choose
  // `secure` so a failure is visible rather than silently downgrading.
  commandLine.appendSwitch('dns-over-https-mode', 'secure');
  commandLine.appendSwitch('dns-over-https-templates', DOH_TEMPLATE);
}

/**
 * Integration seam for an Oblivious DoH relay client. Until that standalone
 * client exists, ODoH mode falls back to direct routing (no proxy), so the
 * feature degrades safely instead of pretending to provide a guarantee it does
 * not yet have.
 */
export async function applyOdohProxy(session: Session, mode: DnsMode): Promise<void> {
  if (mode !== 'odoh-relay') {
    // Leave the session on its default (system) proxy resolution; don't force
    // 'direct', which would bypass a user's configured proxy.
    return;
  }
  // TODO(odoh): point this at the local ODoH relay client's listening proxy
  // once that phase is built. Routing through two non-colluding relays splits
  // the client IP from the query and is not expressible as a single switch.
  await session.setProxy({ mode: 'system' });
}

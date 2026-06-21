/**
 * Security hardening.
 *
 * A persisted set of toggles applied at the network layer to reduce what sites
 * learn about the user and to harden requests:
 *   - Global Privacy Control (Sec-GPC) and Do-Not-Track (DNT) signals
 *   - Referrer trimmed to origin (or kept)
 *   - X-Client-Data (Chrome's identifying header) removed
 *   - User-Agent spoofing
 *   - Third-party cookie blocking (Cookie / Set-Cookie stripped cross-site)
 *
 * Request-level rewrites (HTTPS upgrade, tracking-param stripping, hyperlink
 * auditing) live in the network guard, which owns `onBeforeRequest`; this guard
 * owns the header hooks (`onBeforeSendHeaders` / `onHeadersReceived`), which the
 * network guard does not use, so they never collide.
 */
import type { Session } from 'electron';
import { z } from 'zod';

import type { SecurityConfig } from '../../ipc';
import { Bus } from '../bus';
import { JsonStore } from '../store';
import { hostnameOf, isSameSite } from '../network/domain';

export const SECURITY_DEFAULTS: SecurityConfig = {
  gpc: true,
  dnt: true,
  trimReferrer: true,
  removeClientHints: true,
  httpsUpgrade: false,
  stripTrackingParams: true,
  blockHyperlinkAuditing: true,
  blockThirdPartyCookies: true,
  spoofUserAgent: false,
  userAgent: '',
};

const schema = z.object({
  gpc: z.boolean(),
  dnt: z.boolean(),
  trimReferrer: z.boolean(),
  removeClientHints: z.boolean(),
  httpsUpgrade: z.boolean(),
  stripTrackingParams: z.boolean(),
  blockHyperlinkAuditing: z.boolean(),
  blockThirdPartyCookies: z.boolean(),
  spoofUserAgent: z.boolean(),
  userAgent: z.string(),
});

/** Tracking query parameters stripped from URLs when enabled. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'mc_eid', 'igshid', 'yclid',
  '_hsenc', '_hsmi', 'vero_id', 'oly_anon_id', 'wickedid', 'twclid', 'ref_src',
]);

/** Return a tracking-param-free URL, or null if nothing was stripped. */
export function stripTrackingParams(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Upgrade an http:// URL to https://, or null if not applicable. */
export function upgradeHttps(rawUrl: string): string | null {
  if (!/^http:\/\//i.test(rawUrl)) return null;
  // Don't upgrade loopback/local addresses, which often have no TLS.
  if (/^http:\/\/(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/i.test(rawUrl)) return null;
  return rawUrl.replace(/^http:/i, 'https:');
}

export class SecurityStore {
  private readonly store: JsonStore<SecurityConfig>;

  constructor(private readonly bus: Bus) {
    this.store = new JsonStore<SecurityConfig>('security.json', schema, () => SECURITY_DEFAULTS);
  }

  get(): SecurityConfig {
    return this.store.get();
  }

  patch(patch: Partial<SecurityConfig>): SecurityConfig {
    const next = this.store.update((c) => ({ ...c, ...patch }));
    this.bus.emit('security:changed', next);
    return next;
  }
}

export class SecurityGuard {
  constructor(
    private readonly config: () => SecurityConfig,
    private readonly getTabUrl: (webContentsId: number) => string | null,
  ) {}

  /** Session configurator: install the header hooks. */
  readonly configureSession = (ses: Session): void => {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const cfg = this.config();
      const headers = { ...details.requestHeaders };
      if (cfg.gpc) headers['Sec-GPC'] = '1';
      if (cfg.dnt) headers['DNT'] = '1';
      if (cfg.removeClientHints) {
        delete headers['X-Client-Data'];
        delete headers['x-client-data'];
      }
      if (cfg.spoofUserAgent && cfg.userAgent.trim().length > 0) {
        headers['User-Agent'] = cfg.userAgent.trim();
      }
      if (cfg.trimReferrer && (headers['Referer'] ?? headers['referer'])) {
        const ref = headers['Referer'] ?? headers['referer'] ?? '';
        try {
          const origin = new URL(ref).origin + '/';
          if (headers['Referer'] !== undefined) headers['Referer'] = origin;
          if (headers['referer'] !== undefined) headers['referer'] = origin;
        } catch {
          // leave as-is on parse failure
        }
      }
      if (cfg.blockThirdPartyCookies && this.isThirdParty(details.url, details.webContentsId)) {
        delete headers['Cookie'];
        delete headers['cookie'];
      }
      callback({ requestHeaders: headers });
    });

    ses.webRequest.onHeadersReceived((details, callback) => {
      const cfg = this.config();
      if (cfg.blockThirdPartyCookies && details.responseHeaders && this.isThirdParty(details.url, details.webContentsId)) {
        const headers = { ...details.responseHeaders };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'set-cookie') delete headers[key];
        }
        callback({ responseHeaders: headers });
        return;
      }
      callback({});
    });
  };

  private isThirdParty(url: string, webContentsId?: number): boolean {
    if (webContentsId === undefined) return false;
    const top = this.getTabUrl(webContentsId);
    const topHost = top ? hostnameOf(top) : null;
    const reqHost = hostnameOf(url);
    if (!topHost || !reqHost) return false;
    return !isSameSite(reqHost, topHost);
  }
}

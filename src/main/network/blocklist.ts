/**
 * Tracker blocklist matching.
 *
 * A production build would load and parse EasyList/EasyPrivacy; this ships a
 * representative seed set and the matching machinery around it. Matching walks
 * up the domain hierarchy so `pixel.ads.example.com` is caught by an
 * `example.com` rule. A small allowlist of common CDNs is kept separate so the
 * ledger can label them honestly rather than flagging every third party.
 */

/** Known tracker / advertising domains (seed set; extend by loading EasyList). */
const TRACKER_DOMAINS: ReadonlySet<string> = new Set([
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'quantserve.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'casalemedia.com',
  'moatads.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'facebook.net',
  'connect.facebook.net',
  'hotjar.com',
  'mixpanel.com',
  'segment.com',
  'segment.io',
  'fullstory.com',
  'mouseflow.com',
  'branch.io',
  'bugsnag.com',
  'sentry.io',
  'newrelic.com',
  'nr-data.net',
]);

/** Common first-party-friendly CDNs we allow but label transparently. */
const ALLOWED_CDNS: ReadonlySet<string> = new Set([
  'cloudflare.com',
  'cloudfront.net',
  'akamaihd.net',
  'akamai.net',
  'fastly.net',
  'jsdelivr.net',
  'unpkg.com',
  'gstatic.com',
  'cdnjs.cloudflare.com',
]);

function walkDomains(domain: string): string[] {
  const labels = domain.split('.').filter(Boolean);
  const candidates: string[] = [];
  for (let i = 0; i < labels.length - 1; i += 1) {
    candidates.push(labels.slice(i).join('.'));
  }
  return candidates;
}

function matches(domain: string, set: ReadonlySet<string>): boolean {
  const normalized = domain.toLowerCase();
  if (set.has(normalized)) {
    return true;
  }
  return walkDomains(normalized).some((candidate) => set.has(candidate));
}

export class Blocklist {
  private readonly extraTrackers = new Set<string>();

  /** Add domains at runtime (e.g. parsed from a loaded list). */
  addTrackers(domains: Iterable<string>): void {
    for (const d of domains) {
      this.extraTrackers.add(d.toLowerCase());
    }
  }

  isTracker(domain: string): boolean {
    return matches(domain, TRACKER_DOMAINS) || matches(domain, this.extraTrackers);
  }

  isAllowedCdn(domain: string): boolean {
    return matches(domain, ALLOWED_CDNS);
  }
}

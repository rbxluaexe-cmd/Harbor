/**
 * CNAME uncloaking.
 *
 * Trackers increasingly hide behind a first-party subdomain whose CNAME record
 * points at the tracker's real infrastructure, specifically to defeat blocklists
 * that only match the declared hostname. Before allowing a request to an
 * unfamiliar domain we resolve its CNAME chain and check the canonical name too.
 *
 * Resolution is cached and time-bounded: a DNS lookup sits in the request hot
 * path, so we fail open (treat as no-CNAME) on timeout rather than stall page
 * loads, while still recording what we found for the ledger.
 */
import { promises as dns } from 'node:dns';

interface CacheEntry {
  canonical: string | null;
  expires: number;
}

const TTL_MS = 5 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 400;

export class CnameResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string | null>>();

  /**
   * Resolve the canonical (final) name a domain's CNAME chain points to.
   * Returns null when the domain has no CNAME, the lookup fails, or it times
   * out. The returned name differs from the input only when cloaking is present.
   */
  async resolveCanonical(domain: string): Promise<string | null> {
    const key = domain.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.canonical;
    }
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const lookup = this.doLookup(key)
      .then((canonical) => {
        this.cache.set(key, { canonical, expires: Date.now() + TTL_MS });
        return canonical;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, lookup);
    return lookup;
  }

  private async doLookup(domain: string): Promise<string | null> {
    try {
      const records = await withTimeout(dns.resolveCname(domain), LOOKUP_TIMEOUT_MS);
      const canonical = records.find((r) => r.toLowerCase() !== domain);
      return canonical ? canonical.toLowerCase() : null;
    } catch {
      return null;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

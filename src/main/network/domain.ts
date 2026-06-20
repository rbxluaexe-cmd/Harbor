/**
 * Domain helpers.
 *
 * `registrableDomain` approximates the eTLD+1 with a small multi-label suffix
 * table. A production build should swap this for the full Public Suffix List;
 * the heuristic is documented as such so its limits are visible. It only needs
 * to be good enough to classify first-party vs third-party for the ledger.
 */

/** Two-level public suffixes where eTLD+1 needs three labels (e.g. example.co.uk). */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.tw',
]);

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) {
    return labels.join('.');
  }
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export function isSameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

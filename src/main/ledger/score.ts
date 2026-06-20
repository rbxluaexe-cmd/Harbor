/**
 * Runtime privacy scoring.
 *
 * The score is computed from what a page actually did at runtime — the requests
 * it made, the trackers it reached for, the fingerprinting surfaces it touched —
 * not from a static reputation list. That is what makes it verifiable: it
 * reflects observed behaviour rather than someone else's opinion of a domain.
 */
import type { LedgerEntry, PrivacyScore } from '../../ipc';

export function computeScore(entries: readonly LedgerEntry[]): PrivacyScore {
  const thirdPartyDomains = new Set<string>();
  let blockedRequests = 0;
  let trackersBlocked = 0;
  let cnameUncloaked = 0;
  let fingerprintAttempts = 0;
  let clipboardReads = 0;

  for (const entry of entries) {
    if (entry.disposition !== 'allowed') {
      blockedRequests += 1;
    }
    switch (entry.reason) {
      case 'third-party':
      case 'allowed-cdn':
        thirdPartyDomains.add(entry.domain);
        break;
      case 'tracker-blocklist':
        trackersBlocked += 1;
        thirdPartyDomains.add(entry.domain);
        break;
      case 'cname-uncloaked':
        cnameUncloaked += 1;
        thirdPartyDomains.add(entry.canonicalDomain ?? entry.domain);
        break;
      case 'fingerprinting-api':
        fingerprintAttempts += 1;
        break;
      case 'clipboard-read':
        clipboardReads += 1;
        break;
      case 'first-party':
      default:
        break;
    }
  }

  const penalty =
    thirdPartyDomains.size * 4 +
    trackersBlocked * 3 +
    cnameUncloaked * 6 +
    fingerprintAttempts * 8 +
    clipboardReads * 12;

  const value = clamp(100 - penalty, 0, 100);

  return {
    value,
    grade: gradeFor(value),
    totalRequests: entries.length,
    blockedRequests,
    thirdParties: thirdPartyDomains.size,
    trackersBlocked,
    cnameUncloaked,
    fingerprintAttempts,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gradeFor(value: number): PrivacyScore['grade'] {
  if (value >= 90) return 'A';
  if (value >= 75) return 'B';
  if (value >= 55) return 'C';
  if (value >= 35) return 'D';
  return 'F';
}

/**
 * Network guard.
 *
 * Installs per-session `webRequest` interception that makes the allow/block
 * decision for every subresource, performs CNAME uncloaking for unfamiliar
 * third parties, denies sensitive permission requests (and surfaces clipboard
 * reads), and applies the WebRTC IP-handling policy per content view.
 *
 * It announces every decision as a `network:observation` on the bus and never
 * references any other feature module — the ledger consumes observations
 * without this module knowing the ledger exists.
 */
import type {
  OnBeforeRequestListenerDetails,
  Session,
  WebContents,
} from 'electron';

import type { PresetConfig, RequestDisposition, RequestReason } from '../../ipc';
import { Bus } from '../bus';
import type { RawObservation } from '../internal-types';
import { Blocklist } from './blocklist';
import { CnameResolver } from './cname';
import { hostnameOf, isSameSite } from './domain';
import { applyOdohProxy } from './secure-dns';
import { applyWebRtcPolicy } from './webrtc';

import type { SecurityConfig } from '../../ipc';
import { stripTrackingParams, upgradeHttps } from '../security';

export type ConfigGetter = () => PresetConfig;
export type TabUrlResolver = (webContentsId: number) => string | null;
export type PermissionDecider = (origin: string, permission: string) => boolean;
export type SecurityGetter = () => SecurityConfig;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export class NetworkGuard {
  private readonly blocklist = new Blocklist();
  private readonly cname = new CnameResolver();

  constructor(
    private readonly bus: Bus,
    private readonly config: ConfigGetter,
    private readonly getTabUrl: TabUrlResolver,
    private readonly decidePermission: PermissionDecider,
    private readonly security: SecurityGetter,
  ) {}

  /** Configurator handed to the identity module; runs once per session. */
  readonly configureSession = (ses: Session): void => {
    ses.webRequest.onBeforeRequest((details, callback) => {
      void this.handleBeforeRequest(details, callback);
    });
    // onCompleted is the seam for future latency/byte-size metrics; the
    // allow/block decision and ledger record happen at onBeforeRequest time.
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      this.handlePermission(wc, permission, callback, details);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
      this.decidePermission(requestingOrigin, permission),
    );
    void applyOdohProxy(ses, this.config().dnsMode);
  };

  /** Apply the active WebRTC policy to a content view. */
  applyWebRtc(webContents: WebContents): void {
    applyWebRtcPolicy(webContents, this.config().webRtcPolicy);
  }

  private async handleBeforeRequest(
    details: OnBeforeRequestListenerDetails,
    callback: (response: { cancel?: boolean; redirectURL?: string }) => void,
  ): Promise<void> {
    const domain = hostnameOf(details.url);
    if (!domain) {
      callback({ cancel: false });
      return;
    }
    const tabId = details.webContentsId ?? -1;

    // Request-level security rewrites (this hook is the single owner of
    // onBeforeRequest, so security rewrites live here).
    const sec = this.security();
    if (sec.blockHyperlinkAuditing && details.resourceType === 'ping') {
      this.record(tabId, details, domain, null, 'blocked', 'tracker-blocklist');
      callback({ cancel: true });
      return;
    }
    if (sec.httpsUpgrade) {
      const upgraded = upgradeHttps(details.url);
      if (upgraded) {
        callback({ redirectURL: upgraded });
        return;
      }
    }
    if (sec.stripTrackingParams) {
      const cleaned = stripTrackingParams(details.url);
      if (cleaned) {
        callback({ redirectURL: cleaned });
        return;
      }
    }

    if (details.resourceType === 'mainFrame') {
      this.record(tabId, details, domain, null, 'allowed', 'first-party');
      callback({ cancel: false });
      return;
    }

    const topUrl = tabId >= 0 ? this.getTabUrl(tabId) : null;
    const topHost = topUrl ? hostnameOf(topUrl) : null;
    if (topHost && isSameSite(domain, topHost)) {
      this.record(tabId, details, domain, null, 'allowed', 'first-party');
      callback({ cancel: false });
      return;
    }

    if (this.blocklist.isTracker(domain)) {
      this.record(tabId, details, domain, null, 'blocked', 'tracker-blocklist');
      callback({ cancel: true });
      return;
    }

    if (this.config().cnameUncloaking) {
      const canonical = await this.cname.resolveCanonical(domain);
      if (canonical && this.blocklist.isTracker(canonical)) {
        this.record(tabId, details, domain, canonical, 'blocked', 'cname-uncloaked');
        callback({ cancel: true });
        return;
      }
      const reason: RequestReason = this.blocklist.isAllowedCdn(domain) ? 'allowed-cdn' : 'third-party';
      this.record(tabId, details, domain, canonical, 'allowed', reason);
      callback({ cancel: false });
      return;
    }

    const reason: RequestReason = this.blocklist.isAllowedCdn(domain) ? 'allowed-cdn' : 'third-party';
    this.record(tabId, details, domain, null, 'allowed', reason);
    callback({ cancel: false });
  }

  private handlePermission(
    webContents: WebContents,
    permission: string,
    callback: (granted: boolean) => void,
    _details: unknown,
  ): void {
    const url = webContents.getURL();
    const origin = originOf(url);
    const granted = this.decidePermission(origin, permission);
    if (permission === 'clipboard-read' && !granted) {
      const domain = hostnameOf(url) ?? 'unknown';
      this.emit({
        tabId: webContents.id,
        url,
        domain,
        canonicalDomain: null,
        resourceType: 'permission',
        initiator: domain,
        disposition: 'blocked',
        reason: 'clipboard-read',
        timestamp: Date.now(),
      });
    }
    this.bus.emit('permission:requested', { origin, permission, granted });
    callback(granted);
  }

  private record(
    tabId: number,
    details: OnBeforeRequestListenerDetails,
    domain: string,
    canonicalDomain: string | null,
    disposition: RequestDisposition,
    reason: RequestReason,
  ): void {
    this.emit({
      tabId,
      url: details.url,
      domain,
      canonicalDomain,
      resourceType: details.resourceType,
      initiator: details.referrer ? hostnameOf(details.referrer) : null,
      disposition,
      reason,
      timestamp: Date.now(),
    });
  }

  private emit(observation: RawObservation): void {
    if (observation.tabId < 0) {
      return;
    }
    this.bus.emit('network:observation', observation);
  }
}

/** Exposed so a future list-loader can inject parsed EasyList rules. */
export { Blocklist };

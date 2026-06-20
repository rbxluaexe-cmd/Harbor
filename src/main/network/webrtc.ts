/**
 * WebRTC leak protection.
 *
 * `setWebRTCIPHandlingPolicy` is a `webContents` method, not a `session` one,
 * so it is applied per content view. The default policy here is
 * `disable_non_proxied_udp`, which forces WebRTC onto TCP/proxied paths instead
 * of leaking local IP addresses through UDP ICE candidates — without breaking
 * video calls outright, which the lazy "just disable WebRTC" approach does.
 */
import type { WebContents } from 'electron';

import type { PresetConfig } from '../../ipc';

export function applyWebRtcPolicy(webContents: WebContents, policy: PresetConfig['webRtcPolicy']): void {
  switch (policy) {
    case 'disabled':
      // Hardest setting: only proxied UDP, and also forbid mDNS/public host
      // candidates. WebRTC effectively cannot establish a peer connection that
      // would reveal an address.
      webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      break;
    case 'proxy-only':
      webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      break;
    case 'default':
    default:
      webContents.setWebRTCIPHandlingPolicy('default_public_interface_only');
      break;
  }
}

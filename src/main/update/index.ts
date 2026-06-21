/**
 * GitHub-backed update checks with hash verification.
 *
 * Polls the public GitHub Releases API for the latest release, compares it to
 * the running version, and reads the published SHA-256 from the release's
 * `checksums.txt` asset. Downloading then re-computes the SHA-256 of the bytes
 * and refuses anything that doesn't match the published hash — so a tampered or
 * corrupted download is rejected rather than run. Installation stays manual
 * (the verified installer is revealed to the user); Harbor never silently runs
 * a downloaded binary.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, shell } from 'electron';

import type { UpdateDownloadResult, UpdateStatus } from '../../ipc';

const REPO = 'rbxluaexe-cmd/Harbor';
const UA = 'Harbor-Updater';

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

export class UpdateChecker {
  private lastStatus: UpdateStatus | null = null;

  async check(): Promise<UpdateStatus> {
    const currentVersion = app.getVersion();
    const base: UpdateStatus = {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      signatureVerified: false,
      downloadUrl: null,
      expectedSha256: null,
      checkedAt: Date.now(),
      message: '',
    };
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        return { ...base, message: res.status === 404 ? 'No releases published yet' : `Update check failed (HTTP ${res.status})` };
      }
      const data = (await res.json()) as { tag_name?: string; assets?: GithubAsset[] };
      const latestVersion = String(data.tag_name ?? '').replace(/^v/i, '');
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const installer = assets.find((a) => /\.exe$/i.test(a.name));
      const checksums = assets.find((a) => /checksums?\.txt$/i.test(a.name));

      let expectedSha256: string | null = null;
      if (checksums && installer) {
        const cres = await fetch(checksums.browser_download_url, { headers: { 'User-Agent': UA } });
        if (cres.ok) {
          expectedSha256 = parseChecksum(await cres.text(), installer.name);
        }
      }

      const updateAvailable = latestVersion.length > 0 && isNewer(latestVersion, currentVersion);
      const status: UpdateStatus = {
        currentVersion,
        latestVersion: latestVersion || null,
        updateAvailable,
        signatureVerified: expectedSha256 !== null,
        downloadUrl: installer?.browser_download_url ?? null,
        expectedSha256,
        checkedAt: Date.now(),
        message: updateAvailable
          ? expectedSha256
            ? `Verified update ${latestVersion} available`
            : `Update ${latestVersion} available (no checksum published — download unverified)`
          : 'You are on the latest release',
      };
      this.lastStatus = status;
      return status;
    } catch {
      return { ...base, message: 'Update check failed — offline or network blocked' };
    }
  }

  /** Download the latest installer and verify its SHA-256 before revealing it. */
  async download(): Promise<UpdateDownloadResult> {
    const status = this.lastStatus;
    if (!status?.downloadUrl) {
      return { ok: false, path: '', message: 'Run a check first.' };
    }
    try {
      const res = await fetch(status.downloadUrl, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        return { ok: false, path: '', message: `Download failed (HTTP ${res.status})` };
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (status.expectedSha256 && actual.toLowerCase() !== status.expectedSha256.toLowerCase()) {
        return { ok: false, path: '', message: 'SHA-256 mismatch — download rejected as tampered.' };
      }
      const dest = join(app.getPath('temp'), `Harbor-Setup-${status.latestVersion ?? 'latest'}.exe`);
      writeFileSync(dest, bytes);
      shell.showItemInFolder(dest);
      return {
        ok: true,
        path: dest,
        message: status.expectedSha256
          ? `Downloaded and SHA-256 verified. Saved to ${dest}`
          : `Downloaded (unverified — no published checksum). Saved to ${dest}`,
      };
    } catch {
      return { ok: false, path: '', message: 'Download failed — offline or network blocked' };
    }
  }
}

/** Extract the 64-hex SHA-256 for a filename from a checksums.txt body. */
function parseChecksum(text: string, filename: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(filename)) {
      const match = line.match(/\b[a-fA-F0-9]{64}\b/);
      if (match) return match[0];
    }
  }
  return null;
}

/** Returns true when `candidate` is a newer version than `current`. */
function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

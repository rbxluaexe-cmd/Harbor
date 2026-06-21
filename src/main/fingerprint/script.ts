/**
 * Builds the script injected into a page's main world (via CDP
 * `Page.addScriptToEvaluateOnNewDocument`) before any page script runs.
 *
 * The noise is bounded and seed-derived, so values stay plausible and stable
 * for the session rather than swinging to maximally-random extremes — a wild
 * value is as distinguishing as a real one. Each patched API reports its first
 * use through the `__harborReport` CDP binding so the ledger can show it.
 */
import type { FingerprintMode } from '../../ipc';

// Plausible (vendor, renderer) pairs to rotate between, chosen from the seed.
const GPU_PROFILES: ReadonlyArray<readonly [string, string]> = [
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60), OpenGL 4.1)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, Apple M2, OpenGL 4.1)'],
];

const CORE_CHOICES = [4, 8, 12, 16];
const MEMORY_CHOICES = [4, 8];
const PLATFORMS = ['Win32', 'MacIntel', 'Linux x86_64'];
const LANGUAGE_SETS: ReadonlyArray<readonly string[]> = [['en-US', 'en'], ['en-GB', 'en']];
const SCREENS: ReadonlyArray<readonly [number, number]> = [[1920, 1080], [1536, 864], [1366, 768], [2560, 1440]];
// (IANA zone, getTimezoneOffset minutes) pairs that agree with each other.
const TIMEZONES: ReadonlyArray<readonly [string, number]> = [
  ['UTC', 0],
  ['Europe/London', 0],
  ['Europe/Berlin', -60],
  ['America/New_York', 300],
  ['America/Los_Angeles', 480],
];

interface SpoofValues {
  cores: number;
  memory: number;
  vendor: string;
  renderer: string;
  noiseAmplitude: number;
  platform: string;
  languages: readonly string[];
  screenW: number;
  screenH: number;
  timezone: string;
  tzOffset: number;
}

function deriveSpoof(seed: number, mode: FingerprintMode): SpoofValues {
  const profile = GPU_PROFILES[(seed >>> 3) % GPU_PROFILES.length] ?? GPU_PROFILES[0]!;
  const screen = SCREENS[(seed >>> 5) % SCREENS.length] ?? SCREENS[0]!;
  const tz = TIMEZONES[(seed >>> 7) % TIMEZONES.length] ?? TIMEZONES[0]!;
  return {
    cores: CORE_CHOICES[seed % CORE_CHOICES.length] ?? 8,
    memory: MEMORY_CHOICES[(seed >>> 2) % MEMORY_CHOICES.length] ?? 8,
    vendor: profile[0],
    renderer: profile[1],
    noiseAmplitude: mode === 'strict' ? 3 : 1,
    platform: PLATFORMS[(seed >>> 4) % PLATFORMS.length] ?? 'Win32',
    languages: LANGUAGE_SETS[(seed >>> 6) % LANGUAGE_SETS.length] ?? LANGUAGE_SETS[0]!,
    screenW: screen[0],
    screenH: screen[1],
    timezone: tz[0],
    tzOffset: tz[1],
  };
}

export function buildInjectionScript(seed: number, mode: FingerprintMode): string {
  const spoof = deriveSpoof(seed, mode);
  const spoofNavigator = mode === 'strict';

  // The body runs in the page's main world. Keep it self-contained and guarded.
  return `(() => {
  try {
    const SEED = ${seed} >>> 0;
    const AMP = ${spoof.noiseAmplitude};
    let s = SEED || 1;
    const rand = () => {
      // mulberry32 — deterministic per session, so reads are self-consistent.
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const reported = Object.create(null);
    const report = (api) => {
      if (reported[api]) return;
      reported[api] = true;
      try { if (typeof window.__harborReport === 'function') window.__harborReport(api); } catch (e) {}
    };

    const perturb = (data) => {
      for (let i = 0; i < data.length; i += 4) {
        if (rand() < 0.05) {
          const d = ((rand() * (2 * AMP + 1)) | 0) - AMP;
          data[i] = Math.min(255, Math.max(0, data[i] + d));
        }
      }
    };

    // --- Canvas readback ---
    const CtxProto = (typeof CanvasRenderingContext2D !== 'undefined') && CanvasRenderingContext2D.prototype;
    if (CtxProto && CtxProto.getImageData) {
      const orig = CtxProto.getImageData;
      CtxProto.getImageData = function (x, y, w, h) {
        report('canvas');
        const img = orig.call(this, x, y, w, h);
        try { perturb(img.data); } catch (e) {}
        return img;
      };
    }
    if (typeof HTMLCanvasElement !== 'undefined') {
      const perturbCanvas = (canvas) => {
        try {
          const ctx = canvas.getContext && canvas.getContext('2d');
          if (!ctx) return;
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          perturb(img.data);
          ctx.putImageData(img, 0, 0);
        } catch (e) {}
      };
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function () {
        report('canvas');
        perturbCanvas(this);
        return origToDataURL.apply(this, arguments);
      };
      if (HTMLCanvasElement.prototype.toBlob) {
        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function () {
          report('canvas');
          perturbCanvas(this);
          return origToBlob.apply(this, arguments);
        };
      }
    }

    // --- Audio readback ---
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
      const origGCD = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function () {
        report('audio');
        const out = origGCD.apply(this, arguments);
        try {
          for (let i = 0; i < out.length; i += 100) {
            out[i] = out[i] + (rand() - 0.5) * 1e-7;
          }
        } catch (e) {}
        return out;
      };
    }

    // --- WebGL parameter reads ---
    const patchGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
        if (p === 37445) { report('webgl'); return ${JSON.stringify(spoof.vendor)}; }
        if (p === 37446) { report('webgl'); return ${JSON.stringify(spoof.renderer)}; }
        return orig.call(this, p);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);

    // --- navigator hints ---
    const define = (obj, name, value) => {
      try { Object.defineProperty(obj, name, { get() { report('navigator'); return value; }, configurable: true }); } catch (e) {}
    };
    ${spoofNavigator
      ? `define(Navigator.prototype, 'hardwareConcurrency', ${spoof.cores});
         define(Navigator.prototype, 'deviceMemory', ${spoof.memory});
         define(Navigator.prototype, 'platform', ${JSON.stringify(spoof.platform)});
         define(Navigator.prototype, 'languages', Object.freeze(${JSON.stringify(spoof.languages)}));
         define(Navigator.prototype, 'language', ${JSON.stringify(spoof.languages[0] ?? 'en-US')});
         define(Navigator.prototype, 'plugins', Object.freeze([]));
         define(Navigator.prototype, 'mimeTypes', Object.freeze([]));
         try { Object.defineProperty(Navigator.prototype, 'getBattery', { value: undefined, configurable: true }); } catch (e) {}
         try {
           const scr = ${JSON.stringify([spoof.screenW, spoof.screenH])};
           Object.defineProperty(screen, 'width', { get() { report('navigator'); return scr[0]; }, configurable: true });
           Object.defineProperty(screen, 'height', { get() { return scr[1]; }, configurable: true });
           Object.defineProperty(screen, 'availWidth', { get() { return scr[0]; }, configurable: true });
           Object.defineProperty(screen, 'availHeight', { get() { return scr[1] - 40; }, configurable: true });
           Object.defineProperty(screen, 'colorDepth', { get() { return 24; }, configurable: true });
           Object.defineProperty(screen, 'pixelDepth', { get() { return 24; }, configurable: true });
         } catch (e) {}
         try {
           const TZ = ${JSON.stringify(spoof.timezone)};
           const RO = Intl.DateTimeFormat.prototype.resolvedOptions;
           Intl.DateTimeFormat.prototype.resolvedOptions = function () { const o = RO.apply(this, arguments); o.timeZone = TZ; return o; };
         } catch (e) {}
         try { const off = ${spoof.tzOffset}; Date.prototype.getTimezoneOffset = function () { report('navigator'); return off; }; } catch (e) {}`
      : `// standard mode leaves navigator hints intact; only readback APIs are noised.`}
  } catch (e) {
    // Never let shielding break a page.
  }
})();`;
}

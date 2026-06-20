// Generates branded NSIS installer artwork with no external image tooling:
//   build/installerSidebar.bmp  (164x314) — welcome/finish side panel
//   build/installerHeader.bmp   (150x57)  — inner-page header banner
// Plus PNG previews under build/ for eyeballing. Run: node scripts/make-installer-art.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SS = 3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const len = (x, y) => Math.hypot(x, y);

// --- anchor + tile geometry (256 design space, matching the app icon) -------

function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const inRect = (px, py, x0, y0, x1, y1) => px >= x0 && px <= x1 && py >= y0 && py <= y1;
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function isAnchor(px, py) {
  if (Math.abs(len(px - 128, py - 58) - 17) <= 8) return true;
  if (inRect(px, py, 120, 64, 136, 198)) return true;
  if (inRect(px, py, 84, 92, 172, 108)) return true;
  if (Math.abs(len(px - 128, py - 150) - 62) <= 8 && py >= 150) return true;
  if (inTri(px, py, 44, 150, 92, 168, 70, 200)) return true;
  if (inTri(px, py, 212, 150, 164, 168, 186, 200)) return true;
  return false;
}

// Colour (0..255 triplet) of the icon tile at a design-space point, or null
// outside the rounded square.
function tilePixel(dx, dy) {
  if (sdRoundRect(dx, dy, 128, 128, 118, 118, 52) > 0) return null;
  if (isAnchor(dx, dy)) return [248, 250, 252];
  const t = clamp((dy - 10) / 236, 0, 1);
  return [Math.round(mix(56, 7, t)), Math.round(mix(189, 89, t)), Math.round(mix(248, 133, t))];
}

// --- 5x7 pixel font for the wordmark ----------------------------------------

const FONT = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
};

function drawText(put, text, x, y, scale, color) {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          if (glyph[row][col] === '1') {
            for (let sy = 0; sy < scale; sy += 1) {
              for (let sx = 0; sx < scale; sx += 1) {
                put(cx + col * scale + sx, y + row * scale + sy, color);
              }
            }
          }
        }
      }
    }
    cx += 6 * scale; // 5px glyph + 1px gap
  }
}

// --- canvas helpers ----------------------------------------------------------

function makeCanvas(w, h) {
  const buf = new Uint8Array(w * h * 3);
  return {
    w,
    h,
    buf,
    set(x, y, c) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 3;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
    },
  };
}

// Fill a vertical gradient background.
function fillVGradient(cv, top, bottom) {
  for (let y = 0; y < cv.h; y += 1) {
    const t = y / (cv.h - 1);
    const c = [
      Math.round(mix(top[0], bottom[0], t)),
      Math.round(mix(top[1], bottom[1], t)),
      Math.round(mix(top[2], bottom[2], t)),
    ];
    for (let x = 0; x < cv.w; x += 1) cv.set(x, y, c);
  }
}

// Composite the icon tile centred at (cx,cy) with the given pixel size.
function drawTile(cv, cx, cy, size) {
  const half = size / 2;
  for (let y = Math.floor(cy - half); y < Math.ceil(cy + half); y += 1) {
    for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const dx = ((fx - (cx - half)) / size) * 256;
          const dy = ((fy - (cy - half)) / size) * 256;
          const c = tilePixel(dx, dy);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const n = SS * SS;
      if (a === 0) continue;
      // Blend tile over existing background by coverage.
      const cov = a / n;
      const i = (y * cv.w + x) * 3;
      cv.buf[i] = Math.round(mix(cv.buf[i], r / a, cov));
      cv.buf[i + 1] = Math.round(mix(cv.buf[i + 1], g / a, cov));
      cv.buf[i + 2] = Math.round(mix(cv.buf[i + 2], b / a, cov));
    }
  }
}

// --- encoders ----------------------------------------------------------------

function encodeBmp24(cv) {
  const rowSize = Math.ceil((cv.w * 3) / 4) * 4;
  const pixels = rowSize * cv.h;
  const buf = Buffer.alloc(54 + pixels);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixels, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(cv.w, 18);
  buf.writeInt32LE(cv.h, 22); // positive => bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixels, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < cv.h; y += 1) {
    const srcY = cv.h - 1 - y; // bottom-up
    let off = 54 + y * rowSize;
    for (let x = 0; x < cv.w; x += 1) {
      const i = (srcY * cv.w + x) * 3;
      buf[off++] = cv.buf[i + 2]; // B
      buf[off++] = cv.buf[i + 1]; // G
      buf[off++] = cv.buf[i];     // R
    }
  }
  return buf;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i += 1) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(cv) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0); ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // RGB
  const stride = cv.w * 3;
  const raw = Buffer.alloc((stride + 1) * cv.h);
  for (let y = 0; y < cv.h; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(cv.buf.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- compose -----------------------------------------------------------------

const TOP = [20, 48, 79];
const BOTTOM = [9, 15, 26];
const WHITE = [248, 250, 252];

function buildSidebar() {
  const cv = makeCanvas(164, 314);
  fillVGradient(cv, TOP, BOTTOM);
  drawTile(cv, 82, 96, 96);
  // "HARBOR" wordmark, centred (6 letters * 6 * scale).
  const scale = 3;
  const textW = 6 * 6 * scale - scale;
  drawText((x, y, c) => cv.set(x, y, c), 'HARBOR', Math.round((164 - textW) / 2), 178, scale, WHITE);
  return cv;
}

function buildHeader() {
  const cv = makeCanvas(150, 57);
  fillVGradient(cv, TOP, BOTTOM);
  drawTile(cv, 122, 28, 44);
  drawText((x, y, c) => cv.set(x, y, c), 'HARBOR', 12, 22, 2, WHITE);
  return cv;
}

mkdirSync(join(root, 'build'), { recursive: true });
const sidebar = buildSidebar();
const header = buildHeader();
writeFileSync(join(root, 'build', 'installerSidebar.bmp'), encodeBmp24(sidebar));
writeFileSync(join(root, 'build', 'installerHeader.bmp'), encodeBmp24(header));
writeFileSync(join(root, 'build', 'installerSidebar.preview.png'), encodePng(sidebar));
writeFileSync(join(root, 'build', 'installerHeader.preview.png'), encodePng(header));
console.log('Wrote build/installerSidebar.bmp and build/installerHeader.bmp (+ .preview.png)');

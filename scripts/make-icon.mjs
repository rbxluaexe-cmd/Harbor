// Generates Harbor's app icon with no external image tooling.
//
// Rasterises an anchor-on-gradient mark via signed-distance fields with 4x4
// supersampling, encodes PNGs with the built-in zlib, and wraps them into a
// multi-resolution Windows .ico (PNG-compressed entries, Vista+). Outputs
// build/icon.ico (Windows app/installer) and build/icon.png (runtime window
// icon). Run: `node scripts/make-icon.mjs`.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // supersampling factor per axis

// ---- geometry (all in a 256x256 design space) ------------------------------

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mix(a, b, t) { return a + (b - a) * t; }
function len(x, y) { return Math.hypot(x, y); }

// Rounded-rect signed distance (negative inside).
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function inRect(px, py, x0, y0, x1, y1) {
  return px >= x0 && px <= x1 && py >= y0 && py <= y1;
}

// Point-in-triangle via half-plane signs.
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Is the design-space point part of the anchor glyph?
function isAnchor(px, py) {
  // Eye ring at the top.
  const ringD = Math.abs(len(px - 128, py - 58) - 17);
  if (ringD <= 8) return true;
  // Shank (vertical bar).
  if (inRect(px, py, 120, 64, 136, 198)) return true;
  // Stock (horizontal crossbar).
  if (inRect(px, py, 84, 92, 172, 108)) return true;
  // Bottom U arc (the arms), lower half of a thick ring.
  const armR = len(px - 128, py - 150);
  if (Math.abs(armR - 62) <= 8 && py >= 150) return true;
  // Fluke barbs at the arc ends, pointing up-and-out.
  if (inTri(px, py, 44, 150, 92, 168, 70, 200)) return true;
  if (inTri(px, py, 212, 150, 164, 168, 186, 200)) return true;
  return false;
}

// Background gradient colour at a given y (design space).
function bgColor(py) {
  const t = clamp((py - 10) / 236, 0, 1);
  return [
    Math.round(mix(56, 7, t)),   // 0x38 -> 0x07
    Math.round(mix(189, 89, t)), // 0xbd -> 0x59
    Math.round(mix(248, 133, t)),// 0xf8 -> 0x85
  ];
}

const ANCHOR = [248, 250, 252];

// ---- rasteriser ------------------------------------------------------------

function render(size) {
  const out = new Uint8Array(size * size * 4);
  const scale = 256 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = (x + (sx + 0.5) / SS) * scale;
          const fy = (y + (sy + 0.5) / SS) * scale;
          const d = sdRoundRect(fx, fy, 128, 128, 118, 118, 52);
          if (d > 0) continue; // outside rounded square -> transparent
          let c;
          if (isAnchor(fx, fy)) c = ANCHOR;
          else c = bgColor(fy);
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---- PNG encoder -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // 10,11,12 = compression, filter, interlace = 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO wrapper -----------------------------------------------------------

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  const blobs = [];
  entries.forEach((e, idx) => {
    const o = idx * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;     // width (0 == 256)
    dir[o + 1] = e.size >= 256 ? 0 : e.size; // height
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4);  // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
    blobs.push(e.png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---- main ------------------------------------------------------------------

const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map((size) => ({ size, png: encodePng(render(size), size) }));

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.ico'), encodeIco(entries));
const png256 = entries.find((e) => e.size === 256).png;
writeFileSync(join(root, 'build', 'icon.png'), png256);
console.log(`Wrote build/icon.ico (${sizes.join(',')}) and build/icon.png`);

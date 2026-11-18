import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES_DIR = path.join(ROOT_DIR, 'android', 'app', 'src', 'main', 'res');

const DENSITIES = [
  { name: 'mdpi', launcher: 48, foreground: 108 },
  { name: 'hdpi', launcher: 72, foreground: 162 },
  { name: 'xhdpi', launcher: 96, foreground: 216 },
  { name: 'xxhdpi', launcher: 144, foreground: 324 },
  { name: 'xxxhdpi', launcher: 192, foreground: 432 },
];

// CRC32 table for PNG chunks
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function blendPixel(buf, idx, r, g, b, a) {
  if (a <= 0) return;
  const srcA = Math.min(1, Math.max(0, a));
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
  buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
  buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function renderIcon(size, mode) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // Adaptive foreground stays inside safe 62% center zone
  const scale = mode === 'foreground' ? size * 0.62 : size * 0.92;
  const half = scale / 2;

  const wavePts = [
    [-0.36, 0.27],
    [-0.22, 0.27],
    [-0.14, 0.16],
    [-0.06, 0.36],
    [0.02, 0.10],
    [0.10, 0.37],
    [0.18, 0.18],
    [0.24, 0.27],
    [0.36, 0.27],
  ].map(([nx, ny]) => [cx + nx * scale, cy + ny * scale]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // Background shape
      if (mode === 'square') {
        const rx = half;
        const corner = scale * 0.22;
        const dx = Math.max(Math.abs(px - cx) - (rx - corner), 0);
        const dy = Math.max(Math.abs(py - cy) - (rx - corner), 0);
        const edgeDist = Math.hypot(dx, dy) - corner;
        const bgAlpha = Math.max(0, Math.min(1, 0.5 - edgeDist));
        if (bgAlpha > 0) {
          const grad = (px + py) / (2 * size);
          blendPixel(rgba, idx, 15 - grad * 6, 23 - grad * 10, 42 - grad * 20, bgAlpha);
        }
      } else if (mode === 'round') {
        const edgeDist = Math.hypot(px - cx, py - cy) - half;
        const bgAlpha = Math.max(0, Math.min(1, 0.5 - edgeDist));
        if (bgAlpha > 0) {
          const grad = (px + py) / (2 * size);
          blendPixel(rgba, idx, 15 - grad * 6, 23 - grad * 10, 42 - grad * 20, bgAlpha);
        }
      }

      // Shield / dark card inner circle
      const shieldRadius = scale * 0.42;
      const shieldDist = Math.hypot(px - cx, py - cy * 0.96) - shieldRadius;
      const shieldAlpha = Math.max(0, Math.min(1, 0.5 - shieldDist));
      if (shieldAlpha > 0) {
        blendPixel(rgba, idx, 17, 24, 39, shieldAlpha * 0.92);
      }

      // Outer red lens ring
      const lensCy = cy - scale * 0.05;
      const dLens = Math.hypot(px - cx, py - lensCy);
      const ringR = scale * 0.24;
      const ringStroke = Math.max(1.5, scale * 0.036);
      const ringDist = Math.abs(dLens - ringR) - ringStroke / 2;
      const ringAlpha = Math.max(0, Math.min(1, 0.6 - ringDist));
      if (ringAlpha > 0) {
        blendPixel(rgba, idx, 239, 68, 68, ringAlpha);
      }

      // Inner lens dark disk & slate rim
      const innerR = scale * 0.14;
      const innerDist = dLens - innerR;
      const innerAlpha = Math.max(0, Math.min(1, 0.6 - innerDist));
      if (innerAlpha > 0) {
        blendPixel(rgba, idx, 30, 41, 59, innerAlpha);
      }

      // Center red REC dot
      const dotR = scale * 0.058;
      const dotAlpha = Math.max(0, Math.min(1, 0.6 - (dLens - dotR)));
      if (dotAlpha > 0) {
        blendPixel(rgba, idx, 239, 68, 68, dotAlpha);
      }

      // Top-right status REC indicator
      const recX = cx + scale * 0.29;
      const recY = cy - scale * 0.28;
      const recDist = Math.hypot(px - recX, py - recY) - scale * 0.05;
      const recAlpha = Math.max(0, Math.min(1, 0.6 - recDist));
      if (recAlpha > 0) {
        blendPixel(rgba, idx, 239, 68, 68, recAlpha);
      }

      // Acoustic cyan waveform along bottom
      let minWaveDist = Infinity;
      for (let i = 0; i < wavePts.length - 1; i += 1) {
        const d = distToSegment(
          px,
          py,
          wavePts[i][0],
          wavePts[i][1],
          wavePts[i + 1][0],
          wavePts[i + 1][1],
        );
        if (d < minWaveDist) minWaveDist = d;
      }
      const waveStroke = Math.max(1.4, scale * 0.028);
      const waveAlpha = Math.max(0, Math.min(1, 0.6 - (minWaveDist - waveStroke / 2)));
      if (waveAlpha > 0) {
        blendPixel(rgba, idx, 56, 189, 248, waveAlpha);
      }
    }
  }

  return encodePng(size, size, rgba);
}

export function generateAndroidIcons() {
  for (const d of DENSITIES) {
    const dir = path.join(RES_DIR, `mipmap-${d.name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderIcon(d.launcher, 'square'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), renderIcon(d.launcher, 'round'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), renderIcon(d.foreground, 'foreground'));
  }
  console.log(`Generated Android launcher icons across ${DENSITIES.length} densities.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateAndroidIcons();
}

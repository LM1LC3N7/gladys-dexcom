// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a glucose curve over a
// band, the points of the last measurements (one every 5 minutes), a round
// sensor and a trend arrow.
// Plain Node (zlib), no dependency, no logo.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [12, 36, 40];
const BLUE = [20, 84, 80];
const GRID = [70, 140, 130];
const BAND = [90, 200, 120];
const CURVE = [120, 230, 160];
const WHITE = [240, 246, 248];
const GREY = [190, 200, 210];
const ORANGE = [250, 130, 60];

// The target band (y of 180 and 70 mg/dL) and the curve: y(x).
const BAND_TOP = 200;
const BAND_BOTTOM = 330;
const curve = (x) => 270 - 95 * Math.sin(x / 120) * Math.exp(-x / 900) - 25 * Math.sin(x / 47);
const POINTS = Array.from({ length: 9 }, (_, i) => 60 + i * 52).map((x) => [x, curve(x)]);
// The sensor: a disc on the right.
const SENSOR = [650, 160, 78];

function pixel(x, y) {
  let color = mix(DARK, BLUE, (x / WIDTH) * 0.4 + (y / HEIGHT) * 0.6);
  if (x % 50 < 1 || y % 50 < 1) color = mix(color, GRID, 0.25);
  if (y > BAND_TOP && y < BAND_BOTTOM && x < 540) color = mix(color, BAND, 0.28);
  if (x < 540) {
    // The curve: distance along y, scaled by the slope.
    const dy = (curve(x + 1) - curve(x - 1)) / 2;
    const dist = Math.abs(y - curve(x)) / Math.sqrt(1 + dy * dy);
    color = mix(color, CURVE, smooth(3.5, dist));
  }
  for (const [px, py] of POINTS) {
    color = mix(color, WHITE, smooth(8, Math.hypot(x - px, y - py)));
    color = mix(color, CURVE, smooth(4, Math.hypot(x - px, y - py)));
  }
  const [cx, cy, r] = SENSOR;
  const d = Math.hypot(x - cx, y - cy);
  color = mix(color, GREY, smooth(r, d));
  color = mix(color, WHITE, smooth(r * 0.82, d));
  color = mix(color, ORANGE, smooth(r * 0.22, d));
  // The trend arrow (↗) under the sensor: a shaft and a head.
  const [ax, ay, bx, by] = [600, 430, 700, 330];
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / 20000));
  const shaft = Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
  color = mix(color, WHITE, smooth(7, shaft));
  // The head: the triangle (bx, by), (bx - 45, by), (bx, by + 45).
  if (x <= bx && y >= by && bx - x + (y - by) <= 45) color = WHITE;
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);

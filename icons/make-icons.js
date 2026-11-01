// Generate simple rounded "O" icon PNGs using only Node built-ins (zlib).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeIcon(size) {
  const w = size, h = size;
  const cx = w / 2, cy = h / 2;
  const r = w * 0.42;
  const ringW = Math.max(1, w * 0.14);
  const innerR = r - ringW;
  // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let R = 0, G = 0, B = 0, A = 0;
      if (d <= r) {
        if (d <= innerR) {
          // inner fill: light blue
          R = 59; G = 130; B = 246; A = 255;
        } else {
          // ring: darker blue
          R = 37; G = 99; B = 235; A = 255;
        }
      }
      const off = y * (w * 4 + 1) + 1 + x * 4;
      raw[off] = R; raw[off + 1] = G; raw[off + 2] = B; raw[off + 3] = A;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname);
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), makeIcon(s));
  console.log(`wrote icon${s}.png`);
}

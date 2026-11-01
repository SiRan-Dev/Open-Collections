// icons/make-icons.js — 生成 Open Collections 图标（仅用 Node 内置 zlib）。
// 设计：品牌蓝渐变圆角底 + 白色叠放卡片（呼应「集锦 / Collections」），
// 48px 及以上在前景卡片上加两条蓝色文本线；超采样抗锯齿。
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

const SS = 4; // 超采样倍数

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// 圆角矩形 SDF（单位坐标），返回有符号距离（单位），负为内部。
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// 覆盖度：把单位距离换算成像素距离后做 1px 过渡。
function coverage(sdfUnit, size) {
  return clamp01(0.5 - sdfUnit * size);
}

// 颜色常量
const GRAD_TOP = [79, 148, 255];   // #4F94FF
const GRAD_BOTTOM = [37, 99, 235]; // #2563EB（与界面 --primary-hover 一致）
const LINE_BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

function sample(u, v, size) {
  // 1) 圆角底：满幅圆角方形
  const tileA = coverage(sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225), size);
  let color = mix(GRAD_TOP, GRAD_BOTTOM, clamp01(u * 0.35 + v * 0.65));
  // 左上方柔和高光
  const hl = 0.14 * clamp01(1 - Math.hypot(u - 0.25, v - 0.15) / 0.85);
  color = mix(color, WHITE, hl);
  let r = color[0], g = color[1], b = color[2], a = tileA;

  const over = (cr, cg, cb, ca) => {
    r = cr * ca + r * (1 - ca);
    g = cg * ca + g * (1 - ca);
    b = cb * ca + b * (1 - ca);
    a = ca + a * (1 - ca);
  };

  // 2) 后景卡片（半透明白，制造叠放层次）
  const backA = coverage(sdRoundRect(u, v, 0.585, 0.415, 0.195, 0.215, 0.075), size) * 0.55;
  if (backA > 0) over(255, 255, 255, backA);

  // 3) 前景卡片（实白）
  const frontA = coverage(sdRoundRect(u, v, 0.425, 0.585, 0.195, 0.215, 0.075), size);
  if (frontA > 0) over(255, 255, 255, frontA);

  // 4) 前景卡片上的文本线（小尺寸省略，避免糊成一团）
  if (size >= 48) {
    const l1 = coverage(sdRoundRect(u, v, 0.425, 0.52, 0.115, 0.028, 0.028), size);
    if (l1 > 0) over(LINE_BLUE[0], LINE_BLUE[1], LINE_BLUE[2], l1);
    const l2 = coverage(sdRoundRect(u, v, 0.4, 0.645, 0.09, 0.028, 0.028), size);
    if (l2 > 0) over(LINE_BLUE[0], LINE_BLUE[1], LINE_BLUE[2], l2);
  }

  return [r, g, b, a];
}

function makeIcon(size) {
  const w = size, h = size;
  const sw = w * SS, sh = h * SS;
  const sup = new Float64Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const [r, g, b, a] = sample((x + 0.5) / sw, (y + 0.5) / sh, size);
      const off = (y * sw + x) * 4;
      sup[off] = r; sup[off + 1] = g; sup[off + 2] = b; sup[off + 3] = a;
    }
  }
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const off = ((y * SS + dy) * sw + (x * SS + dx)) * 4;
          r += sup[off]; g += sup[off + 1]; b += sup[off + 2]; a += sup[off + 3];
        }
      }
      const n = SS * SS;
      const off = y * (w * 4 + 1) + 1 + x * 4;
      raw[off] = Math.round(r / n);
      raw[off + 1] = Math.round(g / n);
      raw[off + 2] = Math.round(b / n);
      raw[off + 3] = Math.round((a / n) * 255);
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

const outDir = __dirname;
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), makeIcon(s));
  console.log(`wrote icon${s}.png`);
}

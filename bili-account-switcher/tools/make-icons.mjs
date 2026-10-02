/**
 * 生成扩展图标（16/48/128），零依赖：手写 PNG 容器 + zlib.deflateSync。
 * 方向与 STYLE.md 一致：零圆角方块、硬描边、单一品牌粉 + 白色字形。
 *
 *   node tools/make-icons.mjs                       # 生成 16/48/128 到 extension/icons
 *   node tools/make-icons.mjs --sizes 512 --out .   # 放大稿，用来肉眼确认字形
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const OUT_DIR = resolve(HERE, "..", argOf("--out") ?? "extension/icons");
const SIZES = (argOf("--sizes") ?? "16,48,128")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PINK = [0xfb, 0x72, 0x99, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const BLACK = [0x00, 0x00, 0x00, 0xff];

/** 5x7 点阵字母 B，整倍数放大 —— 小尺寸下不会糊。 */
const GLYPH_B = ["11110", "10001", "10001", "11110", "10001", "10001", "11110"];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // 每条扫描线前置一个 filter 字节（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function setPixel(buf, size, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const border = Math.max(1, Math.round(size / 16));
  // 字形四周留白，避免笔画贴到描边上、小尺寸下糊成一块
  const pad = Math.max(1, Math.round(size / 8));

  // 品牌粉底 + 纯黑硬描边（零圆角，与 Brutalist 方向一致）
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const onBorder = x < border || y < border || x >= size - border || y >= size - border;
      setPixel(buf, size, x, y, onBorder ? BLACK : PINK);
    }
  }

  // 字形整倍数放大后居中（整数倍缩放，小尺寸不产生灰边）
  const glyphW = GLYPH_B[0].length;
  const glyphH = GLYPH_B.length;
  const usable = size - (border + pad) * 2;
  const scale = Math.max(1, Math.floor(Math.min(usable / glyphW, usable / glyphH)));
  const drawW = glyphW * scale;
  const drawH = glyphH * scale;
  const offX = Math.floor((size - drawW) / 2);
  const offY = Math.floor((size - drawH) / 2);

  for (let gy = 0; gy < glyphH; gy += 1) {
    for (let gx = 0; gx < glyphW; gx += 1) {
      if (GLYPH_B[gy][gx] !== "1") continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          setPixel(buf, size, offX + gx * scale + dx, offY + gy * scale + dy, WHITE);
        }
      }
    }
  }
  return buf;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const buffer = render(size);
  const file = resolve(OUT_DIR, `icon${size}.png`);
  const png = encodePng(size, buffer);
  writeFileSync(file, png);
  console.log(`icon${size}.png  ${png.length} bytes  ${size}x${size}  -> ${file}`);

  // --dump：把像素打成字符画，用来确认小尺寸下字形没糊（# 描边 / o 字形 / · 底色）
  const dumpSize = Number(argOf("--dump") ?? 0);
  if (dumpSize === size) {
    const rows = [];
    for (let y = 0; y < size; y += 1) {
      let line = "";
      for (let x = 0; x < size; x += 1) {
        const [r] = [buffer[(y * size + x) * 4], buffer[(y * size + x) * 4 + 1]];
        line += r > 200 && x === x && buffer[(y * size + x) * 4 + 1] > 200 ? "o" : r < 60 ? "#" : "·";
      }
      rows.push(line);
    }
    console.log(rows.join("\n"));
  }
}

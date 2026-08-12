/**
 * Generates the extension's PNG icons.
 *
 * Chrome only accepts raster icons, and checking binaries into git for
 * something this simple is a poor trade — so they are drawn here at build time
 * with a ~40 line PNG encoder over node:zlib. The mark is a rounded square with
 * a diagonal split: the DOM side and the vector side of the same rectangle.
 */
import { deflateSync } from "node:zlib";

const BG = [0x1f, 0x2a, 0x44, 0xff];
const LEFT = [0x4b, 0x9f, 0xea, 0xff];
const RIGHT = [0xff, 0x9f, 0x1c, 0xff];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA pixel data as a PNG. */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const inset = size * 0.06;

  const insideRoundedSquare = (x, y) => {
    const min = inset;
    const max = size - inset;
    if (x < min || y < min || x > max || y > max) return false;
    const cx = Math.min(Math.max(x, min + radius), max - radius);
    const cy = Math.min(Math.max(y, min + radius), max - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const offset = (y * size + x) * 4;

      if (!insideRoundedSquare(px, py)) continue;

      // Diagonal split from bottom-left to top-right.
      const onLeft = py > (size - px) * 0.9;
      const color = px < size * 0.16 || py < size * 0.16 ? BG : onLeft ? LEFT : RIGHT;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }

  return encodePng(size, size, pixels);
}

/** Icon sizes Chrome asks for in the action and the extensions page. */
export const ICON_SIZES = [16, 32, 48, 128];

export function renderIcons() {
  return ICON_SIZES.map((size) => ({ size, png: drawIcon(size) }));
}

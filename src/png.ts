/**
 * Minimal 8-bit grayscale PNG encoder for snapcompact frames.
 *
 * Pure Node: one `node:zlib` deflate call per frame plus manual chunk
 * assembly. No native dependencies. Frames are grayscale (white background,
 * black ink, dim-gray spans) which is what every shipped shape needs.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256).fill(0);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.write(type, 4, "ascii");
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + payload.length), 8 + payload.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode a grayscale frame as a base64 PNG. `gray` holds one byte per pixel
 * row-major (0 = black … 255 = white), exactly `width * height` bytes.
 */
export function encodePngBase64(width: number, height: number, gray: Uint8Array): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Scanlines: filter byte 0 (None) prefix on every row.
  const stride = width + 1;
  const scanlines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    scanlines.set(gray.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const idat = deflateSync(scanlines, { level: 6 });

  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

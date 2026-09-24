import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";

import { encodePngBase64 } from "../src/png.ts";
import { renderFrame, renderedChars } from "../src/render.ts";
import { fontRows } from "../src/font.ts";
import { SHAPE_VARIANTS, geometry, resolveShape } from "../src/shapes.ts";
import { NEWLINE_GLYPH, DIM_ON, DIM_OFF } from "../src/text.ts";
/** Decode a grayscale PNG produced by encodePngBase64 (filter 0 only). */
function decodePng(base64: string): { width: number; height: number; pixels: Buffer } {
  const buf = Buffer.from(base64, "base64");
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG signature",
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const idats: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const payload = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      assert.equal(payload[8], 8, "bit depth");
      assert.equal(payload[9], 0, "color type grayscale");
    } else if (type === "IDAT") {
      idats.push(Buffer.from(payload));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width + 1;
  assert.equal(raw.length, height * stride, "scanline size");
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, "filter type");
    raw.copy(pixels, y * width, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, pixels };
}

test("encodePngBase64: round-trips dimensions and pixels", () => {
  const w = 16;
  const h = 8;
  const gray = new Uint8Array(w * h).fill(255);
  gray[0] = 0;
  gray[w * 3 + 5] = 144;
  const { width, height, pixels } = decodePng(encodePngBase64(w, h, gray));
  assert.equal(width, w);
  assert.equal(height, h);
  assert.equal(pixels[0], 0);
  assert.equal(pixels[w * 3 + 5], 144);
  assert.equal(pixels[1], 255);
});

test("renderFrame: 'A' prints ink at the glyph position", () => {
  const shape = SHAPE_VARIANTS["8on16-bw"];
  const size = 64; // 8 cols x 4 rows of cells
  const out = renderFrame("A", shape, size);
  const { width, height, pixels } = decodePng(out.data);
  assert.equal(width, size);
  assert.equal(height, size);
  // 'A' top ink: font row 2 (00011000) at cell (0,0): pixels (3,2),(4,2).
  assert.equal(pixels[2 * width + 3], 0);
  assert.equal(pixels[2 * width + 4], 0);
  // Background stays white.
  assert.equal(pixels[width * 3 + 3], 255);
  assert.equal(out.chars, 1);
  assert.equal(out.cols, 8);
  assert.equal(out.rows, 4);
});

test("renderFrame: tracking advances x by cellWidth", () => {
  const shape = SHAPE_VARIANTS["11on16-bw"];
  const size = 88; // 8 cols x 5 rows
  const out = renderFrame("AA", shape, size);
  const { width, pixels } = decodePng(out.data);
  // Second 'A' crossbar row 6: font 01111110 at x0 = 11.
  const row = 6 * width;
  assert.equal(pixels[row + 11 + 1], 0);
  assert.equal(pixels[row + 11 + 6], 0);
  assert.equal(pixels[row + 11 + 7], 255); // 8th column of glyph is 0 bit
});

test("renderFrame: newline glyph fills the cell pitch-black", () => {
  const shape = SHAPE_VARIANTS["8on16-bw"];
  const size = 64;
  const out = renderFrame(`a${NEWLINE_GLYPH}`, shape, size);
  const { width, pixels } = decodePng(out.data);
  // Cell (1,0): x 8..15, y 0..15 all black.
  for (let y = 0; y < 16; y++) {
    for (let x = 8; x < 16; x++) assert.equal(pixels[y * width + x], 0);
  }
  // Next cell background white.
  assert.equal(pixels[0 * width + 16], 255);
});

test("renderFrame: dim span prints gray ink", () => {
  const shape = SHAPE_VARIANTS["8on16-bw"];
  const size = 64;
  const out = renderFrame(`${DIM_ON}a${DIM_OFF}b`, shape, size);
  const { width, pixels } = decodePng(out.data);
  // 'a' top ink font row 6 (00011100 for lowercase a in 8x13? use crossbar check via known 'A'-style row)
  // Use row 6 bit 2 (00011100 -> bits 2,3,4 set for 'a'? safer: check any ink pixel of 'a' is dim).
  const aInk: number[] = [];
  const bInk: number[] = [];
  for (let r = 0; r < 13; r++) {
    const ra = fontRows(0x61)![r];
    const rb = fontRows(0x62)![r];
    for (let c = 0; c < 8; c++) {
      if (ra & (0x80 >> c)) aInk.push((r) * width + c);
      if (rb & (0x80 >> c)) bInk.push((r + 0) * width + (8 + c)); // cell (1,0)
    }
  }
  assert.ok(aInk.length > 0 && bInk.length > 0);
  for (const i of aInk) assert.equal(pixels[i], 144, "dim ink");
  for (const i of bInk) assert.equal(pixels[i], 0, "full ink");
});

test("renderFrame: carried dim span opens via prepended toggle", () => {
  const shape = SHAPE_VARIANTS["8on16-bw"];
  const size = 64;
  // Renderer is given a page whose text starts mid-dim-span; the caller
  // prepends DIM_ON (see compact()). Verify the prepended marker flips ink.
  const out = renderFrame(`${DIM_ON}b`, shape, size, false);
  const { width, pixels } = decodePng(out.data);
  const bInk = fontRows(0x62)!.flatMap((bits, r) =>
    Array.from({ length: 8 }, (_, c) => (bits & (0x80 >> c) ? r * width + c : -1)).filter((i) => i >= 0),
  );
  for (const i of bInk) assert.equal(pixels[i], 144);
  assert.equal(out.dimOpen, false);
});

test("renderFrame: text longer than capacity is clipped", () => {
  const shape = SHAPE_VARIANTS["8on16-bw"];
  const size = 32; // 4 cols x 2 rows = 8 capacity
  const out = renderFrame("aaaaaaaaaaaaaa", shape, size); // 14 chars
  assert.equal(out.chars, 8);
  assert.ok(out.data.length > 0);
});

test("renderFrame: wide glyph takes two cells and wraps with straddle pad", () => {
  const shape = SHAPE_VARIANTS["8on16-bw"];
  const size = 32; // 4 cols x 2 rows
  // 4 wide glyphs = 8 cells: fill row 0 (中中中中 uses 8 cells? each 2 cells -> 4 glyphs = 8 cells = row 0 exactly)
  const out = renderFrame("中中中中", shape, size);
  assert.equal(out.chars, 4);
  // 5th wide glyph: straddle pad after 4th? 4 glyphs end exactly at cell 8 (row 1 col 0 start).
  const out2 = renderFrame("中中中中中", shape, size);
  assert.equal(out2.chars, 4); // 5th does not fit (cells 8,9,10 > capacity 8)
});

test("renderedChars matches renderFrame char counts", () => {
  const shape = { ...SHAPE_VARIANTS["8on16-bw"], frameTokenEstimate: 1, frameSize: 32 };
  const text = "abcd 中中 ef";
  const geo = geometry(shape);
  assert.equal(renderedChars(text, shape, geo), renderFrame(text, shape, 32, false).chars);
});

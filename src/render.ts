/**
 * Pure-JS snapcompact frame renderer.
 *
 * Replaces OMP's native `renderSnapcompactPng` (Rust, bun) for the shapes
 * this port ships: 8x13-font grid frames, black ink, natural glyph size on a
 * wider/taller cell pitch (no stretch), single line copy. Dim spans print in
 * dim-gray ink; newline glyphs fill their cell pitch-black. */
import { encodePngBase64 } from "./png.ts";
import { fontRows } from "./font.ts";
import { type Shape, type Geometry, geometry } from "./shapes.ts";
import { charCells } from "./layout.ts";

/** Ink values (8-bit grayscale). */
const INK_WHITE = 255;
const INK_BLACK = 0;
/** Dim gray: light enough to recede, dark enough to stay legible. */
const INK_DIM = 0x90;

/** Result of rendering one frame. */
export interface RenderedFrame {
  /** Base64-encoded PNG. */
  data: string;
  cols: number;
  rows: number;
  /** Characters printed (ink toggles excluded; input may be shorter than capacity). */
  chars: number;
}

/**
 * Count visible characters that fit within the frame's cell budget, with wide
 * glyphs taking two cells (and a straddle pad) exactly as the renderer.
 * Ported from OMP's grid branch of `renderedChars`.
 */
export function renderedChars(text: string, shape: Shape, geo: Geometry): number {
  let cell = 0;
  let count = 0;
  for (const ch of text) {
    const w = charCells(ch);
    if (w === 0) continue;
    let at = cell;
    if (w === 2 && geo.cols >= 2 && at % geo.cols === geo.cols - 1) at += 1;
    if (at + w > geo.capacity) break;
    cell = at + w;
    count++;
  }
  return count;
}

/**
 * Render one page of already-normalized text into a snapcompact frame.
 *
 * The page is a contiguous cell slice (see `paginateCells`); characters are
 * placed row-major across the `cols` x `rows` grid, wrapping at the edge.
 * `pageText` may carry DIM_ON/DIM_OFF ink toggles; an open span started on a
 * previous page is passed via `dimOpen`. Returns the base64 PNG plus the
 * printed char count, and the dim-span state after this page.
 */
export function renderFrame(
  pageText: string,
  shape: Shape,
  size: number = shape.frameSize,
  dimOpen = false,
): { data: string; cols: number; rows: number; chars: number; dimOpen: boolean } {
  if (shape.font !== "8x13" || shape.variant !== "bw") {
    throw new Error(`pi-snapcompact: unsupported shape ${String(shape.font)}/${String(shape.variant)}`);
  }
  const geo = geometry(shape, size);
  const { cols, rows } = geo;
  const gridCols = Math.floor(size / shape.cellWidth);
  const gridRows = Math.floor(size / shape.cellHeight);
  const canvas = new Uint8Array(size * size).fill(INK_WHITE);

  let dim = dimOpen;
  let cell = 0;
  let chars = 0;

  for (const ch of pageText) {
    const w = charCells(ch);
    if (w === 0) {
      if (ch === "\u000e") dim = true;
      else if (ch === "\u000f") dim = false;
      continue;
    }
    let at = cell;
    if (w === 2 && cols >= 2 && at % cols === cols - 1) at += 1;
    if (at + w > cols * rows) break;
    cell = at + w;

    const x0 = (at % cols) * shape.cellWidth;
    const y0 = Math.floor(at / cols) * shape.cellHeight;

    if (ch === "\u2588") {
      // Newline glyph: pitch-black cell, full pitch.
      for (let r = 0; r < shape.cellHeight; r++) {
        const rowStart = (y0 + r) * size + x0;
        for (let c = 0; c < shape.cellWidth; c++) canvas[rowStart + c] = INK_BLACK;
      }
      chars++;
      continue;
    }

    const cp = ch.codePointAt(0)!;
    const glyph = fontRows(cp);
    const ink = dim ? INK_DIM : INK_BLACK;
    if (glyph) {
      for (let r = 0; r < 13; r++) {
        const bits = glyph[r];
        if (bits === 0) continue;
        const rowStart = (y0 + r) * size + x0;
        for (let c = 0; c < 8; c++) {
          if (bits & (0x80 >> c)) canvas[rowStart + c] = ink;
        }
      }
    } else {
      // Glyph the font lacks: normalized text should not contain these, but
      // print a full black cell as a visible "unknown" instead of dropping it.
      for (let r = 0; r < 13; r++) {
        const rowStart = (y0 + r) * size + x0;
        for (let c = 0; c < 8; c++) canvas[rowStart + c] = ink;
      }
    }
    chars++;
  }

  // The leading DIM_ON is the caller's carry-in marker (compact() prepends it
  // when a span stays open across a page boundary); it opens ink for this
  // page without owning a span of its own, so the reported state is the
  // balance of the page's own toggles.
  const ownToggles = pageText.startsWith("\u000e") ? pageText.slice(1) : pageText;
  return {
    data: encodePngBase64(size, size, canvas),
    cols,
    rows,
    chars,
    dimOpen: ownToggles.lastIndexOf("\u000e") > ownToggles.lastIndexOf("\u000f"),
  };
}

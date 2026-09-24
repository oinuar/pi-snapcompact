/**
 * Archive layout: cell-aware pagination and the foveated text/head, imaged
 * middle, text/tail arrangement. Ported from @oh-my-pi/snapcompact; the
 * two-column doc layout is dropped (no doc shapes ship in this port).*/
import { type Shape, type Geometry, geometry } from "./shapes.ts";

/** One planned frame: the source slice and the shape (quality tier) to render. */
export interface PlanFrame {
  text: string;
  shape: Shape;
}

/** A foveated archive layout. */
export interface ArchiveLayout {
  /** Frames for the imaged middle, oldest to newest. */
  frames: PlanFrame[];
  /** Oldest text region kept verbatim. */
  textHead: string;
  /** Newest text region kept verbatim. */
  textTail: string;
  /** Full kept archive source (oldest to newest, normalized) to persist. */
  keptText: string;
  /** Characters dropped this round to fit the archive budget. */
  truncatedChars: number;
}

/** East Asian Wide / Fullwidth code points that occupy two grid cells when a
 *  narrow bitmap shape draws them. Mirrors OMP's native `is_wide`. */
export function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x2f00 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

/** Cells one character occupies: 0 for the zero-width dim toggles, 2 for wide
 *  code points in narrow bitmap shapes (all of ours), 1 otherwise. */
export function charCells(ch: string): number {
  if (ch === "\u000e" || ch === "\u000f") return 0;
  const cp = ch.codePointAt(0);
  return cp !== undefined && isWideCodePoint(cp) ? 2 : 1;
}

/** Total grid cells a string occupies (ignoring row wrapping/pads). */
export function cellLength(text: string): number {
  let cells = 0;
  for (const ch of text) cells += charCells(ch);
  return cells;
}

/** Longest prefix of `text` that fits `width` cells (at least one char). */
function sliceCells(text: string, width: number): string {
  let cells = 0;
  let out = "";
  let placed = false;
  for (const ch of text) {
    const w = charCells(ch);
    if (placed && cells + w > width) break;
    out += ch;
    cells += w;
    if (w > 0) placed = true;
  }
  return out;
}

/**
 * Split `text` into pages that each fill at most `capacity` grid cells,
 * inserting a one-cell pad before a wide glyph that would straddle the right
 * edge (mirrors OMP's native `place_cell`). Pages are contiguous substrings,
 * so each renders independently starting at cell 0.
 */
export function paginateCells(text: string, capacity: number, cols: number): string[] {
  const chars = [...text];
  const pages: string[] = [];
  let start = 0;
  let cell = 0;
  let hasCell = false;
  for (let i = 0; i < chars.length; i++) {
    const w = charCells(chars[i] ?? "");
    if (w === 0) continue;
    let at = cell;
    if (w === 2 && cols >= 2 && at % cols === cols - 1) at += 1;
    if (hasCell && at + w > capacity) {
      pages.push(chars.slice(start, i).join(""));
      start = i;
      at = 0;
    }
    cell = at + w;
    hasCell = true;
  }
  if (hasCell) pages.push(chars.slice(start).join(""));
  return pages;
}

/** Plain-text history kept verbatim at each chronological edge, in HQ-frame
 *  capacity units per edge. */
const TEXT_EDGE_PAGES = 1;

/**
 * Lay out the accumulated archive `text` (oldest -> newest) with text at both
 * chronological edges and images in the middle. One HQ-capacity stays verbatim
 * at the oldest edge, one at the newest edge, and the middle between them is
 * imaged. If the imaged middle itself overflows `maxFrames`, foveate it
 * internally (HQ/LQ/HQ) and drop the oldest slice of its dense center.
 */
export function planArchive(text: string, high: Shape, low: Shape, maxFrames: number): ArchiveLayout {
  const capHi = geometry(high).capacity;
  const edgeCap = TEXT_EDGE_PAGES * capHi;
  if (text.length <= 2 * edgeCap) {
    return { frames: [], textHead: text, textTail: "", keptText: text, truncatedChars: 0 };
  }
  if (maxFrames < 1) {
    const textHead = text.slice(0, edgeCap);
    const textTail = text.slice(text.length - edgeCap);
    return {
      frames: [],
      textHead,
      textTail,
      keptText: textHead + textTail,
      truncatedChars: text.length - textHead.length - textTail.length,
    };
  }

  const textHead = text.slice(0, edgeCap);
  const textTail = text.slice(text.length - edgeCap);
  const imageText = text.slice(edgeCap, text.length - edgeCap);
  if (imageText.length === 0) {
    return { frames: [], textHead: text, textTail: "", keptText: text, truncatedChars: 0 };
  }

  // Paginate the imaged region into HQ frames (cell-aware, so wide CJK glyphs
  // spanning two cells never overflow a frame's capacity).
  const hiPages = paginateCells(imageText, capHi, geometry(high).cols);
  if (hiPages.length <= maxFrames) {
    return {
      frames: hiPages.map((t) => ({ text: t, shape: high })),
      textHead,
      textTail,
      keptText: textHead + imageText + textTail,
      truncatedChars: 0,
    };
  }

  // Foveate the imaged middle: one HQ page at each chronological edge and one
  // dense LQ page for the middle. The dense middle keeps only its newest page;
  // the oldest dense pages are dropped to fit the archive budget.
  const capLo = geometry(low).capacity;
  const headPage = hiPages[0]!;
  const tailPage = hiPages[hiPages.length - 1]!;
  const imageHead = headPage;
  const imageTail = tailPage;
  const middleSource = imageText.slice(imageHead.length, imageText.length - imageTail.length);
  const allMiddlePages = paginateCells(middleSource, capLo, geometry(low).cols);
  const middlePages = allMiddlePages.slice(-1);
  const dropped = allMiddlePages.slice(0, -1).join("");
  const truncatedChars = dropped.length;
  const middleText = middleSource.slice(dropped.length);
  return {
    frames: [
      { text: headPage, shape: high },
      ...middlePages.map((t) => ({ text: t, shape: low })),
      { text: tailPage, shape: high },
    ],
    textHead,
    textTail,
    keptText: textHead + imageHead + middleText + imageTail + textTail,
    truncatedChars,
  };
}

/** Frames needed to hold `text` at the given shape, without rendering. */
export function frameCount(text: string, shape: Shape): number {
  return paginateCells(text, geometry(shape).capacity, geometry(shape).cols).length;
}

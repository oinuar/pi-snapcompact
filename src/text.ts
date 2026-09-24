/**
 * Text normalization for frame rendering.
 *
 * Ported from @oh-my-pi/snapcompact. The only OMP dependency replaced is
 * `Bun.stripANSI` (a small regex stripper below) and the native font
 * coverage query (the embedded 8x13 table in ./font.ts).*/
import { supportedChars } from "./font.ts";

/** Zero-width ink toggles understood by the renderer: text between them
 *  prints in dim gray ink without occupying a cell. */
export const DIM_ON = "\u000e";
export const DIM_OFF = "\u000f";

/** Printed in place of newline runs: the renderer fills this cell entirely
 *  with pitch-black ink, so line structure survives whitespace collapsing at
 *  a one-cell cost. */
export const NEWLINE_GLYPH = "\u2588";

const DIM_MARKERS = /[\u000e\u000f]/g;

/** Strip stray ink toggles from raw content so it cannot forge dim spans. */
export function stripDimMarkers(text: string): string {
  return text.replace(DIM_MARKERS, "");
}

/** Normalized archive text -> plain text: drop dim toggles, newline glyphs as real newlines. */
export function toPlainText(text: string): string {
  return stripDimMarkers(text).replaceAll(NEWLINE_GLYPH, "\n");
}

// ============================================================================
// ANSI stripping (replaces Bun.stripANSI)
// ============================================================================

/**
 * Strip ANSI escape sequences: CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL/ST`),
 * and two-character escape/FE/FN sequences.
 */
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI_RE, "") : text;
}

// ============================================================================
// Truncation
// ============================================================================

/** Keep the head and tail of `text`, eliding the middle beyond `maxChars`. */
export function truncateForSummary(text: string, maxChars: number, headRatio: number): string {
  if (text.length <= maxChars) return text;
  const ratio = Math.min(Math.max(headRatio, 0), 1);
  const headChars = Math.round(maxChars * ratio);
  const tailChars = maxChars - headChars;
  const elided = text.length - maxChars;
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  return `${text.slice(0, headChars)} […${elided}ch elided…] ${tail}`;
}

// ============================================================================
// Data URL elision
// ============================================================================

/** One elision marker as emitted by {@link truncateForSummary} (Unicode
 *  ellipses) or as persisted after `normalize()` (ASCII dots). */
const ELIDED_MARKER = String.raw`\[(?:…|\.{3})\d+ch elided(?:…|\.{3})\]`;

/** Unquoted RFC 2045 token used as a media-type parameter name or value. */
const MEDIA_TYPE_TOKEN = String.raw`[\w!#$%&'*+.^|~-]+`;

/**
 * An inline base64 data URL atom. The payload may be empty or carry one
 * embedded elision marker so fragments left by pre-guard slices still match.
 */
const DATA_URL_ATOM = new RegExp(
  String.raw`data:([A-Za-z][\w.+-]*\/[\w.+-]+(?:;${MEDIA_TYPE_TOKEN}=${MEDIA_TYPE_TOKEN})*);base64,` +
    String.raw`([A-Za-z0-9+/=]*(?:\s*${ELIDED_MARKER}\s*[A-Za-z0-9+/=]*)?)` +
    String.raw`(\s*\))?`,
  "gi",
);

const ELIDED_MARKER_RE = new RegExp(String.raw`\s*${ELIDED_MARKER}\s*`);
const MARKDOWN_WHITESPACE_CHAR = /\s/;

/** Canonical base64: 4-char groups with valid terminal padding. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;

/** A non-canonical payload at least this long is a damaged fragment of a real
 *  data URL, not a prose mention like `data:image/png;base64,abc`. */
const DAMAGED_PAYLOAD_MIN_CHARS = 40;

/** `source` text is intact; `archive` text may have been cut by structure-blind
 *  slices at any offset, so every recognized prefix is suspect and always elided. */
type DataUrlContext = "source" | "archive";

/** Start of `!?[label](\s*` immediately before `dataIndex`, or `undefined`. */
function adjacentMarkdownOpenerStart(text: string, dataIndex: number, cursor: number): number | undefined {
  let i = dataIndex;
  while (i > cursor && MARKDOWN_WHITESPACE_CHAR.test(text.charAt(i - 1))) i--;
  if (i - 2 < cursor || text.charAt(i - 1) !== "(" || text.charAt(i - 2) !== "]") return undefined;
  let opener = -1;
  for (let j = i - 3; j >= cursor; j--) {
    const c = text.charAt(j);
    if (c === "]" || c === "\n") break;
    if (c === "[") opener = j;
  }
  if (opener < 0) return undefined;
  return opener > cursor && text.charAt(opener - 1) === "!" ? opener - 1 : opener;
}

/**
 * Replace every inline base64 data URL atomically with a deterministic
 * placeholder. A character cap that slices inside a base64 payload leaves a
 * recognizable image reference that can never decode; OpenAI-dialect providers
 * reject such requests as invalid image input, and because the corrupted text
 * persists in the archive the session re-fails on every later request.
 */
export function elideDataUrls(text: string, context: DataUrlContext = "source"): string {
  if (!/;base64,/i.test(text)) return text;
  DATA_URL_ATOM.lastIndex = 0;
  let match = DATA_URL_ATOM.exec(text);
  if (match === null) return text;
  const out: string[] = [];
  let cursor = 0;
  while (match !== null) {
    const urlStart = match.index;
    const urlEnd = urlStart + match[0].length;
    const mime = match[1] ?? "";
    const payload = match[2] ?? "";
    const closer = match[3];
    const marker = ELIDED_MARKER_RE.exec(payload);
    const isAtom =
      context === "archive" ||
      marker !== null ||
      CANONICAL_BASE64.test(payload) ||
      payload.length >= DAMAGED_PAYLOAD_MIN_CHARS;
    if (!isAtom) {
      out.push(text.slice(cursor, urlEnd));
      cursor = urlEnd;
    } else {
      const b64Chars = marker
        ? payload.length - marker[0].length + Number(/\d+/.exec(marker[0])?.[0] ?? 0)
        : payload.length;
      const placeholder = `[data URL omitted: ${mime}, ${b64Chars} base64 chars]`;
      const foundOpener = adjacentMarkdownOpenerStart(text, urlStart, cursor);
      const openerStart = foundOpener !== undefined && foundOpener >= cursor ? foundOpener : undefined;
      const emitStart = openerStart ?? urlStart;
      out.push(text.slice(cursor, emitStart));
      if (openerStart !== undefined && closer !== undefined) {
        out.push(placeholder);
      } else {
        const opener = openerStart !== undefined ? text.slice(openerStart, urlStart) : "";
        out.push(opener, placeholder, closer ?? "");
      }
      cursor = urlEnd;
    }
    match = DATA_URL_ATOM.exec(text);
  }
  out.push(text.slice(cursor));
  return out.join("");
}

// ============================================================================
// Unicode folding
// ============================================================================

/** Punctuation and symbol folds applied before the NFKD fallback: quotes,
 *  dashes, bullets, arrows, and dot leaders that have no compatibility
 *  decomposition (or one that is itself non-ASCII). */
const CHAR_FOLD: Record<string, string> = {
  // Quotation marks and primes.
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2032": "'",
  "\u2033": '"',
  "\u2035": "'",
  "\u2036": '"',
  "\u2039": "<",
  "\u203a": ">",
  // Dashes, hyphens, and the fraction slash NFKD leaves in vulgar fractions.
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2044": "/",
  // Dot leaders and ellipses.
  "\u2024": ".",
  "\u2025": "..",
  "\u2026": "...",
  "\u22ef": "...",
  // Bullets.
  "\u2022": "*",
  "\u2023": "*",
  "\u2043": "-",
  "\u2219": "*",
  "\u25cf": "*",
  "\u25a0": "*",
  "\u25aa": "*",
  // Arrows.
  "\u2190": "<-",
  "\u2191": "^",
  "\u2192": "->",
  "\u2193": "v",
  "\u2194": "<->",
  "\u21d0": "<=",
  "\u21d2": "=>",
  "\u21d4": "<=>",
  // Check marks and crosses.
  "\u2713": "v",
  "\u2714": "v",
  "\u2717": "x",
  "\u2718": "x",
};

/** Collapsed in one pass: whitespace plus zero-width format characters. */
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;

/** Runs carrying one of these collapse to {@link NEWLINE_GLYPH}. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Leading/trailing spaces or newline glyphs add no information to a frame. */
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;

/** Glyph-less code points skipped outright: controls (bare ESC/BEL/NUL),
 *  combining marks the fonts cannot compose, and lone surrogates. */
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;

/** Combining marks NFKD splits off accented letters. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Status-like pictographs that carry meaning in tool output; all other emoji
 *  pictographs drop instead of burning cells as `?`. */
const EMOJI_FOLD: Record<string, string> = {
  "✅": "[OK]",
  "☑": "[OK]",
  "✔": "[OK]",
  "❌": "[FAIL]",
  "❎": "[FAIL]",
  "✖": "[FAIL]",
  "⚠": "[WARN]",
  "🚨": "[ALERT]",
  "ℹ": "[INFO]",
  "🐛": "[BUG]",
  "💥": "[CRASH]",
  "🔥": "[HOT]",
  "🔒": "[LOCK]",
  "🔓": "[UNLOCK]",
  "📁": "[DIR]",
  "📂": "[DIR]",
  "📄": "[FILE]",
  "📝": "[NOTE]",
  "🧪": "[TEST]",
  "⏳": "[WAIT]",
  "⌛": "[WAIT]",
  "🚀": "[RUN]",
};

const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}/u;

function isAsciiOrLatin1(cp: number): boolean {
  return (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff);
}

/**
 * Aggressive single-code-point ASCII fold via Unicode NFKD: decompose the
 * compatibility form, strip the combining marks, and keep the ASCII/Latin-1
 * skeleton - routing any residual punctuation back through CHAR_FOLD.
 * Returns `undefined` when the code point has no decomposition or still leaves
 * an undrawable glyph, so the caller falls back to `?`.
 */
function foldToAscii(ch: string): string | undefined {
  const decomposed = ch.normalize("NFKD").replace(COMBINING_MARKS, "");
  if (decomposed === ch) return undefined;
  let out = "";
  for (const part of decomposed) {
    const cp = part.codePointAt(0);
    if (cp !== undefined && isAsciiOrLatin1(cp)) {
      out += part;
      continue;
    }
    const fold = CHAR_FOLD[part];
    if (fold === undefined) return undefined;
    out += fold;
  }
  return out;
}

function normalizedInputChars(text: string): string[] {
  const stripped = stripAnsi(text);
  const collapsed = stripped
    // A run of pure format chars vanishes; only a run containing genuine
    // whitespace separates words.
    .replace(COLLAPSIBLE, (run) => (LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? " " : ""))
    .replace(EDGE_RUNS, "");
  return [...collapsed];
}

function candidateUnicodeChars(chars: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isAsciiOrLatin1(cp) || ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
      continue;
    }
    if (
      CHAR_FOLD[ch] !== undefined ||
      (cp >= 0x2500 && cp <= 0x257f) ||
      EMOJI_FOLD[ch] !== undefined ||
      EMOJI_PICTOGRAPH.test(ch) ||
      foldToAscii(ch) !== undefined ||
      UNRENDERABLE.test(ch)
    ) {
      continue;
    }
    unique.add(ch);
  }
  return [...unique];
}

export interface NormalizeStats {
  text: string;
  totalGraphics: number;
  fallbackCount: number;
}

/**
 * Prepare text for printing: strip ANSI escapes, collapse horizontal
 * whitespace runs, fold unsupported symbols (including box drawing to ASCII),
 * preserve Unicode glyphs the embedded 8x13 font can render, and drop
 * decorative emoji instead of printing `?`.
 */
export function normalizeWithStats(text: string): NormalizeStats {
  const chars = normalizedInputChars(text);
  const supported = new Set(supportedChars(candidateUnicodeChars(chars)));
  const out: string[] = [];
  let totalGraphics = 0;
  let fallbackCount = 0;

  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isAsciiOrLatin1(cp)) {
      out.push(ch);
      totalGraphics++;
      continue;
    }
    if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
      out.push(ch);
      continue;
    }
    const emoji = EMOJI_FOLD[ch];
    if (emoji !== undefined) {
      out.push(emoji);
      totalGraphics++;
      continue;
    }
    const fold = CHAR_FOLD[ch];
    if (fold !== undefined) {
      out.push(fold);
      totalGraphics++;
      continue;
    }
    if (cp >= 0x2500 && cp <= 0x257f) {
      out.push(cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+");
      totalGraphics++;
      continue;
    }
    if (!EMOJI_PICTOGRAPH.test(ch) && supported.has(ch)) {
      out.push(ch);
      totalGraphics++;
      continue;
    }
    const folded = foldToAscii(ch);
    if (folded !== undefined) {
      out.push(folded);
      totalGraphics++;
    } else if (EMOJI_PICTOGRAPH.test(ch)) {
      // decorative: drop silently
    } else if (!UNRENDERABLE.test(ch)) {
      out.push("?");
      totalGraphics++;
      fallbackCount++;
    }
  }

  return { text: out.join("").replace(/ +/g, " ").replace(EDGE_RUNS, ""), totalGraphics, fallbackCount };
}

/** See {@link normalizeWithStats} for the normalization contract. */
export function normalize(text: string): string {
  return normalizeWithStats(text).text;
}

/**
 * Scan text with the same path as {@link normalize}; unsafe means more than
 * 5% of graphic characters would hit the `?` fallback.
 */
export function scanRenderability(text: string): { isSafe: boolean; unrenderableRatio: number } {
  const normalized = normalizeWithStats(text);
  const unrenderableRatio = normalized.totalGraphics > 0 ? normalized.fallbackCount / normalized.totalGraphics : 0;
  return { isSafe: unrenderableRatio <= 0.05, unrenderableRatio };
}

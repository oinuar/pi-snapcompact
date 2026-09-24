import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIM_OFF,
  DIM_ON,
  NEWLINE_GLYPH,
  elideDataUrls,
  normalize,
  scanRenderability,
  stripAnsi,
  truncateForSummary,
} from "../src/text.ts";
import { fontRows, fontSupports, supportedChars } from "../src/font.ts";
import { charCells, cellLength, frameCount, isWideCodePoint, paginateCells, planArchive } from "../src/layout.ts";
import { SHAPE_VARIANTS, billingFamily, denseCompanion, geometry, maxFramesForDataBudget, resolveShape } from "../src/shapes.ts";
import { computeFileLists, createFileOps, formatFileList, formatGroupedPaths, stripFileOperationTags, upsertFileOperations } from "../src/files.ts";
import {
  archiveSourceText,
  getPreservedArchive,
  historyBlocks,
  stripPreservedArchive,
  stripThinkingSections,
} from "../src/archive.ts";

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

test("font: A glyph has the expected shape", () => {
  const rows = fontRows(0x41)!;
  assert.equal(rows.length, 13);
  // Top apex at row 2, crossbar at row 7 of the 8x13 'A'.
  assert.equal(rows[2], 0b00011000);
  assert.equal(rows[7], 0b01111110);
  assert.equal(rows[0], 0);
});

test("font: space is an empty glyph, CJK is absent", () => {
  assert.ok(fontSupports(0x20));
  assert.ok(fontRows(0x20)!.every((r) => r === 0));
  assert.ok(!fontSupports(0x4e2d)); // 中
  assert.ok(fontSupports(0x03b1)); // Greek alpha (ISO10646 build)
  assert.ok(fontSupports(0x0430)); // Cyrillic a
});

test("font: supportedChars keeps only covered unique chars", () => {
  assert.equal(supportedChars("ab中cαb"), "abcα");
});

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

test("normalize: whitespace collapse and newline glyph", () => {
  assert.equal(normalize("a   b\nc"), `a b${NEWLINE_GLYPH}c`);
  assert.equal(normalize("\n\n  spaced  \n\n"), "spaced");
});

test("normalize: punctuation folds", () => {
  assert.equal(normalize("– — … → │"), "- - ... -> |");
  assert.equal(normalize("‘quoted’ “q”"), "'quoted' \"q\"");
});

test("normalize: emoji fold and drop", () => {
  assert.equal(normalize("✅ ok 🎉"), "[OK] ok");
  assert.equal(normalize("🐛 bug"), "[BUG] bug");
});

test("normalize: NFKD fold and Latin-1 passthrough", () => {
  assert.equal(normalize("①one"), "1one"); // circled one decomposes
  assert.equal(normalize("café — über"), "café — über".replace("—", "-"));
  assert.equal(normalize("Σ=α"), "Σ=α");
});

test("normalize: unsupported CJK falls back to ?", () => {
  const out = normalize("中a文");
  assert.ok(out.includes("?"));
  assert.ok(out.includes("a"));
});

test("normalize: dim toggles and newline glyph pass through untouched", () => {
  assert.equal(normalize(`${DIM_ON}dim${DIM_OFF} plain`), `${DIM_ON}dim${DIM_OFF} plain`);
  assert.equal(normalize(`a${NEWLINE_GLYPH}b`), `a${NEWLINE_GLYPH}b`);
});

test("normalize: ANSI escapes are stripped", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
  assert.equal(normalize("\x1b[1mbold\x1b[0m x"), "bold x");
});

test("scanRenderability: mixed CJK is unsafe, ASCII is safe", () => {
  assert.ok(scanRenderability("hello world").isSafe);
  assert.ok(!scanRenderability("中文日本語のテキスト").isSafe);
});

test("truncateForSummary: head/tail with elision marker", () => {
  const out = truncateForSummary("x".repeat(100), 20, 0.6);
  assert.ok(out.startsWith("xxxxxx"));
  assert.ok(out.includes("[…80ch elided…]"));
  assert.equal(truncateForSummary("short", 10, 0.6), "short");
});

// ---------------------------------------------------------------------------
// Data URL elision
// ---------------------------------------------------------------------------

test("elideDataUrls: intact data URL in source context", () => {
  const url = `data:image/png;base64,${"A".repeat(100)}`;
  const out = elideDataUrls(`before ${url} after`);
  assert.ok(out.includes("[data URL omitted: image/png, 100 base64 chars]"));
  assert.ok(!out.includes("AAAA"));
});

test("elideDataUrls: markdown wrapper is swallowed", () => {
  const url = `data:image/png;base64,${"B".repeat(80)}`;
  const out = elideDataUrls(`![shot](${url})`);
  assert.ok(!out.includes("![shot]("));
  assert.ok(out.includes("[data URL omitted: image/png, 80 base64 chars]"));
});

test("elideDataUrls: short prose mention survives in source context", () => {
  const out = elideDataUrls("see data:image/png;base64,abc for format");
  assert.ok(out.includes("data:image/png;base64,abc"));
});

test("elideDataUrls: damaged fragments are elided in archive context", () => {
  const out = elideDataUrls(`data:image/png;base64,${"C".repeat(10)}`, "archive");
  assert.ok(out.includes("[data URL omitted:"));
});

// ---------------------------------------------------------------------------
// Layout / pagination
// ---------------------------------------------------------------------------

test("paginateCells: capacity and wide-char straddle pad", () => {
  // capacity 4, cols 4: 'ab中' = 1+1+2 cells; next wide char would straddle.
  const pages = paginateCells("ab中cd中", 4, 4);
  assert.deepEqual(pages, ["ab中", "cd中"]);
  // capacity 10, cols 4: 2 wide chars = 4 cells; a third wide char after col 3 straddles.
  const pages2 = paginateCells("中中中中中中中中", 10, 4);
  const cellsPer = pages2.map(cellLength);
  for (const c of cellsPer) assert.ok(c <= 10);
});

test("charCells: wide, dim, normal", () => {
  assert.equal(charCells("中"), 2);
  assert.equal(charCells(DIM_ON), 0);
  assert.equal(charCells("a"), 1);
  assert.ok(isWideCodePoint(0x3042)); // hiragana
  assert.ok(!isWideCodePoint(0x61));
});

test("planArchive: tiny archive is text-only", () => {
  const high = resolveShape({ provider: "openai", id: "gpt-x" });
  const low = denseCompanion(high, "openai");
  const cap = geometry(high).capacity;
  const text = "a".repeat(cap); // <= 2*edgeCap
  const layout = planArchive(text, high, low, 10);
  assert.equal(layout.frames.length, 0);
  assert.equal(layout.textHead, text);
  assert.equal(layout.textTail, "");
  assert.equal(layout.keptText, text);
  assert.equal(layout.truncatedChars, 0);
});

test("planArchive: large archive gets frames + text edges", () => {
  const high = resolveShape({ provider: "openai", id: "gpt-x" }, "8on16-bw");
  const low = denseCompanion(high, "openai");
  const cap = geometry(high).capacity;
  const text = "a".repeat(cap * 3); // 3 edge caps: middle imaged
  const layout = planArchive(text, high, low, 80);
  assert.equal(layout.textHead.length, cap);
  assert.equal(layout.textTail.length, cap);
  assert.ok(layout.frames.length >= 1);
  for (const f of layout.frames) assert.ok(f.text.length > 0);
  assert.equal(layout.truncatedChars, 0);
  assert.equal(layout.keptText.length, text.length);
});

test("planArchive: foveation drops oldest dense middle when over budget", () => {
  const high = resolveShape({ provider: "openai", id: "gpt-x" }, "8on16-bw");
  const low = denseCompanion(high, "openai");
  const capHi = geometry(high).capacity;
  const capLo = geometry(low).capacity;
  // Force hiPages > maxFrames and middlePages > middleBudget.
  const text = "a".repeat(capHi * 2 + capHi * 4 + capLo * 10);
  const layout = planArchive(text, high, low, 5);
  // 5 frames total: 2 HQ head/tail edges (min(3, floor(4/2))=2), 1 LQ middle.
  const shapes = layout.frames.map((f) => f.shape === high ? "H" : "L");
  assert.deepEqual(shapes, ["H", "L", "H"]);
  assert.ok(layout.truncatedChars > 0);
  assert.equal(layout.frames.length, 3);
});

test("planArchive: foveation drops oldest dense middle when over budget", () => {
  // 11on16 (13916 cap) as high, its strictly-denser 8on16 companion (19208) as low.
  const high = resolveShape({ provider: "openai", id: "gpt-x" }, "11on16-bw");
  const low = denseCompanion(high, "openai");
  const capHi = geometry(high).capacity;
  const capLo = geometry(low).capacity;
  assert.ok(capLo > capHi);
  // Force hiPages > maxFrames and middlePages > middleBudget.
  const text = "a".repeat(capHi * 2 + capHi * 4 + capLo * 10);
  const layout = planArchive(text, high, low, 3);
  // 3 frames total: 1 HQ edge, 1 LQ middle, 1 HQ tail.
  const shapes = layout.frames.map((f) => (f.shape === high ? "H" : "L"));
  assert.deepEqual(shapes, ["H", "L", "H"]);
  assert.ok(layout.truncatedChars > 0);
  assert.equal(layout.frames.length, 3);
});

test("resolveShape: provider and model-line selection", () => {
  // Anthropic opus 4.8: high-res.
  const opus = resolveShape({ provider: "anthropic", id: "claude-opus-4-8" });
  assert.equal(opus.variant, "bw");
  assert.equal(opus.cellWidth, 11);
  assert.equal(opus.frameSize, 1932);
  // Older claude: standard size.
  const sonnet = resolveShape({ provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.equal(sonnet.frameSize, 1568);
  // Gemini: 2048.
  const gemini = resolveShape({ provider: "google", id: "gemini-3-flash" });
  assert.equal(gemini.cellHeight, 22);
  assert.equal(gemini.frameSize, 2048);
  // OpenAI: 8on22 @1568 with detail original.
  const gpt = resolveShape({ provider: "openai", id: "gpt-5" });
  assert.equal(gpt.cellHeight, 22);
  assert.equal(gpt.frameSize, 1568);
  assert.equal(gpt.imageDetail, "original");
  // Unknown provider: 8on22 @1568.
  const unknown = resolveShape({ provider: "weird-llm", id: "mystery-1" });
  assert.equal(unknown.cellHeight, 22);
  assert.equal(unknown.frameSize, 1568);
  // Explicit variant wins.
  const forced = resolveShape({ provider: "anthropic", id: "claude-opus-4-8" }, "8on22-bw");
  assert.equal(forced.cellWidth, 8);
  assert.equal(forced.frameSize, 1568);
});

test("billing estimates per family", () => {
  const anthropic = resolveShape({ provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.equal(anthropic.frameTokenEstimate, Math.ceil(3136 * 1.05)); // (1568/28)^2
  const gemini = resolveShape({ provider: "google", id: "gemini-3-flash" });
  assert.equal(gemini.frameTokenEstimate, 1120);
  const gpt = resolveShape({ provider: "openai", id: "gpt-5" });
  assert.equal(gpt.frameTokenEstimate, Math.ceil(2401 * 1.2)); // (1568/32)^2
  assert.equal(billingFamily("amazon-bedrock"), "anthropic");
  assert.equal(billingFamily("nope"), "unknown");
});

test("frame data budgets", () => {
  assert.equal(maxFramesForDataBudget(3_000_000), 17);
  assert.equal(maxFramesForDataBudget(0), 1);
});

test("denseCompanion is denser than high", () => {
  const high = resolveShape({ provider: "anthropic", id: "claude-sonnet-4-5" });
  const low = denseCompanion(high, "anthropic");
  assert.ok(geometry(low).capacity > geometry(high).capacity);
  assert.equal(low.frameSize, high.frameSize);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test("computeFileLists: URLs filtered, modified wins over read", () => {
  const ops = createFileOps();
  ops.read.add("/a/b.ts");
  ops.read.add("https://example.com/x");
  ops.edited.add("/a/b.ts"); // read + edited -> RW, not in read list
  ops.written.add("/c/d.ts");
  const { readFiles, modifiedFiles } = computeFileLists(ops);
  assert.deepEqual(readFiles, []);
  assert.deepEqual(modifiedFiles, ["/a/b.ts", "/c/d.ts"]);
});

test("formatGroupedPaths: prefix folding", () => {
  const out = formatGroupedPaths(["/x/y/a.ts", "/x/y/b.ts", "/x/z.ts"]);
  // z.ts sits directly under '# x/'; a.ts/b.ts under the folded '## y/'.
  assert.equal(out, ["# x/", "z.ts", "## y/", "a.ts", "b.ts"].join("\n"));
});

test("formatFileList: R/W markers and grouping", () => {
  const out = formatFileList(["/p/q.ts"], ["/p/r.ts"], new Set(["/p/r.ts"]));
  assert.ok(out.includes("# p/"));
  assert.ok(out.includes("q.ts (Read)"));
  assert.ok(out.includes("r.ts (RW)"));
});

test("upsertFileOperations: replaces stale file tags", () => {
  const old = "summary\n<files>\nstale</files>\n";
  const out = upsertFileOperations(old, ["/n.ts"], [], undefined);
  assert.ok(!out.includes("stale"));
  assert.ok(out.includes("<files>"));
  assert.ok(out.includes("/n.ts (Read)"));
  assert.equal(stripFileOperationTags(out), "summary");
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test("getPreservedArchive: validates and rejects empty", () => {
  assert.equal(getPreservedArchive(undefined), undefined);
  assert.equal(getPreservedArchive({}), undefined);
  assert.equal(getPreservedArchive({ snapcompact: { frames: [] } }), undefined);
  const archive = {
    frames: [
      { data: "AAECAw", mimeType: "image/png", cols: 2, rows: 2, chars: 2 },
      { data: "", mimeType: "image/png", cols: 1, rows: 1, chars: 0 }, // invalid: empty data
    ],
    totalChars: 5,
    truncatedChars: 1,
    text: "keep",
  };
  const out = getPreservedArchive({ snapcompact: archive })!;
  assert.equal(out.frames.length, 1);
  assert.equal(out.totalChars, 5);
  assert.equal(out.text, "keep");
  assert.equal(stripPreservedArchive({ snapcompact: archive, other: 1 })?.other, 1);
  assert.equal(stripPreservedArchive({ snapcompact: archive }), undefined);
});

test("historyBlocks: head, images, tail ordering", () => {
  const archive = {
    frames: [
      { data: "F1F1", mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
      { data: "F2F2", mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
    ],
    totalChars: 10,
    truncatedChars: 0,
    textHead: "HEAD",
    textTail: "TAIL",
  };
  const blocks = historyBlocks(archive);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].type, "text");
  assert.ok((blocks[0] as { text: string }).text.startsWith("HEAD"));
  assert.ok((blocks[0] as { text: string }).text.includes("imaged middle below"));
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[2].type, "image");
  assert.equal(blocks[3].type, "text");
  assert.ok((blocks[3] as { text: string }).text.includes("imaged middle above"));
  assert.ok((blocks[3] as { text: string }).text.endsWith("TAIL"));
});

test("historyBlocks: byte budget omits oldest frames with notice", () => {
  const big = "Z".repeat(150_000);
  const archive = {
    frames: [
      { data: big, mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
      { data: big, mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
      { data: "small", mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
    ],
    totalChars: 3,
    truncatedChars: 0,
  };
  // Budget fits only the newest (small) frame.
  const blocks = historyBlocks(archive, { maxFrameDataBytes: 200 });
  const images = blocks.filter((b) => b.type === "image");
  assert.equal(images.length, 1);
  const notice = blocks.find((b) => b.type === "text") as { text: string };
  assert.ok(notice.text.includes("snapcompact image middle omitted"));
  assert.ok(notice.text.includes("2 archived image frame"));
});

test("archiveSourceText and stripThinkingSections", () => {
  const archive = {
    frames: [],
    totalChars: 0,
    truncatedChars: 0,
    text: `¶user: hi\n\n¶think: secret\n\n¶ai: hello`,
  };
  assert.equal(archiveSourceText(archive), `¶user: hi\n\n¶think: secret\n\n¶ai: hello`);
  // Archive text is normalized: sections are NEWLINE_GLYPH-separated lines.
  const nlText = `¶user: hi${NEWLINE_GLYPH}¶think: secret${NEWLINE_GLYPH}secret continued${NEWLINE_GLYPH}¶ai: hello`;
  const scrubbed = stripThinkingSections(nlText);
  assert.ok(!scrubbed.includes("¶think:"));
  assert.ok(!scrubbed.includes("secret continued"), "thinking continuations are swallowed");
  assert.ok(scrubbed.includes("¶user: hi"));
  assert.ok(scrubbed.includes("¶ai: hello"));
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "@earendil-works/pi-ai";
import {
  snapcompactCompact,
  buildSummaryPrompt,
  type SnapcompactPreparation,
} from "../src/compact.ts";
import { serializeConversation } from "../src/serialize.ts";
import { createFileOps } from "../src/files.ts";
import { getPreservedArchive, historyBlocks } from "../src/archive.ts";
import { geometry, resolveShape } from "../src/shapes.ts";
import { NEWLINE_GLYPH } from "../src/text.ts";
// ---------------------------------------------------------------------------

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMsg(
  blocks: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
): Message {
  return {
    role: "assistant",
    content: blocks,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  } as Message;
}

function toolMsg(toolCallId: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as Message;
}

function prep(messages: Message[], extra?: Partial<SnapcompactPreparation>): SnapcompactPreparation {
  return {
    firstKeptEntryId: "entry-1",
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    tokensBefore: 1000,
    fileOps: createFileOps(),
    ...extra,
  };
}

// Small frame shape so tests render fast.
const FAST = { frameSize: 96, maxFrames: 12 } as const;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

test("serializeConversation: scopes and merged tool calls", () => {
  const text = serializeConversation([
    userMsg("do it"),
    assistantMsg([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "reading" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ]),
    toolMsg("c1", "file body"),
    assistantMsg([{ type: "text", text: "done" }]),
  ]);
  assert.ok(text.startsWith("¶user: do it"));
  assert.ok(text.includes("¶think: hmm"));
  assert.ok(text.includes("¶ai: reading"));
  assert.ok(text.includes("¶call: read(path=\"a.ts\")"));
  assert.ok(text.includes("<out>"));
  assert.ok(text.includes("file body"));
  assert.ok(text.endsWith("¶ai: done"));
});

test("serializeConversation: orphan tool result renders standalone", () => {
  const text = serializeConversation([toolMsg("orphan", "result text")]);
  assert.ok(text.includes("¶call:"));
  assert.ok(text.includes("result text"));
});

test("serializeConversation: thinking excluded on request", () => {
  const text = serializeConversation(
    [assistantMsg([{ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }])],
    { includeThinking: false },
  );
  assert.ok(!text.includes("secret"));
  assert.ok(text.includes("¶ai: hi"));
});

test("serializeConversation: image blocks become markers", () => {
  const msg: Message = {
    role: "user",
    content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
    timestamp: Date.now(),
  } as Message;
  const text = serializeConversation([msg]);
  assert.ok(text.includes("¶user: look"));
  assert.ok(text.includes("[image:image/png]"));
});

test("serializeConversation: tool args and results truncated", () => {
  const big = "x".repeat(5000);
  const text = serializeConversation([
    assistantMsg([{ type: "toolCall", id: "c1", name: "write", arguments: { path: "f", content: big } }]),
    toolMsg("c1", "y".repeat(5000)),
  ]);
  assert.ok(text.includes("ch elided"));
  assert.ok(text.length < 6000);
});

test("serializeConversation: turnPrefixMessages are concatenated", async () => {
  const p = prep([], { turnPrefixMessages: [userMsg("prefix")] });
  const result = await snapcompactCompact(p, FAST);
  assert.ok(result.summary.includes("HISTORY"));
});

// ---------------------------------------------------------------------------
// Summary prompt
// ---------------------------------------------------------------------------

test("buildSummaryPrompt: frames section and file block", () => {
  const s = buildSummaryPrompt({
    frameCount: 3,
    cols: "142 or 196",
    rows: 98,
    truncatedChars: 1234,
    includedPreviousSummary: true,
    files: "# dir/\nfile.ts (Read)",
    includeThinking: false,
  });
  assert.ok(s.includes("Read HISTORY fully"));
  assert.ok(s.includes("`¶user:`, `¶ai:`, `¶call:`"));
  assert.ok(!s.includes("¶think:"));
  assert.ok(s.includes("one grid 142 or 196 characters wide, up to 98 rows tall"));
  assert.ok(s.includes("condensed digest"));
  assert.ok(s.includes("1,234 characters"));
  assert.ok(s.includes("FILES"));
  assert.ok(s.includes("file.ts (Read)"));
  assert.ok(s.endsWith("HISTORY\n==================="));
});

test("buildSummaryPrompt: no frames section when text-only", () => {
  const s = buildSummaryPrompt({
    frameCount: 0,
    cols: "196",
    rows: 98,
    truncatedChars: 0,
    includedPreviousSummary: false,
    files: "",
    includeThinking: true,
  });
  assert.ok(!s.includes("images, not text"));
  assert.ok(s.includes("`¶think:`"));
  assert.ok(s.endsWith("HISTORY\n==================="));
});

// ---------------------------------------------------------------------------
// Full compaction
// ---------------------------------------------------------------------------

test("snapcompactCompact: small window stays text-only", async () => {
  const result = await snapcompactCompact(
    prep([userMsg("hello"), assistantMsg([{ type: "text", text: "hi there" }])]),
    FAST,
  );
  const archive = getPreservedArchive(result.preserveData)!;
  assert.equal(archive.frames.length, 0);
  assert.ok(archive.textHead.includes("¶user: hello"));
  assert.ok(archive.textHead.includes("¶ai: hi there"));
  assert.ok(result.summary.includes("HISTORY"));
  assert.ok(result.summary.includes("196 characters wide") || !result.summary.includes("images, not text"));
  assert.ok(result.shortSummary.includes("Archived"));
  assert.equal(result.firstKeptEntryId, "entry-1");
  assert.equal(result.tokensBefore, 1000);
});

test("snapcompactCompact: large window renders frames and edges", async () => {
  const shape = resolveShape({ provider: "openai", id: "gpt-5" }, "8on16-bw");
  const cap = geometry(shape).capacity;
  const filler = "lorem ipsum dolor sit amet ".repeat(30);
  const messages: Message[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push(userMsg(`message ${i} ${filler}`));
    messages.push(assistantMsg([{ type: "text", text: `reply ${i} ${filler}` }]));
  }
  const fileOps = createFileOps();
  fileOps.read.add("/src/a.ts");
  fileOps.edited.add("/src/b.ts");
  const result = await snapcompactCompact(prep(messages, { fileOps }), FAST);
  const archive = getPreservedArchive(result.preserveData)!;
  assert.ok(archive.frames.length > 0, "expected frames");
  for (const frame of archive.frames) {
    assert.ok(frame.data.startsWith("iVBORw0KG"), "frame should be a real PNG payload");
    assert.equal(frame.mimeType, "image/png");
    assert.ok(frame.chars > 0);
  }
  assert.ok(archive.textHead.length > 0);
  assert.ok(archive.textTail.length > 0);
  assert.ok(archive.totalChars >= archive.frames.reduce((s, f) => s + f.chars, 0));
  assert.deepEqual(result.details.readFiles, ["/src/a.ts"]);
  assert.deepEqual(result.details.modifiedFiles, ["/src/b.ts"]);
  assert.ok(result.summary.includes("one grid"));
  assert.ok(result.summary.includes("FILES"));
  assert.ok(result.summary.includes("b.ts (RW)"));
});

test("snapcompactCompact: re-compaction folds previous archive text", async () => {
  const filler = "context sentence number ".repeat(20);
  const first = await snapcompactCompact(
    prep([userMsg(`first ${filler}`), assistantMsg([{ type: "text", text: `answer ${filler}` }])]),
    FAST,
  );
  const firstArchive = getPreservedArchive(first.preserveData)!;
  assert.ok(firstArchive.frames.length > 0, "first pass should produce frames");

  const second = await snapcompactCompact(
    prep([userMsg("second window"), assistantMsg([{ type: "text", text: "second answer" }])], {
      previousPreserveData: first.preserveData,
    }),
    FAST,
  );
  const secondArchive = getPreservedArchive(second.preserveData)!;
  // The first window's text must live on in the new archive source.
  const source = secondArchive.text ?? "";
  assert.ok(source.includes("first context sentence"), "previous archive text preserved");
  assert.ok(source.includes("second window"), "new window appended");
  // Truncation counter carries forward (may be 0 when nothing was dropped).
  assert.ok(secondArchive.truncatedChars >= firstArchive.truncatedChars);
  // Rehydration works on the new archive.
  const blocks = historyBlocks(secondArchive, { maxFrameDataBytes: 3_000_000 });
  assert.ok(blocks.length > 0);
});

test("snapcompactCompact: previous text summary is prepended when no prior archive", async () => {
  const result = await snapcompactCompact(
    prep([userMsg("new")], { previousSummary: "old digest text" }),
    FAST,
  );
  const archive = getPreservedArchive(result.preserveData)!;
  const source = archive.text ?? archive.textHead ?? "";
  assert.ok(source.includes("[Summary of earlier history]"));
  assert.ok(source.includes("old digest text"));
  assert.ok(result.summary.includes("condensed digest"));
});

test("snapcompactCompact: includeThinking false scrubs prior thinking", async () => {
  const filler = "reasoning content here ".repeat(15);
  const first = await snapcompactCompact(
    prep([assistantMsg([{ type: "thinking", thinking: `TOPSECRET ${filler}` }, { type: "text", text: "visible" }])]),
    FAST,
  );
  const second = await snapcompactCompact(
    prep([userMsg("next")], { previousPreserveData: first.preserveData }),
    { ...FAST, includeThinking: false },
  );
  const archive = getPreservedArchive(second.preserveData)!;
  const source = archive.text ?? "";
  assert.ok(!source.includes("TOPSECRET"), "thinking scrubbed from folded archive");
});

test("snapcompactCompact: data URLs are elided from the archive", async () => {
  const url = `data:image/png;base64,${"D".repeat(200)}`;
  const result = await snapcompactCompact(
    prep([userMsg(`saw ${url} in output`)]),
    FAST,
  );
  const archive = getPreservedArchive(result.preserveData)!;
  const source = archive.text ?? "";
  assert.ok(source.includes("[data URL omitted: image/png, 200 base64 chars]"));
  assert.ok(!source.includes("DDDD"));
});

test("snapcompactCompact: abort signal stops the pass", async () => {
  const controller = new AbortController();
  const filler = "padding words ".repeat(40);
  const messages: Message[] = [];
  for (let i = 0; i < 8; i++) messages.push(userMsg(`m${i} ${filler}`));
  controller.abort();
  await assert.rejects(
    snapcompactCompact(prep(messages), { ...FAST, signal: controller.signal }),
    /aborted/,
  );
});

test("snapcompactCompact: no prior history produces the minimal summary", async () => {
  const result = await snapcompactCompact(prep([]), FAST);
  assert.equal(result.summary, "No prior history.");
});

test("snapcompactCompact: NEWLINE_GLYPH separators between folded windows", async () => {
  const filler = "join marker text ".repeat(12);
  const first = await snapcompactCompact(
    prep([userMsg(`alpha ${filler}`), assistantMsg([{ type: "text", text: `beta ${filler}` }])]),
    FAST,
  );
  const second = await snapcompactCompact(
    prep([userMsg(`gamma ${filler}`)], { previousPreserveData: first.preserveData }),
    FAST,
  );
  const source = (getPreservedArchive(second.preserveData) as { text?: string }).text ?? "";
  assert.ok(source.includes(NEWLINE_GLYPH), "windows separated by newline glyph");
  assert.ok(source.indexOf("alpha") < source.indexOf("gamma"));
});

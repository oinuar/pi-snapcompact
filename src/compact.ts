/**
 * Snapcompact compaction entry point.
 *
 * Ported from @oh-my-pi/snapcompact's `compact()`: serializes the discarded
 * history, folds it into the accumulated archive source text, re-renders that
 * source into a foveated layout (plain text at the oldest edge, imaged middle,
 * plain text at the newest edge), and returns a deterministic summary that
 * teaches the model how to read the frames.
 *
 * The summary prompt is built directly in JavaScript - no template engine.
 */
import type { Message } from "@earendil-works/pi-ai";
import {
  type Archive,
  type Frame,
  getPreservedArchive,
  stripProviderCompactionPreserveData,
  stripThinkingSections,
} from "./archive.ts";
import { type CompactionFileDetails, type FileOperations, computeFileLists, formatFileList } from "./files.ts";
import { planArchive } from "./layout.ts";
import { DIM_ON, DIM_OFF, NEWLINE_GLYPH, elideDataUrls, normalize } from "./text.ts";
import { renderFrame } from "./render.ts";
import { serializeConversation, type SerializeOptions } from "./serialize.ts";
import {
  type Shape,
  type ShapeTarget,
  type ShapeVariantName,
  MAX_FRAMES_DEFAULT,
  denseCompanion,
  geometry,
  resolveShape,
} from "./shapes.ts";

/** File operations extracted by the host (same shape as pi's `FileOperations`). */
export type { FileOperations, CompactionFileDetails };

/**
 * Prepared compaction input. `messagesToSummarize` / `turnPrefixMessages` are
 * already LLM-converted (pi-ai `Message[]`); the extension converts pi's
 * `AgentMessage[]` with `convertToLlm` before calling in, so this module
 * stays free of pi runtime imports.
 */
export interface SnapcompactPreparation {
  /** UUID of first entry to keep. */
  firstKeptEntryId: string;
  /** Messages that will be archived and discarded. */
  messagesToSummarize: Message[];
  /** Messages archived as the split-turn prefix, if any. */
  turnPrefixMessages: Message[];
  tokensBefore: number;
  /** Summary from a previous text-based compaction, for continuity when no
   *  prior snapcompact archive exists. */
  previousSummary?: string;
  /** Preserved opaque compaction payload from the previous compaction. */
  previousPreserveData?: Record<string, unknown>;
  /** File operations extracted from the archived messages. */
  fileOps: FileOperations;
}

export interface SnapcompactOptions extends SerializeOptions {
  /** Model whose provider and id select the frame shape. */
  model?: ShapeTarget;
  /** Explicit shape variant override; wins over `model`. */
  variant?: ShapeVariantName | "auto";
  /** Frame edge in pixels; defaults to the shape's own size. */
  frameSize?: number;
  /** Upper limit on archive frames (never raises OMP's default cap). */
  maxFrames?: number;
  /** Abort signal checked between frames. */
  signal?: AbortSignal;
}

export interface SnapcompactResult {
  summary: string;
  shortSummary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: CompactionFileDetails;
  /** Preserve-data bag: `{ snapcompact: archive, …carried keys }`. */
  preserveData: Record<string, unknown>;
}

// ============================================================================
// Summary prompt (built directly, no templating)
// ============================================================================

interface SummaryPromptInput {
  frameCount: number;
  cols: string;
  rows: number;
  truncatedChars: number;
  includedPreviousSummary: boolean;
  files: string;
  includeThinking: boolean;
}

/**
 * Build the compaction summary text. It ends with the `HISTORY` header so
 * the rehydrated archive blocks (text edges + frames) continue it directly.
 */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const lines: string[] = [];
  lines.push(
    "Resume prior conversation. Earlier turns archived under HISTORY below, oldest→newest. Read HISTORY fully; continue the live conversation following it.",
  );
  lines.push("");
  lines.push("Archived transcript scopes:");
  lines.push(
    input.includeThinking
      ? "- `¶user:`, `¶think:`, `¶ai:`, `¶call:`: user, assistant reasoning, assistant reply, tool call."
      : "- `¶user:`, `¶ai:`, `¶call:`: user, assistant reply, tool call.",
  );
  lines.push("- Unprefixed following lines: current scope. Consecutive same-kind blocks omit repeated prefix.");
  lines.push("- Tool call: `¶call:name(args)`; `<out>…</out>`: tool output.");
  lines.push("");
  lines.push("Reading HISTORY:");
  lines.push("- Plain text: verbatim transcript; rely on it exactly.");
  if (input.frameCount > 0) {
    lines.push(
      "- Some middle sections: images, not text. Each image: one page of that transcript, in reading order between marked delimiters. Solid black cell: newline; runs of spaces collapse to one.",
    );
    lines.push(
      `  - Frame: one grid ${input.cols} characters wide, up to ${input.rows} rows tall; read left→right, top→bottom. No word wrap; words may break across rows.`,
    );
  }
  if (input.includedPreviousSummary) {
    lines.push("- HISTORY opens with a condensed digest of still-older context predating archived turns.");
  }
  if (input.truncatedChars > 0) {
    lines.push(`- About ${input.truncatedChars.toLocaleString()} characters of older middle history dropped to fit archive budget.`);
  }
  lines.push(
    "- If an exact earlier detail matters and a section is unclear, re-derive from workspace (re-read files, re-run commands), rather than guess.",
  );
  if (input.files.length > 0) {
    lines.push("");
    lines.push("FILES");
    lines.push("===================");
    lines.push(input.files);
    lines.push("");
  }
  lines.push("HISTORY");
  lines.push("===================");
  return lines.join("\n");
}

// ============================================================================
// Compaction
// ============================================================================

/**
 * Run a snapcompact compaction over prepared messages. Fully local: no LLM
 * call, no API key - serialization plus deterministic frame rendering.
 */
export async function snapcompactCompact(
  preparation: SnapcompactPreparation,
  options?: SnapcompactOptions,
): Promise<SnapcompactResult> {
  const { firstKeptEntryId, tokensBefore, previousSummary, previousPreserveData, fileOps } = preparation;
  if (!firstKeptEntryId) {
    throw new Error("First kept entry has no ID - session may need migration");
  }

  const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
  const serialized = serializeConversation(messages, options);
  const previousArchive = getPreservedArchive(previousPreserveData);
  const previousTextRaw =
    previousArchive?.text ??
    [previousArchive?.textHead, previousArchive?.textTail]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(NEWLINE_GLYPH);
  // Heal data URLs that pre-guard slices cut at any offset; scrub thinking
  // sections when this compaction excludes them (Claude-dialect safety).
  const previousTextHealed = elideDataUrls(previousTextRaw, "archive");
  const previousText =
    options?.includeThinking === false && previousTextHealed.length > 0
      ? stripThinkingSections(previousTextHealed)
      : previousTextHealed;
  const hasPreviousText = previousText.length > 0;
  const includedPreviousSummary = !hasPreviousText && !!previousSummary;

  const baseShape = resolveShape(options?.model, options?.variant);
  const frameSize = options?.frameSize ?? baseShape.frameSize;
  const high: Shape = frameSize === baseShape.frameSize ? baseShape : { ...baseShape, frameSize };
  const low = denseCompanion(high, options?.model?.provider);
  const geo = geometry(high);
  const maxFrames = Math.max(1, Math.min(options?.maxFrames ?? MAX_FRAMES_DEFAULT, MAX_FRAMES_DEFAULT));

  let archiveText = normalize(serialized);

  if (includedPreviousSummary && previousSummary) {
    const head = `[Summary of earlier history] ${normalize(previousSummary)}`;
    archiveText = archiveText.length > 0 ? `${head} [Recent conversation] ${archiveText}` : head;
  }

  let truncatedChars = previousArchive?.truncatedChars ?? 0;

  // Re-compacting a snapcompacted history unfolds the prior archive's source
  // text and treats it as one coherent transcript: the previous kept source
  // ages in ahead of the new history, then the whole thing is re-rendered.
  if (hasPreviousText) {
    archiveText = archiveText.length > 0 ? `${previousText}${NEWLINE_GLYPH}${archiveText}` : previousText;
  }
  // Data URLs must never reach planArchive: its edge slices are structure-
  // blind, and a split payload replays as broken image input on every later
  // request.
  archiveText = elideDataUrls(archiveText);

  const layout = planArchive(archiveText, high, low, maxFrames);
  truncatedChars += layout.truncatedChars;

  // Re-render the planned frames, carrying any open dim span across every
  // boundary: textHead → frames → textTail.
  let dimOpen = layout.textHead.lastIndexOf(DIM_ON) > layout.textHead.lastIndexOf(DIM_OFF);
  const frames: Frame[] = [];
  for (const planned of layout.frames) {
    if (options?.signal?.aborted) throw new Error("snapcompact aborted");
    let pageText: string = dimOpen ? DIM_ON + planned.text : planned.text;
    dimOpen = pageText.lastIndexOf(DIM_ON) > pageText.lastIndexOf(DIM_OFF);
    const rendered = renderFrame(pageText, planned.shape, planned.shape.frameSize, false);
    frames.push({
      data: rendered.data,
      mimeType: "image/png",
      cols: rendered.cols,
      rows: rendered.rows,
      chars: rendered.chars,
      font: planned.shape.font,
      variant: planned.shape.variant,
      ...(planned.shape.imageDetail ? { detail: planned.shape.imageDetail } : {}),
    });
  }

  const textHead = layout.textHead;
  const textTail = layout.textTail.length > 0 ? (dimOpen ? DIM_ON : "") + layout.textTail : "";
  const textChars = textHead.length + textTail.length;

  const totalChars = frames.reduce((sum, frame) => sum + frame.chars, 0) + textChars;
  const frameCols: number[] = [];
  for (const frame of frames) {
    if (!frameCols.includes(frame.cols)) frameCols.push(frame.cols);
  }
  const summaryCols = frameCols.length > 0 ? frameCols.join(" or ") : String(geo.cols);

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  // Edited files were read to be edited: union read+edited so they are
  // marked RW in the file list, while blind writes stay Write.
  const readSet = new Set([...fileOps.read, ...fileOps.edited]);
  const files = formatFileList(readFiles, modifiedFiles, readSet);

  let summary: string;
  if (frames.length === 0 && textHead.length === 0 && textTail.length === 0 && files.length === 0) {
    summary = "No prior history.";
  } else {
    summary = buildSummaryPrompt({
      frameCount: frames.length,
      cols: summaryCols,
      rows: geo.rows,
      truncatedChars,
      includedPreviousSummary,
      files,
      includeThinking: options?.includeThinking !== false,
    });
  }

  // A snapcompact pass replaces any provider-side compaction payload.
  const basePreserve = stripProviderCompactionPreserveData(previousPreserveData) ?? {};
  const persistedText =
    layout.keptText.length > 0 && layout.textTail.length > 0
      ? `${layout.keptText.slice(0, layout.keptText.length - layout.textTail.length)}${textTail}`
      : layout.keptText;
  const archive: Archive = {
    frames,
    totalChars,
    truncatedChars,
    ...(persistedText.length > 0 ? { text: persistedText } : {}),
    ...(textHead ? { textHead } : {}),
    ...(textTail ? { textTail } : {}),
  };

  const textNote = textChars > 0 ? ` (+${textChars.toLocaleString()} chars as text)` : "";
  return {
    summary,
    shortSummary: `Archived ${totalChars.toLocaleString()} chars of history onto ${frames.length} snapcompact frame${
      frames.length === 1 ? "" : "s"
    }${textNote}`,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles },
    preserveData: { ...basePreserve, snapcompact: archive },
  };
}

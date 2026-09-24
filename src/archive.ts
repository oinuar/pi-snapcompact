/**
 * Frame archive: the persisted snapshot and its reconstruction into prompt
 * blocks. Ported from @oh-my-pi/snapcompact, minus the OMP session blob store
 * (this port persists base64 directly in the compaction entry's details).
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Shape } from "./shapes.ts";
import { NEWLINE_GLYPH, elideDataUrls, toPlainText } from "./text.ts";

/** One developed snapcompact frame: a base64 PNG plus its reading geometry. */
export interface Frame {
  /** Base64-encoded PNG. */
  data: string;
  mimeType: string;
  /** Characters per row in the frame grid. */
  cols: number;
  /** Text rows in the frame grid. */
  rows: number;
  /** Characters actually printed onto this frame. */
  chars: number;
  /** Shape metadata (absent on very old frames). */
  font?: Shape["font"];
  variant?: Shape["variant"];
  /** 2 on two-column doc frames; absent on grid frames. */
  columns?: number;
  /** True when stopwords were printed in dim ink. */
  stopwordDim?: boolean;
  /** Resolution hint forwarded to the provider when re-attaching. */
  detail?: ImageContent["detail"];
}

/** Frame archive persisted under the compaction entry's details. */
export interface Archive {
  /** Rendered frames ordered oldest to newest. May be empty when the whole
   *  archive fits in text. */
  frames: Frame[];
  /** Characters currently readable across all frames plus the text regions. */
  totalChars: number;
  /** Characters dropped so far to respect the archive budget. */
  truncatedChars: number;
  /** Full kept archive source (oldest to newest, normalized, bounded to the
   *  rendered budget) - the single source re-rendered each compaction. */
  text?: string;
  /** Oldest text region kept verbatim around the imaged middle. */
  textHead?: string;
  /** Newest text region kept verbatim around the imaged middle. */
  textTail?: string;
}

/**
 * Options for reconstructing a persisted snapcompact archive into prompt
 * blocks.
 */
export interface HistoryBlockOptions {
  /** Hard cap on image base64 bytes attached to one rebuilt provider request. */
  maxFrameDataBytes?: number;
}

/** Validate and extract a persisted frame archive from a preserve-data bag. */
export function getPreservedArchive(preserveData: Record<string, unknown> | undefined): Archive | undefined {
  const candidate = preserveData?.["snapcompact"];
  if (!candidate || typeof candidate !== "object") return undefined;
  const archive = candidate as Archive;
  const frames = Array.isArray(archive.frames)
    ? archive.frames.filter(
        (frame) =>
          !!frame &&
          typeof frame.data === "string" &&
          frame.data.length > 0 &&
          typeof frame.mimeType === "string" &&
          typeof frame.cols === "number" &&
          typeof frame.rows === "number" &&
          typeof frame.chars === "number",
      )
    : [];
  const text = typeof archive.text === "string" && archive.text.length > 0 ? archive.text : undefined;
  const textHead = typeof archive.textHead === "string" && archive.textHead.length > 0 ? archive.textHead : undefined;
  const textTail = typeof archive.textTail === "string" && archive.textTail.length > 0 ? archive.textTail : undefined;
  // A text-only archive is valid; only an archive carrying neither frames nor
  // text is empty.
  if (frames.length === 0 && text === undefined && textHead === undefined && textTail === undefined) return undefined;
  return {
    frames,
    totalChars: typeof archive.totalChars === "number" ? archive.totalChars : 0,
    truncatedChars: typeof archive.truncatedChars === "number" ? archive.truncatedChars : 0,
    ...(text !== undefined ? { text } : {}),
    ...(textHead !== undefined ? { textHead } : {}),
    ...(textTail !== undefined ? { textTail } : {}),
  };
}

/** Drop the persisted frame archive from a preserve-data bag. */
export function stripPreservedArchive(preserveData: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!preserveData || !("snapcompact" in preserveData)) return preserveData;
  const { snapcompact: _removed, ...rest } = preserveData;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Provider-native compaction payloads a snapcompact pass supersedes. */
const PROVIDER_COMPACTION_PRESERVE_KEYS = ["openaiRemoteCompaction", "anthropicCompaction"] as const;

export function stripProviderCompactionPreserveData(
  preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!preserveData || !PROVIDER_COMPACTION_PRESERVE_KEYS.some((key) => key in preserveData)) {
    return preserveData;
  }
  const { openaiRemoteCompaction: _openai, anthropicCompaction: _anthropic, ...rest } = preserveData;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Extract persisted archive source text as plain text. */
export function archiveSourceText(archive: Archive): string | undefined {
  const text =
    archive.text ??
    [archive.textHead, archive.textTail]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(NEWLINE_GLYPH);
  return text.length > 0 ? elideDataUrls(toPlainText(text), "archive") : undefined;
}

/** Build the text used to choose and preflight a font-aware snapcompact shape. */
export function renderabilityProbeText(
  serialized: string,
  previousPreserveData?: Record<string, unknown>,
  previousSummary?: string,
): string {
  const previousArchive = getPreservedArchive(previousPreserveData);
  const previousText = previousArchive ? (archiveSourceText(previousArchive) ?? "") : "";
  if (previousText.length > 0) return `${previousText}${NEWLINE_GLYPH}${serialized}`;
  if (previousSummary) return `${previousSummary}${NEWLINE_GLYPH}${serialized}`;
  return serialized;
}

/** One archive transcript line starting a new scope section. */
const SCOPE_LINE = /^¶(?:user|think|ai|call):/;

/**
 * Drop `¶think:` sections from archive source text.
 *
 * Archives may carry reasoning sections that must not be replayed to
 * Anthropic-dialect models (their reasoning-extraction classifier rejects the
 * request). Re-compaction re-renders the whole unfolded source, so scrubbing
 * the prior text heals a poisoned session at its next compaction.
 *
 * Archive text is normalized: every original line is one NEWLINE_GLYPH-
 * separated segment, and a section's continuation lines follow its scope
 * line. A dropped `¶think:` line also swallows its continuations up to the
 * next scope line.
 */
export function stripThinkingSections(text: string): string {
  const out: string[] = [];
  let inThinking = false;
  for (const line of text.split(NEWLINE_GLYPH)) {
    if (SCOPE_LINE.test(line)) {
      inThinking = line.startsWith("¶think:");
      if (!inThinking) out.push(line);
    } else if (!inThinking && line.length > 0) {
      out.push(line);
    }
  }
  return out.join(NEWLINE_GLYPH);
}

/** Convert archive frames into LLM image blocks (oldest first). */
export function images(archive: Archive): ImageContent[] {
  return archive.frames.map((frame) => ({
    type: "image",
    data: frame.data,
    mimeType: frame.mimeType,
    ...(frame.detail ? { detail: frame.detail } : {}),
  }));
}

/** One reconstructed slot: a usable frame or a byte-budget gap. */
type FrameSlot = { frame: Frame } | { omittedBytes: number };

/**
 * Price every frame newest-first and retain only payloads that fit the byte
 * budget. Gap slots preserve the original chronology without materializing
 * rejected payloads.
 */
function imagesWithinBudget(archive: Archive, options: HistoryBlockOptions): FrameSlot[] {
  const { maxFrameDataBytes } = options;
  if (maxFrameDataBytes === undefined) return archive.frames.map((frame) => ({ frame }));

  let usedBytes = 0;
  const newestFirst: FrameSlot[] = [];
  for (let index = archive.frames.length - 1; index >= 0; index--) {
    const frame = archive.frames[index];
    if (!frame) continue;
    const bytes = frame.data.length;
    if (usedBytes + bytes > maxFrameDataBytes) {
      newestFirst.push({ omittedBytes: bytes });
      continue;
    }
    usedBytes += bytes;
    newestFirst.push({ frame });
  }
  newestFirst.reverse();
  return newestFirst;
}

function formatFrameDataBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function omittedFrameNotice(omittedFrames: number, omittedBytes: number): string {
  const budgetNote =
    omittedBytes > 0
      ? ` ${formatFrameDataBytes(omittedBytes)} of base64 exceeded the per-request snapcompact payload budget.`
      : "";
  return [
    "-------------- snapcompact image middle omitted",
    `${omittedFrames.toLocaleString()} archived image frame${omittedFrames === 1 ? "" : "s"} could not be included.${budgetNote} The compacted summary and visible text edges remain available.`,
    "--------------",
  ].join("\n");
}

/** Collapse a run of budget-omitted frames into one in-place gap marker. */
function frameBlocks(slots: FrameSlot[]): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  let pendingFrames = 0;
  let pendingBytes = 0;
  const flushGap = (): void => {
    if (pendingFrames === 0) return;
    blocks.push({ type: "text", text: omittedFrameNotice(pendingFrames, pendingBytes) });
    pendingFrames = 0;
    pendingBytes = 0;
  };
  for (const slot of slots) {
    if ("frame" in slot) {
      flushGap();
      blocks.push(
        ...[
          {
            type: "image",
            data: slot.frame.data,
            mimeType: slot.frame.mimeType,
            ...(slot.frame.detail ? { detail: slot.frame.detail } : {}),
          } as ImageContent,
        ],
      );
      continue;
    }
    pendingFrames++;
    pendingBytes += slot.omittedBytes;
  }
  flushGap();
  return blocks;
}

/**
 * Ordered archive blocks for a compaction summary message, oldest to newest:
 * the oldest text region, the imaged middle, then the newest text region.
 * Runtime-only; reconstructed from the Archive on each context rebuild.
 */
export function historyBlocks(archive: Archive, options: HistoryBlockOptions = {}): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  const middle = frameBlocks(imagesWithinBudget(archive, options));
  const hasImages = middle.some((block) => block.type === "image");
  const hasOmittedImages = middle.some((block) => block.type === "text");
  if (archive.textHead) {
    const suffix = hasImages ? "\n-------------- imaged middle below\n" : "";
    blocks.push({ type: "text", text: elideDataUrls(toPlainText(archive.textHead), "archive") + suffix });
  }
  blocks.push(...middle);
  if (archive.textTail) {
    const prefix = hasImages
      ? "-------------- imaged middle above\n"
      : archive.truncatedChars > 0 || hasOmittedImages
        ? "\n-------------- middle history omitted above\n"
        : "";
    const tail = prefix + elideDataUrls(toPlainText(archive.textTail), "archive");
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock?.type === "text") {
      lastBlock.text += tail;
    } else {
      blocks.push({ type: "text", text: tail });
    }
  }
  return blocks;
}

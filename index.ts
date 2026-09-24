/**
 * pi-snapcompact — standalone snapcompact for native Pi.
 *
 * Replaces Pi's LLM-based context compaction with the deterministic,
 * image-based snapcompact archive: discarded history is serialized, rendered
 * into PNG frames of pixel-font text, and re-attached to the compaction
 * summary on every context rebuild. Vision models read the frames back
 * directly. No LLM call, no API key, no OMP/bun dependencies - the frame
 * renderer is pure JS with the embedded X.Org 8x13 font.
 *
 * Storage: the frame archive lives in the compaction entry's `details` bag
 * under `snapcompact`; `readFiles`/`modifiedFiles` sit alongside it for
 * Pi's own UI.
 *
 * Configuration (environment, read at load):
 * - PI_SNAPCOMPACT_VARIANT       "auto" (default) | "11on16-bw" | "8on16-bw" | "8on22-bw"
 * - PI_SNAPCOMPACT_MAX_FRAMES    max archive frames (default 80)
 * - PI_SNAPCOMPACT_FRAME_BYTES   per-request base64 budget for rehydrated frames (default 3000000)
 * - PI_SNAPCOMPACT_THINKING      "0"/"1" archive assistant reasoning; default: off
 *                                for Anthropic-dialect providers, on otherwise
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message, TextContent, ImageContent } from "@earendil-works/pi-ai";

import {
  snapcompactCompact,
  type SnapcompactPreparation,
  type SnapcompactOptions,
} from "./src/compact.ts";
import {
  getPreservedArchive,
  historyBlocks,
  type Archive,
} from "./src/archive.ts";
import {
  FRAME_DATA_BYTES_BUDGET,
  FRAME_DATA_BYTES_ESTIMATE,
  MAX_FRAMES_DEFAULT,
  billingFamily,
  frameDataBytes,
  isShapeVariantName,
  type ShapeVariantName,
} from "./src/shapes.ts";
interface SnapcompactConfig {
  variant: ShapeVariantName | "auto";
  maxFrames: number;
  frameBytes: number;
  includeThinking: boolean | undefined; // undefined = auto per provider
}

function readConfig(): SnapcompactConfig {
  const variant = process.env.PI_SNAPCOMPACT_VARIANT ?? "auto";
  const maxFrames = Number.parseInt(process.env.PI_SNAPCOMPACT_MAX_FRAMES ?? "", 10);
  const frameBytes = Number.parseInt(process.env.PI_SNAPCOMPACT_FRAME_BYTES ?? "", 10);
  const thinkingRaw = process.env.PI_SNAPCOMPACT_THINKING;
  return {
    variant: isShapeVariantName(variant) ? variant : "auto",
    maxFrames: Number.isFinite(maxFrames) && maxFrames > 0 ? maxFrames : MAX_FRAMES_DEFAULT,
    frameBytes: Number.isFinite(frameBytes) && frameBytes > 0 ? frameBytes : FRAME_DATA_BYTES_BUDGET,
    includeThinking: thinkingRaw === "1" ? true : thinkingRaw === "0" ? false : undefined,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Find the active compaction entry's snapcompact archive (latest first). */
function findArchive(ctx: ExtensionContext): Archive | undefined {
  const entries = ctx.sessionManager.buildContextEntries() as Array<{
    type: string;
    details?: { snapcompact?: unknown };
  }>;
  const compactionEntry = [...entries].reverse().find((e) => e.type === "compaction" && e.details?.snapcompact !== undefined);
  if (!compactionEntry?.details?.snapcompact) return undefined;
  return getPreservedArchive({ snapcompact: compactionEntry.details.snapcompact });
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();

  // ------------------------------------------------------------------
  // 1. Intercept compaction: archive instead of LLM summarization.
  // ------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;

    if (signal.aborted) return; // Let Pi handle cancellation gracefully.
    const model = ctx.model;
    if (!model) return; // Let Pi fall back to default behavior.

    // Gracefully fall back to stock text compaction without vision.
    if (!model.input?.includes("image")) {
      ctx.ui.notify("pi-snapcompact: model has no image input; using stock compaction", "warning");
      return;
    }

    try {
      // Retrieve the previous snapcompact archive so cumulative frames are
      // re-rendered (not lost) on subsequent compactions.
      const previousArchive = findArchive(ctx);
      const previousPreserveData = previousArchive ? { snapcompact: previousArchive } : undefined;

      const llmMessages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);

      const options: SnapcompactOptions = {
        model: { provider: model.provider, id: model.id },
        variant: config.variant,
        maxFrames: config.maxFrames,
        signal,
      };
      if (config.includeThinking !== undefined) {
        options.includeThinking = config.includeThinking;
      } else {
        // Reasoning replayed to Claude trips its reasoning-extraction
        // classifier; keep it out of the archive by default there.
        options.includeThinking = billingFamily(model.provider) !== "anthropic";
      }

      const preparationIn: SnapcompactPreparation = {
        firstKeptEntryId: preparation.firstKeptEntryId,
        messagesToSummarize: llmMessages,
        turnPrefixMessages: [],
        tokensBefore: preparation.tokensBefore,
        previousSummary: preparation.previousSummary,
        previousPreserveData,
        fileOps: preparation.fileOps,
      };

      const t0 = Date.now();
      const result = await snapcompactCompact(preparationIn, options);
      if (signal.aborted) return;

      ctx.ui.notify(
        `pi-snapcompact: ${result.shortSummary} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
        "info",
      );

      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          details: {
            readFiles: result.details.readFiles,
            modifiedFiles: result.details.modifiedFiles,
            snapcompact: result.preserveData["snapcompact"],
          },
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!signal.aborted) {
        console.error("[pi-snapcompact] compaction failed, falling back to stock compaction:", err);
        ctx.ui.notify(`pi-snapcompact: ${message} - using stock compaction`, "error");
      }
      return; // fall back to Pi's default LLM compaction
    }
  });

  // ------------------------------------------------------------------
  // 2. Rehydrate context: attach archived frames to the compaction summary.
  // ------------------------------------------------------------------
  pi.on("context", (event, ctx) => {
    const messages = event.messages;
    const compactionIdx = messages.findIndex((m) => m.role === "compactionSummary");
    if (compactionIdx === -1) return;

    const model = ctx.model;
    if (!model?.input?.includes("image")) return;

    const archive = findArchive(ctx);
    if (!archive) return;

    try {
      const blocks = historyBlocks(archive, { maxFrameDataBytes: config.frameBytes });
      if (blocks.length === 0) return;

      const compactionMsg = messages[compactionIdx] as { timestamp: number };
      // Inject a hidden custom message right after the compaction summary.
      // Pi's convertToLlm turns role "custom" into a provider user message,
      // and display:false keeps it out of the terminal transcript.
      const imageMessage = {
        role: "custom",
        customType: "pi-snapcompact-frames",
        content: blocks,
        display: false,
        timestamp: compactionMsg.timestamp + 1,
      } as (typeof messages)[number];

      return {
        messages: [
          ...messages.slice(0, compactionIdx + 1),
          imageMessage,
          ...messages.slice(compactionIdx + 1),
        ],
      };
    } catch (err) {
      console.error("[pi-snapcompact] failed to rehydrate archive:", err);
      return;
    }
  });

  // ------------------------------------------------------------------
  // 3. /snapcompact: show archive status.
  // ------------------------------------------------------------------
  pi.registerCommand("snapcompact", {
    description: "Show the snapcompact archive status (frames, size, truncation)",
    handler: async (_args, ctx) => {
      const archive = findArchive(ctx);
      if (!archive) {
        ctx.ui.notify("pi-snapcompact: no snapcompacted archive in the current context", "info");
        return;
      }
      const frames = archive.frames.length;
      const bytes = frameDataBytes(archive.frames);
      const perRequestCap = Math.min(frames, Math.floor(config.frameBytes / FRAME_DATA_BYTES_ESTIMATE));
      ctx.ui.notify(
        `pi-snapcompact: ${frames} frame${frames === 1 ? "" : "s"} (${formatBytes(bytes)} base64` +
          `${frames > 0 ? `, ~${perRequestCap} per request` : ""}), ` +
          `${archive.totalChars.toLocaleString()} chars archived, ` +
          `${archive.truncatedChars.toLocaleString()} chars truncated`,
        "info",
      );
    },
  });
}

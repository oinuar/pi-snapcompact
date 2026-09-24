/**
 * Frame shapes, provider billing, and budgets.
 *
 * Ported from @oh-my-pi/snapcompact with the shape table narrowed to the
 * variants this standalone renderer implements: 8x13-font grid frames in
 * black ink (`bw`), no stretch, single line copy. The eval-winning shape per
 * provider family and the per-model-line frame sizes are unchanged, so
 * default sessions render exactly the frames OMP would have chosen.
 */

import type { Frame } from "./archive.ts";

/** One frame shape: font, cell pitch, ink, and size. */
export interface Shape {
  font: "8x13";
  /** Target cell advance in pixels (glyph is drawn at natural 8px width). */
  cellWidth: number;
  /** Target cell pitch in pixels (glyph is drawn at natural 13px height). */
  cellHeight: number;
  /** `bw` is black ink (the only variant this renderer implements). */
  variant: "bw";
  /** Frame edge in pixels. */
  frameSize: number;
  /** Per-frame billed-token estimate for the shape's target provider. */
  frameTokenEstimate: number;
  /** Resolution hint attached to frame images (OpenAI-only). */
  imageDetail?: "auto" | "low" | "high" | "original";
}

/** Geometry of a frame: grid capacity at a given frame size. */
export interface Geometry {
  /** Characters per row. */
  cols: number;
  /** Text rows per frame. */
  rows: number;
  /** Characters that fit one frame. */
  capacity: number;
}

const base = (cellWidth: number, cellHeight: number, frameSize: number): Omit<Shape, "frameTokenEstimate"> => ({
  font: "8x13",
  cellWidth,
  cellHeight,
  variant: "bw",
  frameSize,
});

/**
 * Frame variants this port implements. Names and geometry match OMP's
 * `SHAPE_VARIANTS` so archives written by either stay readable.
 */
export const SHAPE_VARIANTS = {
  /** 8x13 glyphs on an 11px advance (extra tracking), black ink. Anthropic winner. */
  "11on16-bw": base(11, 16, 1568),
  /** 8x13 glyphs on an 8x16 cell pitch (no stretch, extra leading). Dense tier. */
  "8on16-bw": base(8, 16, 1568),
  /** 8x13 glyphs on an 8x22 cell pitch (extra leading). Google/OpenAI winner. */
  "8on22-bw": base(8, 22, 1568),
} as const;

export type ShapeVariantName = keyof typeof SHAPE_VARIANTS;

export const SHAPE_VARIANT_NAMES = Object.keys(SHAPE_VARIANTS) as ShapeVariantName[];

export function isShapeVariantName(value: unknown): value is ShapeVariantName {
  return typeof value === "string" && value in SHAPE_VARIANTS;
}

/** Runtime guard for shapes loaded from config or persisted frames. */
export function isShape(value: unknown): value is Shape {
  if (!value || typeof value !== "object") return false;
  const shape = value as Record<string, unknown>;
  return (
    shape.font === "8x13" &&
    typeof shape.cellWidth === "number" &&
    shape.cellWidth > 0 &&
    typeof shape.cellHeight === "number" &&
    shape.cellHeight > 0 &&
    shape.variant === "bw" &&
    typeof shape.frameSize === "number" &&
    shape.frameSize > 0 &&
    typeof shape.frameTokenEstimate === "number" &&
    shape.frameTokenEstimate > 0 &&
    (shape.imageDetail === undefined || shape.imageDetail === "auto" || shape.imageDetail === "low" ||
      shape.imageDetail === "high" || shape.imageDetail === "original")
  );
}

/** Provider families with distinct image billing. */
type BillingFamily = "anthropic" | "google" | "openai" | "unknown";

/** Provider ids carried by pi models, mapped to a billing family. */
const FAMILY_BY_PROVIDER: Record<string, BillingFamily> = {
  anthropic: "anthropic",
  "amazon-bedrock": "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  azure: "openai",
  google: "google",
  "google-vertex": "google",
  "google-gemini-cli": "google",
};

/** Billing family for a pi `Model` (provider id drives pricing through the gateway). */
export function billingFamily(provider: string | undefined): BillingFamily {
  if (!provider) return "unknown";
  return FAMILY_BY_PROVIDER[provider] ?? (provider.includes("anthropic") || provider.includes("bedrock") ? "anthropic" : "unknown");
}

/**
 * Per-frame billing for a square frame of edge `frameSize`, by family.
 * Formulas ported from OMP (verified against live bills in their benchmarks):
 * - Anthropic: 28px patches capped at 4,784 visual tokens + 5% margin.
 * - Google: fixed 1,120-token `media_resolution` budget per image.
 * - OpenAI: 32px patches x 1.2 flagship multiplier, 10,000-patch budget.
 */
function familyBilling(family: BillingFamily, frameSize: number): Pick<Shape, "frameTokenEstimate" | "imageDetail"> {
  switch (family) {
    case "google":
      return { frameTokenEstimate: 1120 };
    case "openai": {
      const patches = Math.min(Math.ceil(frameSize / 32) ** 2, 10_000);
      return { frameTokenEstimate: Math.ceil(patches * 1.2), imageDetail: "original" };
    }
    default: {
      const patches = Math.min(Math.ceil(frameSize / 28) ** 2, 4784);
      return { frameTokenEstimate: Math.ceil(patches * 1.05) };
    }
  }
}

/** Attach a provider family's billing to a variant geometry. */
function priceShape(variant: ShapeVariantName, frameSize: number, family: BillingFamily): Shape {
  return { ...SHAPE_VARIANTS[variant], frameSize, ...familyBilling(family, frameSize) };
}

/** Eval-winning variant per provider family. */
const FAMILY_VARIANT: Record<BillingFamily, ShapeVariantName> = {
  anthropic: "11on16-bw",
  google: "8on22-bw",
  openai: "8on22-bw",
  unknown: "8on22-bw",
};

/** Denser companion variant per family for the foveated archive middle. */
const FAMILY_VARIANT_LOW: Record<BillingFamily, ShapeVariantName> = {
  anthropic: "8on16-bw",
  google: "8on16-bw",
  openai: "8on16-bw",
  unknown: "8on16-bw",
};

/**
 * What selects the shape: the provider (billing family) and the model id
 * (model-line frame size). Accepts a full pi `Model` or any subset.
 */
export interface ShapeTarget {
  provider?: string;
  id?: string;
}

/**
 * Lightweight replacement for OMP's catalog classifier: the only catalog fact
 * snapcompact needs is whether a Claude line reads high-res frames natively
 * (Opus 4.7+, Fable, Mythos). Everything else is first-match on the id.
 */
function idealForModelId(modelId: string): { variant: ShapeVariantName; frameSize?: number } | undefined {
  if (/claude.*(fable|mythos)/i.test(modelId)) return { variant: "11on16-bw", frameSize: 1932 };
  if (/claude/i.test(modelId)) {
    // Opus 4.7+ reads high-res natively: 1932 is the largest square not
    // downscaled under Anthropic's 4,784 visual-token patch cap.
    const m = modelId.match(/opus[-\s]?(\d+)(?:[-.](\d+))?/i);
    if (m) {
      const major = Number(m[1]);
      const minor = m[2] !== undefined ? Number(m[2]) : 0;
      if (major > 4 || (major === 4 && minor >= 7)) return { variant: "11on16-bw", frameSize: 1932 };
    }
    return { variant: "11on16-bw" };
  }
  // Gemini bills a fixed per-image budget: 2048px packs more chars per frame.
  if (/gemini/i.test(modelId)) return { variant: "8on22-bw", frameSize: 2048 };
  if (/gpt|codex/i.test(modelId)) return { variant: "8on22-bw" };
  if (/kimi/i.test(modelId)) return { variant: "8on22-bw" };
  if (/glm/i.test(modelId)) return { variant: "8on16-bw" };
  return undefined;
}

/**
 * Pick the frame shape for a reader. An explicit `variant` (anything but
 * `"auto"`) forces that geometry; otherwise the model id selects the
 * eval-winning shape and frame size, falling back to the family winner.
 * Billing always follows the provider family carrying the request.
 */
export function resolveShape(model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
  const family = billingFamily(model?.provider);
  if (variant && variant !== "auto") return priceShape(variant, SHAPE_VARIANTS[variant].frameSize, family);
  const ideal = model?.id ? idealForModelId(model.id) : undefined;
  const name = ideal?.variant ?? FAMILY_VARIANT[family];
  return priceShape(name, ideal?.frameSize ?? SHAPE_VARIANTS[name].frameSize, family);
}

/** Denser (or equally dense) companion of `high` for the foveated middle:
 *  same family/frame size (identical per-frame bill) but at least the same
 *  cell density. Always a distinct object so the middle tier stays
 *  distinguishable from the HQ edges. */
export function denseCompanion(high: Shape, provider: string | undefined): Shape {
  const family = billingFamily(provider);
  const low = priceShape(FAMILY_VARIANT_LOW[family], high.frameSize, family);
  return geometry(low).capacity >= geometry(high).capacity ? low : high;
}

/** Grid geometry for a shape at a frame size (default: the shape's own). */
export function geometry(shape: Shape, size: number = shape.frameSize): Geometry {
  const cols = Math.floor(size / shape.cellWidth);
  const rows = Math.floor(size / shape.cellHeight);
  return { cols, rows, capacity: cols * rows };
}

// ============================================================================
// Budgets
// ============================================================================

/** Default upper bound on archive frames carried per compaction. */
export const MAX_FRAMES_DEFAULT = 80;

/** HQ edge frames at each chronological edge of a foveated archive. */
export const HQ_EDGE_FRAMES = 3;

/** Conservative per-frame token estimate for context budgeting (high-res cap). */
export const FRAME_TOKEN_ESTIMATE = 5024;

/** Conservative upper bound for one persisted frame's base64 payload. */
export const FRAME_DATA_BYTES_ESTIMATE = 170_000;

/**
 * Maximum snapcompact image base64 carried in every rebuilt provider request.
 * Above this, provider backends can accept the HTTP body but fail mid-stream.
 */
export const FRAME_DATA_BYTES_BUDGET = 3_000_000;

/** Frame-count cap implied by the payload budget. */
export function maxFramesForDataBudget(maxFrameDataBytes: number = FRAME_DATA_BYTES_BUDGET): number {
  return Math.max(1, Math.floor(maxFrameDataBytes / FRAME_DATA_BYTES_ESTIMATE));
}

/** Base64 byte length of persisted snapcompact frames. */
export function frameDataBytes(frames: readonly Pick<Frame, "data">[]): number {
  return frames.reduce((sum, frame) => sum + frame.data.length, 0);
}

/** Key under the compaction `details` bag holding the frame archive. */
export const PRESERVE_KEY = "snapcompact";

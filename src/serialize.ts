/**
 * Serialize a conversation window into the snapcompact archive format:
 *
 *   ¶user: … / ¶think: … / ¶ai: … / ¶call: name(args) + <out>…</out>
 *
 * Ported from @oh-my-pi/snapcompact's `serializeConversation`, adapted to pi's
 * message types (via `convertToLlm`). Differences from OMP:
 * - no `useless` tool-result flag and no `intent` field (pi has neither);
 * - image blocks (user attachments, image tool results) print as
 *   `[image:<mime>]` markers instead of being dropped silently.
 */
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { DIM_ON, DIM_OFF, elideDataUrls, stripDimMarkers, truncateForSummary } from "./text.ts";

/** Default per-tool-result character cap in serialized history. */
export const TOOL_RESULT_MAX_CHARS = 2000;
/** Default per-argument-value character cap inside serialized tool calls. */
export const TOOL_ARG_MAX_CHARS = 500;
/** Default character cap across one tool call's full serialized argument list. */
export const TOOL_CALL_MAX_CHARS = 2000;
/** Default fraction of a truncation budget spent on the head. */
export const TRUNCATE_HEAD_RATIO = 0.6;

/** Character budgets applied while serializing discarded history. */
export interface SerializeOptions {
  /** Per-tool-result cap. Defaults to {@link TOOL_RESULT_MAX_CHARS}. */
  toolResultMaxChars?: number;
  /** Per-argument-value cap. Defaults to {@link TOOL_ARG_MAX_CHARS}. */
  toolArgMaxChars?: number;
  /** Whole-argument-list cap per call. Defaults to {@link TOOL_CALL_MAX_CHARS}. */
  toolCallMaxChars?: number;
  /** Head share of each budget, clamped to [0, 1]. Defaults to {@link TRUNCATE_HEAD_RATIO}. */
  truncateHeadRatio?: number;
  /** Print tool-result text in dim gray ink so archived conversation reads
   *  louder than archived tool noise. Defaults to `true`. */
  dimToolResults?: boolean;
  /** Serialize assistant reasoning as `¶think:` sections. Defaults to `true`.
   *  Callers archiving for an Anthropic-dialect model set this `false`:
   *  reasoning replayed back to Claude trips its reasoning-extraction
   *  classifier. */
  includeThinking?: boolean;
}

function textOf(content: string | (TextContent | ImageContent)[]): { text: string; imageMarkers: string[] } {
  if (typeof content === "string") return { text: content, imageMarkers: [] };
  const text = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
  const imageMarkers = content
    .filter((block): block is ImageContent => block.type === "image")
    .map((block) => `[image:${block.mimeType}]`);
  return { text, imageMarkers };
}

/**
 * Serialize messages into the ¶-scoped archive transcript. Consecutive
 * same-scope parts merge (the prefix is omitted by the reader rules); tool
 * results merge into their originating call block; orphan results render
 * standalone.
 */
export function serializeConversation(messages: Message[], options?: SerializeOptions): string {
  const toolResultMaxChars = options?.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
  const toolArgMaxChars = options?.toolArgMaxChars ?? TOOL_ARG_MAX_CHARS;
  const toolCallMaxChars = options?.toolCallMaxChars ?? TOOL_CALL_MAX_CHARS;
  const headRatio = options?.truncateHeadRatio ?? TRUNCATE_HEAD_RATIO;
  const dimToolResults = options?.dimToolResults !== false;
  const includeThinking = options?.includeThinking !== false;
  const parts: string[] = [];
  let lastPrefix: string | null = null;

  const pushPart = (prefix: string, content: string) => {
    const lastIndex = parts.length - 1;
    if (lastIndex >= 0 && lastPrefix === prefix) {
      const sep = parts[lastIndex].endsWith("\n") || content.startsWith("\n") ? "" : "\n";
      parts[lastIndex] += sep + content;
    } else {
      parts.push(`${prefix} ${content}`);
      lastPrefix = prefix;
    }
  };

  // Surviving tool results are indexed by tool-call id so each merges into its
  // originating `¶call:` scope.
  const resultTextByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const { text, imageMarkers } = textOf(msg.content);
    const combined = imageMarkers.length > 0 ? (text ? `${text}\n` : "") + imageMarkers.join("\n") : text;
    if (combined) resultTextByCallId.set(msg.toolCallId, combined);
  }

  // Wrap a raw tool-result body in an `<out>` block, dimming only the body so
  // the frame coloring keeps scope markers and calls loud.
  const renderResultBlock = (rawText: string): string => {
    const body = truncateForSummary(elideDataUrls(stripDimMarkers(rawText)), toolResultMaxChars, headRatio);
    return `<out>\n${dimToolResults ? `${DIM_ON}${body}${DIM_OFF}` : body}\n</out>`;
  };

  const mergedCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      const { text, imageMarkers } = textOf(msg.content);
      const content = imageMarkers.length > 0 ? (text ? `${text}\n` : "") + imageMarkers.join("\n") : text;
      if (content) pushPart("¶user:", stripDimMarkers(content));
    } else if (msg.role === "assistant") {
      // Stream blocks in content order: buffer thinking/text, then flush a
      // separate section for each block type right before each tool call.
      let pendingThinking: string[] = [];
      let pendingText: string[] = [];
      const flushAssistant = () => {
        if (pendingThinking.length > 0) {
          pushPart("¶think:", pendingThinking.join("\n"));
        }
        if (pendingText.length > 0) {
          pushPart("¶ai:", pendingText.join("\n"));
        }
        pendingThinking = [];
        pendingText = [];
      };

      for (const block of msg.content) {
        if (block.type === "text") {
          const text = stripDimMarkers(block.text);
          if (text.trim()) pendingText.push(text);
        } else if (block.type === "thinking") {
          if (!includeThinking) continue;
          const thinking = stripDimMarkers(block.thinking);
          if (thinking.trim()) pendingThinking.push(thinking);
        } else if (block.type === "toolCall") {
          flushAssistant();
          const args = (block.arguments ?? {}) as Record<string, unknown>;
          const argsStr = truncateForSummary(
            Object.entries(args)
              .map(
                ([key, value]) =>
                  `${key}=${truncateForSummary(elideDataUrls(JSON.stringify(value) ?? "undefined"), toolArgMaxChars, headRatio)}`,
              )
              .join(", "),
            toolCallMaxChars,
            headRatio,
          );
          const lines: string[] = [`${block.name}(${argsStr})`];
          const resultText = resultTextByCallId.get(block.id);
          if (resultText !== undefined) {
            mergedCallIds.add(block.id);
            lines.push(renderResultBlock(resultText));
          }
          pushPart("¶call:", lines.join("\n"));
        }
      }
      flushAssistant();
    } else if (msg.role === "toolResult") {
      // Paired results already merged into their tool call block above; only
      // orphans (call archived outside this window) render standalone.
      if (mergedCallIds.has(msg.toolCallId)) continue;
      const resultText = resultTextByCallId.get(msg.toolCallId);
      if (resultText !== undefined) pushPart("¶call:", `\n${renderResultBlock(resultText)}`);
    }
  }

  return parts.join("\n\n");
}

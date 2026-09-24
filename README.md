# pi-snapcompact

Standalone [snapcompact](https://omp.sh) for **native Pi**. Replaces Pi's LLM-based context compaction with a deterministic, image-based archival system: when a session would compact, the discarded history is serialized and rendered into PNG frames of pixel-font text. Vision models read the frames back directly on every later context rebuild — no summarizer LLM call, no API key, no information loss to prose.

This is a self-contained port of `@oh-my-pi/snapcompact`'s engine. It has **no OMP dependencies and no bun requirement**: the native Rust PNG renderer is reimplemented in pure JS (`node:zlib` + the embedded X.Org 8x13 bitmap font, the same Base-14 font OMP's renderer uses), and everything else (serialization, normalization, foveated archive layout, budgets, data-URL healing) is ported verbatim.

## How it works

- **`session_before_compact`** — intercepts Pi's compaction. The archived window (summarize set + split-turn prefix) is serialized into the `¶user: / ¶think: / ¶ai: / ¶call:` transcript format, folded into the cumulative archive source text, and re-rendered into a foveated layout:

  - verbatim text at the oldest edge (one HQ frame's capacity),
  - imaged middle (HQ frames at the edges, a denser tier in the center when the middle overflows the frame budget; oldest overflow is dropped and counted),
  - verbatim text at the newest edge.

  The result is stored in the compaction entry's `details` bag (`details.snapcompact`) together with `readFiles`/`modifiedFiles`.
- **`context`** — on every LLM call, if the active context contains a snapcompacted summary, the archived blocks (text edges + frames, newest-first within the per-request byte budget) are re-attached right after the compaction summary as a hidden custom message (`display: false`), so the model sees the summary instructions followed by `HISTORY` content in the terminal transcript-free form.
- **`/snapcompact`** — prints archive status: frame count, base64 size, chars archived, chars truncated.

## Shape selection

Frame shape follows the eval-winning OMP defaults per provider/model line:

| Provider / model line | Variant | Frame size |
|---|---|---|
| Anthropic (Claude ≤ 4.6) | `11on16-bw` (8x13 on 11px advance) | 1568 px |
| Anthropic (Opus 4.7+, Fable/Mythos) | `11on16-bw` | 1932 px |
| Google (Gemini) | `8on22-bw` (8x13 on 22px pitch) | 2048 px |
| OpenAI (GPT/Codex) | `8on22-bw` | 1568 px |
| Kimi | `8on22-bw` | 1568 px |
| GLM | `8on16-bw` | 1568 px |
| Unknown providers | `8on22-bw` | 1568 px |

Per-frame token estimates and the per-request payload budget (3 MB of base64, oldest frames dropped first when exceeded) match OMP's conservative constants.

## Requirements & fallbacks

- The model must accept image input (`model.input` includes `"image"`). Non-vision models fall back to Pi's stock LLM compaction.
- Rendering failures or aborts fall back to stock compaction; the session is never left broken.
- Reasoning sections are excluded from the archive by default for Anthropic-dialect providers (replaying reasoning to Claude trips its reasoning-extraction classifier); set `PI_SNAPCOMPACT_THINKING=1` to archive them anyway.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PI_SNAPCOMPACT_VARIANT` | `auto` | Force a frame variant: `11on16-bw`, `8on16-bw`, `8on22-bw` |
| `PI_SNAPCOMPACT_MAX_FRAMES` | `80` | Upper bound on archive frames per compaction |
| `PI_SNAPCOMPACT_FRAME_BYTES` | `3000000` | Per-request base64 budget for rehydrated frames |
| `PI_SNAPCOMPACT_THINKING` | auto (`0` on Anthropic, `1` otherwise) | Archive `¶think:` sections |

## Known limitations vs OMP

- **No CJK glyph rendering.** OMP falls back to an embedded Silver TrueType font for CJK-heavy text; this port only carries the 8x13 bitmap font, so CJK runs fold to `?` in frames (the verbatim text edges and re-derivation from the workspace still work).
- Only `bw`-ink grid shapes ship (the eval defaults). `sent`-ink, two-column doc layouts, stopword dimming, and line-repeat redundancy are not rendered.
- The session JSONL file grows with the archive (frames are persisted inline in the compaction entry's `details`), unlike OMP's external blob store.
- Model-line detection is a lightweight id heuristic instead of OMP's catalog classifier.


/**
 * Pulling display text out of ACP `session/update` payloads.
 *
 * Pure and React-free so the role mapping is directly testable — the same
 * split as `pairingLink.ts`, and for the same reason: `bun test` cannot parse
 * React Native's Flow syntax.
 *
 * The role mapping is where a replayed conversation's shape is decided. GG
 * Coder replays user messages as `user_message_chunk`; leaving that unmapped
 * dropped every user turn, which let consecutive agent chunks coalesce into
 * one giant bubble — a resumed thread read as a single wall of agent text.
 *
 * A chunk carries images as well as text, because ACP content is not only text:
 * an agent that generates or reads a picture sends an `image` block, a
 * `resource_link`, or tool-call content. Text-only extraction is why those
 * arrived as nothing at all.
 */
import { dedupeImages, imagesFromContent, imagesFromToolCall, type ChatImage } from "./images";

export type ChunkRole = "user" | "agent" | "thought" | "system";

export interface Chunk {
  role: ChunkRole;
  text: string;
  /** Present only when the chunk actually carried pictures. */
  images?: ChatImage[];
}

/** True when a chunk has nothing to render — no text and no picture. */
export function isEmptyChunk(chunk: Chunk | undefined): boolean {
  return !chunk || (!chunk.text && !chunk.images?.length);
}

/** Concatenated text of a content field, which may be a block or an array. */
function readText(content: any): string {
  if (Array.isArray(content)) {
    return content.map((block) => (block?.type === "text" ? (block.text ?? "") : "")).join("");
  }
  return content?.text ?? "";
}

/** A chunk carrying text plus whatever images travelled with it. */
function withImages(role: ChunkRole, content: any): Chunk {
  const images = dedupeImages(imagesFromContent(content));
  return images.length > 0
    ? { role, text: readText(content), images }
    : { role, text: readText(content) };
}

const REPLAY_METADATA_PREFIX =
  /^\s*\[(?:Previous conversation summary|Previous compacted summar(?:y|ies)|Autopilot|Status update)\]/i;
const COMPACTION_ACK =
  "I have the full context from the summary above, including where work left off and the next step.";

/**
 * ACP has no provenance field on rendered chunks. Agents that do not filter
 * their own stored history can therefore expose runtime bookkeeping as if the
 * user wrote it; keep the app clean using only reserved, unambiguous markers.
 */
function isReplayMetadata(text: string): boolean {
  const normalized = text.trim();
  return REPLAY_METADATA_PREFIX.test(normalized) || normalized === COMPACTION_ACK;
}

export function readChunk(payload: any): Chunk | undefined {
  const update = payload?.update;
  if (update?.sessionUpdate === "agent_message_chunk") {
    const chunk = withImages("agent", update.content);
    return isReplayMetadata(chunk.text) ? undefined : chunk;
  }
  if (update?.sessionUpdate === "agent_thought_chunk") {
    return withImages("thought", update.content);
  }
  if (update?.sessionUpdate === "user_message_chunk") {
    // Live prompts arrive as `kind: "user_message"` (below); replay chunks may
    // also contain agent bookkeeping from providers without visibility metadata.
    const chunk = withImages("user", update.content);
    return isReplayMetadata(chunk.text) ? undefined : chunk;
  }
  if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
    // Tool calls are otherwise not rendered — but an image generation tool's
    // result *is* the answer, and it arrives nowhere else. Text is deliberately
    // left out, so a tool that produced no picture yields nothing.
    const images = dedupeImages(imagesFromToolCall(update));
    return images.length > 0 ? { role: "agent", text: "", images } : undefined;
  }
  if (payload?.kind === "user_message") {
    return { role: "user", text: payload.text ?? "" };
  }
  if (payload?.kind === "exit") {
    // Closing a session kills the child, so a clean or signalled exit is the
    // normal end of a conversation. Reporting it in red said "something broke"
    // every time the user simply finished. Only a non-zero code is a failure.
    if (typeof payload.code !== "number" || payload.code === 0) return undefined;
    return { role: "system", text: `The agent stopped unexpectedly (code ${payload.code})` };
  }
  return undefined;
}

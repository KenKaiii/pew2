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
 */

export type ChunkRole = "user" | "agent" | "thought" | "system";

export interface Chunk {
  role: ChunkRole;
  text: string;
}

export function readChunk(payload: any): Chunk | undefined {
  const update = payload?.update;
  if (update?.sessionUpdate === "agent_message_chunk") {
    return { role: "agent", text: update.content?.text ?? "" };
  }
  if (update?.sessionUpdate === "agent_thought_chunk") {
    return { role: "thought", text: update.content?.text ?? "" };
  }
  if (update?.sessionUpdate === "user_message_chunk") {
    // Live prompts arrive as `kind: "user_message"` (below); replays arrive as
    // this update type. Both are the user's own words.
    return { role: "user", text: update.content?.text ?? "" };
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

/** GG Coder useSmoothText.ts pacing, adapted to native with grapheme-safe cuts.
 * Completion/reset rules also follow assistant-ui useSmooth.ts at
 * 14fc93895e3e0c67f84b2722fa2b1180b0341cb3. See ../THIRD_PARTY_NOTICES.md.
 * Presentation only: never changes authoritative agent working state.
 */
import { graphemeSegments } from "unicode-segmenter/grapheme";

export const DRAIN_MS = 250;
export const MAX_CHAR_INTERVAL_MS = 5;
export const COMMIT_MS = 33;
export const SETTLE_MS = 700;

export interface LiveStreamIdentity { sessionId: string; turnKey: string; generation: number }
export function streamIdentityKey(identity: LiveStreamIdentity): string {
  return JSON.stringify([identity.sessionId, identity.turnKey, identity.generation]);
}
export function advance(shown: number, target: number, dt: number): number {
  const remaining = target - Math.floor(shown);
  if (remaining <= 0) return target;
  return Math.min(target, shown + Math.max(0, dt) / Math.min(MAX_CHAR_INTERVAL_MS, DRAIN_MS / remaining));
}

// Hermes lacks Intl.Segmenter. Use the explicitly approved, pinned iterator
// without patching global Intl; native and pure tests now exercise the same code.
export function safePrefixLength(text: string, requested: number): number {
  if (requested >= text.length) return text.length;
  let end = 0;
  for (const part of graphemeSegments(text)) {
    const next = part.index + part.segment.length;
    if (next > requested) break;
    end = next;
  }
  return end;
}
export interface Reveal {
  identity: string;
  target: string;
  shown: number;
  committed: number;
  tickAt: number;
  commitAt: number;
  growthAt: number;
}
export function resetReveal(identity: string, text: string, now: number): Reveal {
  return { identity, target: text, shown: text.length, committed: text.length, tickAt: now, commitAt: now, growthAt: now - SETTLE_MS };
}
export function updateReveal(previous: Reveal, identity: string, text: string, now: number, enabled: boolean): Reveal {
  if (!enabled || identity !== previous.identity || !text.startsWith(previous.target)) return resetReveal(identity, text, now);
  if (text === previous.target) return previous;
  return { ...previous, target: text, growthAt: now, tickAt: previous.shown >= previous.target.length ? now : previous.tickAt };
}
export function tickReveal(previous: Reveal, now: number): Reveal {
  const shown = advance(previous.shown, previous.target.length, now - previous.tickAt);
  const final = shown >= previous.target.length;
  const committed = final || now - previous.commitAt >= COMMIT_MS
    ? safePrefixLength(previous.target, Math.floor(shown)) : previous.committed;
  return { ...previous, shown, committed, tickAt: now, commitAt: committed !== previous.committed ? now : previous.commitAt };
}
export function revealSettled(state: Reveal, now: number): boolean {
  return state.committed === state.target.length && now - state.growthAt >= SETTLE_MS;
}

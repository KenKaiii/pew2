/**
 * What the empty state says above the composer.
 *
 * One fixed line is the thing you stop reading by the third day, and this screen
 * is the app's front door — it is on show every time a conversation is started.
 * A rotation keeps it alive without turning it into a gimmick, so the rules are
 * tight: every line is a real prompt to act, none is a joke, and none pretends
 * the agent has a personality or a mood it does not have.
 *
 * They are also all short. The line sits under the orb on a phone, where two
 * rows of text pushes the composer down and reads as a paragraph rather than an
 * invitation.
 */

/**
 * Lines that name the agent. `{name}` is substituted.
 *
 * Kept separate from the unnamed ones because the name is the more useful
 * variant — it tells you which agent you are about to talk to, which is real
 * information on a machine with a dozen of them installed — so it is used
 * whenever an agent is known.
 */
const NAMED = [
  "What would you like {name} to do?",
  "What should {name} work on?",
  "Where should {name} start?",
  "What's {name} building today?",
  "Give {name} something to do.",
  "What are we asking {name} for?",
  "Point {name} at something.",
  "{name} is listening.",
  "{name} is ready when you are.",
  "Tell {name} what you need.",
  "What's the task for {name}?",
  "Hand {name} the first move.",
] as const;

/**
 * Lines for when no agent is named yet.
 *
 * Rare — it takes a machine with a provider configured but not yet chosen — but
 * the screen still has to say something, and reusing a named line with a
 * placeholder in it is worse than a general one.
 */
const UNNAMED = [
  "What would you like to do?",
  "What are we working on?",
  "Where would you like to start?",
  "What's first?",
] as const;

/** Every line, for tests that assert properties of the whole set. */
export const GREETINGS = { named: NAMED, unnamed: UNNAMED } as const;

/**
 * A stable number from a string, for choosing a line.
 *
 * FNV-1a: the ids this is fed differ by a character or two (`new`, a session
 * uuid, a provider name), and a sum of char codes would map many of those to
 * the same line — so consecutive conversations would keep repeating a greeting
 * while never showing others at all.
 */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash);
}

/**
 * Pick a greeting.
 *
 * `seed` chooses which line, deterministically: the caller holds it steady for
 * as long as one empty state is on screen, so the words cannot change under a
 * reader mid-sentence — which is what would happen if this were called fresh on
 * every render, and a re-render happens on every keystroke in the composer.
 */
export function greetingFor(name: string | undefined, seed: number): string {
  if (!name) {
    return UNNAMED[Math.abs(Math.trunc(seed)) % UNNAMED.length]!;
  }
  const line = NAMED[Math.abs(Math.trunc(seed)) % NAMED.length]!;
  return line.replace("{name}", name);
}

/**
 * Merging dictated speech into a draft that may already have text in it.
 *
 * The rule that makes or breaks this: a recogniser emits *interim* results, and
 * each one is a revised transcript of the whole utterance so far, not the next
 * few words. Appending them produces "hello hello there hello there world".
 * So a dictation session remembers where it started and what it last wrote, and
 * every result replaces that tail.
 *
 * Kept away from the Expo module (`ui/speech.ts`) so the rule is testable —
 * `bun test` cannot parse React Native's Flow syntax, and this is the part with
 * behaviour worth pinning down.
 */

/**
 * What a dictation session needs to remember between results.
 *
 * Only the starting draft: every result rebuilds from it, which is *how* the
 * dictated tail is replaced rather than appended. Keeping the last transcript
 * too would be a second copy of something already implied.
 */
export interface DictationState {
  /** The draft as it stood when the mic was tapped. */
  base: string;
}

export function beginDictation(draft: string): DictationState {
  return { base: draft };
}

/**
 * The draft after this transcript, and the state to carry forward.
 *
 * Dictating onto existing text inserts a space, because someone who typed
 * "fix the" and then said "login bug" means two words, not one. A draft that
 * already ends in whitespace, or an opening bracket, is left as written.
 */
export function applyTranscript(
  state: DictationState,
  transcript: string,
): { draft: string; state: DictationState } {
  const spoken = transcript.trim();
  const base = state.base;
  if (!spoken) return { draft: base, state };

  const joiner = base.length === 0 || /[\s([{"'`]$/.test(base) ? "" : " ";
  return { draft: base + joiner + spoken, state };
}

/**
 * The draft to keep when dictation is cancelled rather than finished.
 *
 * Interim results are guesses; abandoning a recording should leave what was
 * typed before it, not a half-heard sentence the user never approved.
 */
export function cancelDictation(state: DictationState): string {
  return state.base;
}

/**
 * What to tell the user when recognition fails.
 *
 * The codes follow the Web Speech API, which both native backends are mapped
 * onto. Anything unrecognised gets the generic line rather than a raw code:
 * "error: audio-capture" in a composer helps nobody.
 */
export function dictationMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone or speech access is off for pew2. Turn it on in Settings to dictate.";
    case "no-speech":
      return "Didn't catch that.";
    case "audio-capture":
      return "No microphone available.";
    case "network":
      return "Speech recognition needs a connection right now.";
    case "language-not-supported":
      return "That language isn't available for dictation on this device.";
    case "busy":
      return "Speech recognition is busy. Try again in a moment.";
    // "aborted" is what a deliberate stop reports; it is not a failure and must
    // not put a message on screen.
    case "aborted":
      return "";
    default:
      return "Dictation stopped unexpectedly.";
  }
}

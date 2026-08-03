import { describe, expect, test } from "bun:test";
import {
  applyTranscript,
  beginDictation,
  cancelDictation,
  dictationMessage,
} from "./transcription";

describe("applyTranscript", () => {
  test("interim results replace rather than accumulate", () => {
    // The bug this rule exists for: each interim result restates the whole
    // utterance, so appending yields "hello hello there hello there world".
    let state = beginDictation("");
    let draft = "";
    for (const interim of ["hello", "hello there", "hello there world"]) {
      ({ draft, state } = applyTranscript(state, interim));
    }
    expect(draft).toBe("hello there world");
  });

  test("dictation appends to text already typed", () => {
    const { draft } = applyTranscript(beginDictation("fix the"), "login bug");
    expect(draft).toBe("fix the login bug");
  });

  test("existing trailing whitespace is not doubled", () => {
    expect(applyTranscript(beginDictation("fix the "), "login bug").draft).toBe("fix the login bug");
    expect(applyTranscript(beginDictation("run ("), "again").draft).toBe("run (again");
  });

  test("a revision after typed text still replaces only the dictated tail", () => {
    let state = beginDictation("note:");
    let draft = "";
    ({ draft, state } = applyTranscript(state, "check"));
    expect(draft).toBe("note: check");
    ({ draft, state } = applyTranscript(state, "check the logs"));
    expect(draft).toBe("note: check the logs");
  });

  test("an empty transcript leaves the original draft", () => {
    expect(applyTranscript(beginDictation("keep me"), "   ").draft).toBe("keep me");
  });
});

describe("cancelDictation", () => {
  test("restores what was typed before the mic was tapped", () => {
    let state = beginDictation("typed");
    ({ state } = applyTranscript(state, "half heard guess"));
    // Interim results are guesses; abandoning must not commit one.
    expect(cancelDictation(state)).toBe("typed");
  });
});

describe("dictationMessage", () => {
  test("permission failures point at Settings", () => {
    expect(dictationMessage("not-allowed")).toMatch(/Settings/);
    expect(dictationMessage("service-not-allowed")).toMatch(/Settings/);
  });

  test("a deliberate stop is silent", () => {
    // "aborted" is what stopping on purpose reports; a message would accuse the
    // user of an error they did not make.
    expect(dictationMessage("aborted")).toBe("");
  });

  test("an unknown code never leaks the code itself", () => {
    const message = dictationMessage("some-new-code");
    expect(message).not.toContain("some-new-code");
    expect(message.length).toBeGreaterThan(0);
  });
});

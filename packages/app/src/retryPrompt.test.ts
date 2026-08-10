import { expect, test } from "bun:test";
import { retryTarget } from "./retryPrompt";
import type { Turn } from "./useDaemon";

function turn(role: Turn["role"], text: string, key?: string): Turn {
  return { id: `${role}-${text}`, role, text, ...(key ? { key } : {}) };
}

test("a failure at the end offers the prompt above it", () => {
  const target = retryTarget([
    turn("user", "list the files"),
    turn("system", "Agent exited with code 1"),
  ]);
  expect(target?.prompt).toBe("list the files");
});

test("it reaches past the half-answer the agent managed before failing", () => {
  const target = retryTarget([
    turn("user", "refactor the parser"),
    turn("thought", "Looking at the tokeniser..."),
    turn("agent", "I'll start by"),
    turn("system", "Request failed: context length exceeded"),
  ]);
  expect(target?.prompt).toBe("refactor the parser");
});

test("only the end of the thread is retryable", () => {
  // The conversation moved past this failure: re-running that prompt now would
  // run it against a context it never saw.
  const target = retryTarget([
    turn("user", "list the files"),
    turn("system", "Agent exited with code 1"),
    turn("user", "try again please"),
    turn("agent", "Here they are."),
  ]);
  expect(target).toBeUndefined();
});

test("two failures in a row do not reach past each other", () => {
  const target = retryTarget([
    turn("user", "list the files"),
    turn("system", "Agent exited with code 1"),
    turn("system", "Stopped before the agent received this."),
  ]);
  expect(target).toBeUndefined();
});

test("a failure with nothing above it is not a retry", () => {
  // `stalledLoading`: a conversation that never arrived. Reopening it is the
  // recovery, and its own text says so.
  expect(retryTarget([turn("system", "Couldn't load this conversation.")])).toBeUndefined();
});

test("an image-only prompt has no text to send again", () => {
  const target = retryTarget([
    turn("user", "   "),
    turn("system", "Agent exited with code 1"),
  ]);
  expect(target).toBeUndefined();
});

test("the target is keyed the way the list keys its cells", () => {
  // An optimistic turn's `id` is replaced when the daemon echoes it back, so
  // the control has to be pinned to the same key the transcript renders by.
  const failure: Turn = { id: "err-1", key: "local:4", role: "system", text: "Failed" };
  const target = retryTarget([turn("user", "hello"), failure]);
  expect(target?.key).toBe("local:4");

  const unkeyed = retryTarget([turn("user", "hello"), turn("system", "Failed")]);
  expect(unkeyed?.key).toBe("system-Failed");
});

test("an ordinary conversation offers nothing", () => {
  expect(retryTarget([turn("user", "hi"), turn("agent", "hello")])).toBeUndefined();
  expect(retryTarget([])).toBeUndefined();
});

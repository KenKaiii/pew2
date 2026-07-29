import { expect, test } from "bun:test";
import { readChunk } from "./chunks";

test("replayed user messages map to user turns", () => {
  // Exactly what GG Coder sends during session/load. Unmapped, these were
  // dropped and the agent's chunks merged into one bubble.
  const chunk = readChunk({
    sessionId: "abc",
    update: { content: { text: "Hi there", type: "text" }, sessionUpdate: "user_message_chunk" },
  });
  expect(chunk).toEqual({ role: "user", text: "Hi there" });
});

test("agent text and thought chunks keep their roles", () => {
  expect(
    readChunk({ update: { sessionUpdate: "agent_message_chunk", content: { text: "Sure" } } }),
  ).toEqual({ role: "agent", text: "Sure" });
  expect(
    readChunk({ update: { sessionUpdate: "agent_thought_chunk", content: { text: "Hmm" } } }),
  ).toEqual({ role: "thought", text: "Hmm" });
});

test("a live prompt echo still maps to a user turn", () => {
  expect(readChunk({ kind: "user_message", text: "Run it" })).toEqual({
    role: "user",
    text: "Run it",
  });
});

test("a clean exit is silent, a crash is a system line", () => {
  expect(readChunk({ kind: "exit", code: null })).toBeUndefined();
  expect(readChunk({ kind: "exit", code: 0 })).toBeUndefined();
  expect(readChunk({ kind: "exit", code: 1 })).toEqual({
    role: "system",
    text: "The agent stopped unexpectedly (code 1)",
  });
});

test("unknown payloads produce nothing", () => {
  expect(readChunk({ update: { sessionUpdate: "tool_call", title: "bash" } })).toBeUndefined();
  expect(readChunk(undefined)).toBeUndefined();
});

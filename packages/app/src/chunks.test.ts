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

test("runtime bookkeeping markers are omitted from ACP replay", () => {
  const replayed = (sessionUpdate: string, text: string) =>
    readChunk({ update: { sessionUpdate, content: { type: "text", text } } });

  expect(
    replayed(
      "user_message_chunk",
      "[Previous compacted summaries]\nA very large generated summary",
    ),
  ).toBeUndefined();
  expect(
    replayed("user_message_chunk", " [Previous conversation summary]\nGenerated context"),
  ).toBeUndefined();
  expect(replayed("user_message_chunk", "[Autopilot] Continue with the next task")).toBeUndefined();
  expect(replayed("user_message_chunk", "[Status update] Dev server is still running")).toBeUndefined();
  expect(
    replayed(
      "agent_message_chunk",
      "I have the full context from the summary above, including where work left off and the next step.",
    ),
  ).toBeUndefined();
});

test("ordinary messages and live prompt echoes are never mistaken for replay metadata", () => {
  expect(
    readChunk({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "The log mentioned [Status update], but this answer is useful." },
      },
    }),
  ).toEqual({
    role: "agent",
    text: "The log mentioned [Status update], but this answer is useful.",
  });
  expect(readChunk({ kind: "user_message", text: "[Status update] explain this marker" })).toEqual({
    role: "user",
    text: "[Status update] explain this marker",
  });
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

test("an image generation tool's result reaches the transcript", () => {
  // Tool calls are otherwise not rendered, and this picture arrives nowhere
  // else — the reason a generated image showed up as nothing at all.
  const chunk = readChunk({
    update: {
      sessionUpdate: "tool_call_update",
      content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: "AA" } }],
    },
  });
  expect(chunk).toEqual({
    role: "agent",
    text: "",
    images: [{ src: "data:image/png;base64,AA", mimeType: "image/png" }],
  });
});

test("a tool call with no picture stays out of the conversation", () => {
  expect(
    readChunk({
      update: {
        sessionUpdate: "tool_call",
        content: [{ type: "content", content: { type: "text", text: "ran tests" } }],
      },
    }),
  ).toBeUndefined();
});

test("images travel with message text rather than replacing it", () => {
  expect(
    readChunk({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [
          { type: "text", text: "Here it is:" },
          { type: "resource_link", uri: "out/chart.png" },
        ],
      },
    }),
  ).toEqual({
    role: "agent",
    text: "Here it is:",
    images: [{ src: "out/chart.png", mimeType: undefined, alt: undefined }],
  });
});

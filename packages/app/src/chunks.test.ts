import { expect, test } from "bun:test";
import { isEmptyTurn, readChunk } from "./chunks";
import { applyChunk } from "./replayFold";
import type { Turn } from "./useDaemon";

test("thread visibility preserves image-only rows and drops true placeholders", () => {
  expect(isEmptyTurn({ role: "agent", text: "", images: [{ src: "plot.png" }] })).toBe(false);
  expect(isEmptyTurn({ role: "user", text: " ", images: [{ src: "photo.png" }] })).toBe(false);
  expect(isEmptyTurn({ role: "agent", text: " \n", images: [] })).toBe(true);
});

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

test.each([
  ["screenshot", { type: "image", mimeType: "image/png", data: "AA" }, "data:image/png;base64,AA"],
  ["generated image", { type: "resource_link", uri: ".gg/generated/result.png" }, ".gg/generated/result.png"],
  ["image read", { type: "resource", resource: { uri: "file:///tmp/shot.jpg" } }, "file:///tmp/shot.jpg"],
] as const)("%s tool results survive folding and row visibility without Markdown", (_name, content, src) => {
  const turns: Turn[] = [];
  for (const [index, sessionUpdate] of ["tool_call", "tool_call_update"].entries()) {
    const chunk = readChunk({ update: {
      sessionUpdate,
      content: [{ type: "content", content }],
    } });
    expect(chunk).toBeDefined();
    applyChunk(turns, `session:${index + 1}`, chunk!);
  }
  expect(turns).toHaveLength(1);
  expect(turns[0]!.text).toBe("");
  expect(turns[0]!.images).toHaveLength(1);
  expect(turns[0]!.images![0]!.src).toBe(src);
  expect(isEmptyTurn(turns[0]!)).toBe(false);
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

test("a user message carries the files that were attached to it", () => {
  // The daemon echoes the paths it wrote on *its* disk, so a second device —
  // and this one after a reconnect — can render what was sent. No `origin`:
  // these are fetched over the socket like any other agent image.
  const chunk = readChunk({
    kind: "user_message",
    text: "look at this",
    attachments: [
      { name: "shot.png", mimeType: "image/png", uri: "/tmp/pew2-attachments/s1/0-shot.png" },
      { name: "notes.txt", mimeType: "text/plain", uri: "/tmp/pew2-attachments/s1/1-notes.txt" },
    ],
  });

  expect(chunk).toEqual({
    role: "user",
    text: "look at this",
    // Only the picture: a text file is not something to paint into the thread.
    images: [
      {
        src: "/tmp/pew2-attachments/s1/0-shot.png",
        mimeType: "image/png",
        alt: "shot.png",
      },
    ],
  });
});

test("a user message with no attachments has no images key", () => {
  expect(readChunk({ kind: "user_message", text: "plain", attachments: [] })).toEqual({
    role: "user",
    text: "plain",
  });
});

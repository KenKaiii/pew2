import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGgCoderDisplayHistory } from "./ggcoder-history";
import { readChunk } from "../../../app/src/chunks";
import { loadClaudeDisplayHistory } from "./claude-history";
import { Daemon } from "../index";
import { writeTranscript } from "../transcript-cache";
import { historyImages } from "../images";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("a previous replay cache cannot hide newer messages when reopening", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-cached-replay-"));
  roots.push(root);
  const previousHome = process.env.PEW2_HOME;
  process.env.PEW2_HOME = root;
  const daemon = new Daemon({ id: "test", name: "test" }, true);
  try {
    await writeTranscript("echo", "echo_history_1", [
      { sessionId: "echo_history_1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First question" } } },
    ]);
    await daemon.refreshProviders();
    const id = await daemon.resumeSession("echo", "echo_history_1", process.cwd());
    const sent: any[] = [];
    daemon.attach(message => sent.push(message));
    daemon.markLive(id);
    const chunks = sent.flatMap(message => message.events ?? []).map(event => readChunk(event.payload));
    expect(chunks.filter(Boolean).map(chunk => chunk!.text)).toEqual([
      "First question", "First answer", "Second question", "Second answer", "Third question", "Third answer",
    ]);
  } finally {
    daemon.closeAll();
    if (previousHome === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = previousHome;
  }
}, 20_000);

test("stored image references remain displayable without fetching them during restore", () => {
  const images = historyImages([
    { type: "resource_link", uri: "out/screenshot.png", name: "Screenshot", mimeType: "image/png" },
    { type: "image_url", image_url: { url: "https://example.test/screenshot.png" } },
  ]);
  const chunk = readChunk({ update: { sessionUpdate: "agent_message_chunk", content: images } });
  expect(chunk?.images?.map(image => image.src)).toEqual([
    "out/screenshot.png", "https://example.test/screenshot.png",
  ]);
});

test("reopening GG Coder history retains a screenshot returned by a tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-history-replay-"));
  roots.push(root);
  const cwd = "/project";
  await mkdir(path.join(root, "project"));
  const sessionId = "abcdefgh-1234";
  const image = { type: "image", mimeType: "image/png", data: "c2NyZWVuc2hvdA==" };
  const entries = [
    { type: "session", id: sessionId, cwd, leafId: "tool" },
    { type: "message", id: "user", parentId: null, message: { role: "user", content: "Take a screenshot" } },
    { type: "message", id: "tool", parentId: "user", message: { role: "tool", content: [
      { type: "tool_result", toolCallId: "shot", content: [{ type: "text", text: "internal tool output" }, image] },
    ] } },
  ];
  await writeFile(path.join(root, "project", "fixture_abcdefgh.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n"));
  const updates = await loadGgCoderDisplayHistory(sessionId, cwd, root);
  const replayed = updates?.map(update => readChunk({ update })).filter(Boolean);
  const live = readChunk({ update: { sessionUpdate: "tool_call_update", content: [{ type: "content", content: image }] } });
  expect(live?.images).toHaveLength(1);
  expect(replayed?.flatMap(chunk => chunk?.images ?? [])).toEqual(live!.images!);
  expect(replayed?.some(chunk => chunk?.text.includes("internal tool output"))).toBe(false);
});

test("Claude tool-result screenshots return as agent images, not user prompts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-claude-replay-"));
  roots.push(root);
  await mkdir(path.join(root, "-project"));
  await writeFile(path.join(root, "-project", "session.jsonl"), JSON.stringify({
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shot", content: [
      { type: "text", text: "internal tool output" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "c2NyZWVuc2hvdA==" } },
    ] }] },
  }));
  expect(await loadClaudeDisplayHistory("session", "/project", root)).toEqual([
    { role: "assistant", text: "", images: [{ type: "image", mimeType: "image/png", data: "c2NyZWVuc2hvdA==" }] },
  ]);
});

test("GG Coder restore keeps thought text separate from the answer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-thought-replay-"));
  roots.push(root);
  await mkdir(path.join(root, "project"));
  await writeFile(path.join(root, "project", "fixture_abcdefgh.jsonl"), [
    { type: "session", id: "abcdefgh-1234", leafId: "answer" },
    { type: "message", id: "answer", parentId: null, message: { role: "assistant", content: [
      { type: "thinking", thinking: "I should inspect the screenshot." },
      { type: "text", text: "The button is visible." },
    ] } },
  ].map(entry => JSON.stringify(entry)).join("\n"));
  const updates = await loadGgCoderDisplayHistory("abcdefgh-1234", "/project", root);
  expect(updates?.map(update => readChunk({ update }))).toEqual([
    { role: "thought", text: "I should inspect the screenshot." },
    { role: "agent", text: "The button is visible." },
  ]);
});

test("Claude restore retains visible thoughts but not redacted thinking or metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-claude-thought-"));
  roots.push(root);
  await mkdir(path.join(root, "-project"));
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "Check the screenshot", signature: "not-display-content" },
    { type: "redacted_thinking", data: "must-not-display" },
    { type: "text", text: "Answer" },
  ] };
  await writeFile(path.join(root, "-project", "session.jsonl"), [
    { isMeta: true, message }, { isSidechain: true, message }, { message },
  ].map(entry => JSON.stringify(entry)).join("\n"));
  expect(await loadClaudeDisplayHistory("session", "/project", root)).toEqual([
    { role: "thought", text: "Check the screenshot", images: [] },
    { role: "assistant", text: "Answer", images: [] },
  ]);
});
